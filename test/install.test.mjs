import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../installer/install.mjs';
import { PackError } from '../installer/lib/errors.mjs';
import { buildFeeds, newKeys, sandboxHosts, startMock, tmpDir, walk, writeConfig } from './helpers.mjs';

const GOOD = 'ghp_goodkey_00000000000000000000';
const UI_ONLY = 'ghp_uionly_00000000000000000000';
const TARGET = 'linux-x64';

const keys = newKeys();
let mock;
let cfg;

async function install(extra = [], { token = GOOD, feeds = buildFeeds({ privateKey: keys.privateKey, target: TARGET }), pubkey = cfg.pubkey, answers = [], env, secrets, askDir = false, deps = {}, tokens = { [GOOD]: ['example/ui', 'example/engine'], [UI_ONLY]: ['example/ui'] } } = {}) {
  const dir = tmpDir();
  const secretsLeft = secrets ? [...secrets] : undefined;
  mock?.close && (await mock.close());
  mock = await startMock({ tokens, repos: feeds });
  const lines = [];
  const asked = answers.map((a) => (a === '@DIR' ? dir : a));
  const dirArgs = askDir ? [] : ['--dir', dir];
  const code = await run([...dirArgs, '--api', mock.base, '--target', TARGET, '--products', cfg.products, '--pubkey', pubkey, ...(secretsLeft ? [] : ['--token-env', 'PACK_KEY']), ...extra], {
    hostCtx: sandboxHosts(),
    ...deps,
    env: env ?? { PACK_KEY: token },
    out: (l) => lines.push(l),
    askFn: async (q) => {
      lines.push(q);
      return asked.shift() ?? '';
    },
    askSecret: async (q) => {
      if (!secretsLeft) throw new Error('the key must come from the environment in these tests');
      lines.push(q);
      return secretsLeft.shift() ?? '';
    },
  }).catch((e) => {
    if (e instanceof PackError) {
      lines.push(e.message);
      return 1;
    }
    throw e;
  });
  return { dir, lines, text: lines.join('\n'), code };
}

before(() => {
  cfg = writeConfig(tmpDir(), keys.pubB64);
});
after(async () => {
  await mock?.close();
});

describe('installing both products', () => {
  it('installs the UI and the engine, joins them, and reports nothing but where things are', async () => {
    const r = await install(['--product', 'both']);
    assert.equal(r.code, 0, r.text);
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0', 'app', 'server.mjs')));
    assert.ok(fs.existsSync(path.join(r.dir, 'engine', '2.0.0', 'echlon-engine-linux-x64')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'ui', 'current.json'), 'utf8')), { version: '1.0.0', file: 'echlon-ui-1.0.0.zip' });
    assert.match(r.text, /Installed Echlon UI 1\.0\.0/);
    assert.match(r.text, /Installed Echlon Engine 2\.0\.0/);
    assert.match(r.text, /The UI is set up to use the engine/);
  });

  it('gives the engine a token made here and tells the UI about it, so the customer never types one', async () => {
    const r = await install(['--product', 'both']);
    const settings = JSON.parse(fs.readFileSync(path.join(r.dir, 'ui', 'data', 'echlon.settings.json'), 'utf8'));
    const conn = settings.connections.find((c) => c.vendor === 'echlon-engine');
    assert.equal(conn.label, 'Echlon Engine');
    assert.equal(conn.active, true);
    assert.equal(conn.config.baseUrl, 'http://127.0.0.1:3737');
    assert.match(conn.secrets.apiKey, /^[0-9a-f]{48}$/);
    const launcher = fs.readFileSync(path.join(r.dir, process.platform === 'win32' ? 'start-engine.cmd' : 'start-engine.sh'), 'utf8');
    assert.ok(launcher.includes(conn.secrets.apiKey), 'the engine starts with the same token the UI holds');
    assert.ok(!r.text.includes(conn.secrets.apiKey), 'the engine token is never printed');
  });

  it('never prints, stores or logs the access key', async () => {
    const r = await install(['--product', 'both']);
    assert.ok(!r.text.includes(GOOD));
    for (const file of walk(r.dir)) assert.ok(!fs.readFileSync(file).includes(GOOD), `${file} holds the access key`);
  });

  it('sends the key to the feed and not to the storage host the download redirects to', async () => {
    await install(['--product', 'both']);
    assert.ok(mock.log.api.length > 0 && mock.log.api.every((e) => e.authorization === `Bearer ${GOOD}`));
    assert.ok(mock.log.storage.length > 0, 'the artifacts came from the storage host');
    assert.ok(mock.log.storage.every((e) => e.authorization === undefined), 'the key did not follow the redirect');
  });

  it('keeps the previous version when a newer one is installed, and points current at the new one', async () => {
    const first = await install(['--product', 'engine']);
    const feeds = buildFeeds({ privateKey: keys.privateKey, target: TARGET, engineVersion: '2.1.0' });
    mock.close && (await mock.close());
    mock = await startMock({ tokens: { [GOOD]: ['example/ui', 'example/engine'] }, repos: feeds });
    const code = await run(['--dir', first.dir, '--api', mock.base, '--target', TARGET, '--products', cfg.products, '--pubkey', cfg.pubkey, '--token-env', 'PACK_KEY', '--product', 'engine'], {
      env: { PACK_KEY: GOOD },
      out: () => {},
    });
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(first.dir, 'engine', '2.0.0')));
    assert.ok(fs.existsSync(path.join(first.dir, 'engine', '2.1.0')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, 'engine', 'current.json'), 'utf8')).version, '2.1.0');
  });
});

describe('one product', () => {
  it('installs only the UI and leaves it standalone, with no engine connection', async () => {
    const r = await install(['--product', 'ui']);
    assert.equal(r.code, 0, r.text);
    assert.ok(!fs.existsSync(path.join(r.dir, 'engine')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', 'data', 'echlon.settings.json')));
    assert.ok(!/set up to use the engine/.test(r.text));
  });

  it('installs only the engine, with a token of its own for whoever runs it', async () => {
    const r = await install(['--product', 'engine']);
    assert.equal(r.code, 0, r.text);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui')));
    assert.ok(fs.existsSync(path.join(r.dir, process.platform === 'win32' ? 'start-engine.cmd' : 'start-engine.sh')));
  });
});

describe('a key that does not include everything', () => {
  it('installs what it may, says plainly what it may not, and exits non-zero', async () => {
    const r = await install(['--product', 'both'], { token: UI_ONLY });
    assert.equal(r.code, 1);
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'engine')));
    assert.match(r.text, /Not installed - Echlon Engine: This key does not include Echlon Engine, or no release of it has been published yet\./);
    const settings = path.join(r.dir, 'ui', 'data', 'echlon.settings.json');
    assert.ok(!fs.existsSync(settings), 'no engine connection is written for an engine that is not there');
  });

  it('refuses a key GitHub does not accept, and changes nothing', async () => {
    const r = await install(['--product', 'both'], { token: 'ghp_wrong' });
    assert.equal(r.code, 1);
    assert.match(r.text, /The access key was not accepted/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui')));
  });

  it('says so when no build exists for this computer', async () => {
    const r = await install(['--product', 'engine', '--target', 'darwin-arm64']);
    assert.equal(r.code, 1);
    assert.match(r.text, /No build of Echlon Engine for this computer \(darwin-arm64\)/);
  });
});

describe('a download that cannot be trusted', () => {
  it('refuses an artifact that is not the one that was signed, and installs nothing', async () => {
    const r = await install(['--product', 'both'], { feeds: buildFeeds({ privateKey: keys.privateKey, target: TARGET, tamper: { ui: true, engine: true } }) });
    assert.equal(r.code, 1);
    assert.match(r.text, /does not match what was signed/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'engine', '2.0.0')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', 'current.json')));
  });

  it('refuses a release signed by anyone but us', async () => {
    const r = await install(['--product', 'ui'], { feeds: buildFeeds({ privateKey: keys.privateKey, target: TARGET, tamper: { badSignature: true } }) });
    assert.equal(r.code, 1);
    assert.match(r.text, /signature does not match/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui')));
  });

  it('refuses to run at all when the pack carries no release key', async () => {
    const empty = path.join(tmpDir(), 'release-pubkey.txt');
    fs.writeFileSync(empty, 'REPLACE_WITH_RELEASE_PUBKEY\n');
    const r = await install(['--product', 'ui'], { pubkey: empty });
    assert.equal(r.code, 1);
    assert.match(r.text, /no release key in it yet/);
  });

  it('refuses an archive that would write outside the install folder, before writing anything', async () => {
    const evil = { 'echlon-pack.json': '{}', '../outside.txt': 'x', 'ok.txt': 'y' };
    const r = await install(['--product', 'ui'], { feeds: buildFeeds({ privateKey: keys.privateKey, target: TARGET, uiFiles: evil }) });
    assert.equal(r.code, 1);
    assert.match(r.text, /unsafe path/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'outside.txt')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
  });
});

describe('the menu', () => {
  it('offers UI, engine, both and quit, and takes a number', async () => {
    const r = await install([], { answers: ['1'] });
    assert.match(r.text, /1\) Echlon UI/);
    assert.match(r.text, /2\) Echlon Engine/);
    assert.match(r.text, /3\) Both/);
    assert.match(r.text, /4\) Quit/);
    assert.equal(r.code, 0, r.text);
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
  });

  it('installs both for 3', async () => {
    const r = await install([], { answers: ['3'] });
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0')) && fs.existsSync(path.join(r.dir, 'engine', '2.0.0')));
  });

  it('quits on 4 without asking for a key or touching anything', async () => {
    const r = await install([], { answers: ['4'] });
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui')) && !fs.existsSync(path.join(r.dir, 'engine')));
    assert.equal(mock.log.api.length, 0, 'nothing was asked of GitHub');
  });

  it('refuses a choice that is not on the menu', async () => {
    const r = await install([], { answers: ['9'] });
    assert.equal(r.code, 1);
    assert.match(r.text, /Please choose 1, 2, 3 or 4/);
  });

  it('refuses an unknown option, and a product that does not exist', async () => {
    await assert.rejects(() => run(['--nope'], { out: () => {} }), /Unknown option --nope/);
    const r = await install(['--product', 'everything']);
    assert.match(r.text, /must be ui, engine or both/);
  });
});

describe('where the key may go', () => {
  it('refuses a feed address that is not GitHub and not this machine', async () => {
    await assert.rejects(
      () => run(['--dir', tmpDir(), '--api', 'https://evil.example', '--product', 'ui', '--token-env', 'PACK_KEY', '--products', cfg.products, '--pubkey', cfg.pubkey], { env: { PACK_KEY: GOOD }, out: () => {} }),
      /only ever sent to api\.github\.com/,
    );
    await assert.rejects(
      () => run(['--dir', tmpDir(), '--api', 'http://example.com', '--product', 'ui', '--token-env', 'PACK_KEY', '--products', cfg.products, '--pubkey', cfg.pubkey], { env: { PACK_KEY: GOOD }, out: () => {} }),
      /only ever sent to api\.github\.com/,
    );
  });
});

describe('where to install', () => {
  it('asks for the folder before it asks for a key or touches GitHub', async () => {
    const r = await install(['--product', 'ui'], { askDir: true, answers: ['@DIR'], secrets: [GOOD] });
    assert.equal(r.code, 0, r.text);
    const folderAt = r.lines.findIndex((l) => /Install folder/.test(l));
    const keyAt = r.lines.findIndex((l) => /access key/i.test(l));
    assert.ok(folderAt >= 0 && keyAt > folderAt, 'the folder is asked first, then the key');
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0', 'app', 'server.mjs')));
  });

  it('takes the typed folder, creating it, and installs nowhere else', async () => {
    const chosen = path.join(tmpDir(), 'new', 'place');
    const r = await install(['--product', 'engine'], { askDir: true, answers: [chosen], secrets: [GOOD] });
    assert.equal(r.code, 0, r.text);
    assert.ok(fs.existsSync(path.join(chosen, 'engine', '2.0.0')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'engine')), 'the default folder was not used');
  });

  it('expands ~ to the home folder', async () => {
    const { folderOf } = await import('../installer/install.mjs');
    assert.equal(folderOf('~/Echlon', '/home/x'), path.resolve('/home/x/Echlon'));
    assert.equal(folderOf('~', '/home/x'), path.resolve('/home/x'));
    assert.equal(folderOf('~other', '/home/x'), path.resolve('~other'));
  });
});

describe('access keys', () => {
  const ENGINE_ONLY = 'ghp_engineonly_000000000000000000';

  it('asks once when one key covers both products, and uses it for each', async () => {
    const r = await install(['--product', 'both'], { secrets: [GOOD], answers: ['y'] });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.lines.filter((l) => /access key: /i.test(l)).length, 1);
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0')) && fs.existsSync(path.join(r.dir, 'engine', '2.0.0')));
  });

  it('treats Enter as yes to one key for both', async () => {
    const r = await install(['--product', 'both'], { secrets: [GOOD], answers: [''] });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.lines.filter((l) => /access key: /i.test(l)).length, 1);
  });

  it('asks for a key per product when they are separate, and each product is fetched with its own', async () => {
    const r = await install(['--product', 'both'], {
      secrets: [UI_ONLY, ENGINE_ONLY],
      answers: ['n'],
      tokens: { [UI_ONLY]: ['example/ui'], [ENGINE_ONLY]: ['example/engine'] },
    });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /Echlon UI access key/);
    assert.match(r.text, /Echlon Engine access key/);
    const used = new Set(mock.log.api.map((e) => e.authorization));
    assert.deepEqual([...used].sort(), [`Bearer ${ENGINE_ONLY}`, `Bearer ${UI_ONLY}`].sort());
    assert.ok(!r.text.includes(UI_ONLY) && !r.text.includes(ENGINE_ONLY));
  });

  it('installs the product a key covers and says which one it does not', async () => {
    const r = await install(['--product', 'both'], { secrets: [UI_ONLY], answers: ['y'] });
    assert.equal(r.code, 1);
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'engine')));
    assert.match(r.text, /Not installed - Echlon Engine: This key does not include Echlon Engine/);
    assert.ok(!/Nothing was installed/.test(r.text), 'something was installed, so it does not say nothing was');
  });

  it('takes a key per product from the environment, without asking', async () => {
    const r = await install(['--product', 'both', '--ui-key-env', 'UI_KEY', '--engine-key-env', 'ENG_KEY'], {
      env: { UI_KEY: UI_ONLY, ENG_KEY: ENGINE_ONLY },
      tokens: { [UI_ONLY]: ['example/ui'], [ENGINE_ONLY]: ['example/engine'] },
    });
    assert.equal(r.code, 0, r.text);
  });

  it('ends with a plain line saying nothing was installed when every product failed', async () => {
    const r = await install(['--product', 'both'], { token: 'ghp_wrong_000000000000000000000' });
    assert.equal(r.code, 1);
    assert.match(r.text, /Nothing was installed\./);
  });

  it('ends with Done when everything installed', async () => {
    const r = await install(['--product', 'ui']);
    assert.match(r.text, /Done\./);
  });

  it('refuses to go on without a key, before asking GitHub anything', async () => {
    const r = await install(['--product', 'ui'], { secrets: [''] });
    assert.equal(r.code, 1);
    assert.match(r.text, /access key is needed for Echlon UI/);
    assert.equal(mock.log.api.length, 0);
  });
});

describe('setting a package up', () => {
  const withPack = (pack) =>
    buildFeeds({
      privateKey: keys.privateKey,
      target: TARGET,
      uiFiles: {
        'echlon-pack.json': JSON.stringify({ name: 'ui', start: { win32: 'start.cmd', posix: 'start.sh' }, ...pack }),
        'start.cmd': '@echo off\r\n',
        'start.sh': '#!/bin/sh\n',
        'app/server.mjs': 'x\n',
      },
    });
  const NPM_CI = ['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'];

  it('runs the package setup step inside the unpacked folder, before it is put in place', async () => {
    const calls = [];
    const r = await install(['--product', 'ui'], {
      feeds: withPack({ postInstall: [NPM_CI] }),
      deps: { runCommand: (step, cwd) => calls.push({ step, cwd, finalExists: fs.existsSync(cwd.replace(/\.partial$/, '')) }) },
    });
    assert.equal(r.code, 0, r.text);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].step, NPM_CI);
    assert.match(calls[0].cwd, /1\.0\.0\.partial$/);
    assert.equal(calls[0].finalExists, false, 'it ran before the version was moved into place');
    assert.match(r.text, /Setting up Echlon UI/);
  });

  it('refuses any other command, and installs nothing', async () => {
    for (const bad of [['powershell', '-c', 'calc'], ['npm', 'install', 'left-pad'], ['npm', 'ci', '--foo'], 'npm ci']) {
      const calls = [];
      const r = await install(['--product', 'ui'], { feeds: withPack({ postInstall: [bad] }), deps: { runCommand: (s) => calls.push(s) } });
      assert.equal(r.code, 1, String(bad));
      assert.match(r.text, /does not run/);
      assert.equal(calls.length, 0);
      assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
      assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0.partial')));
    }
  });

  it('leaves the folder as it was when the setup step fails', async () => {
    const r = await install(['--product', 'ui'], {
      feeds: withPack({ postInstall: [NPM_CI] }),
      deps: {
        runCommand: () => {
          throw new PackError('Setting up the program failed.');
        },
      },
    });
    assert.equal(r.code, 1);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0.partial')), 'the half-built folder is removed');
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', 'current.json')));
  });

  it('refuses a package that needs a newer Node than this computer has', async () => {
    const r = await install(['--product', 'ui'], { feeds: withPack({ requires: { node: 22 } }), deps: { nodeMajor: 20 } });
    assert.equal(r.code, 1);
    assert.match(r.text, /needs Node 22 or newer, and this computer has Node 20/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
  });

  it('goes ahead when Node is new enough', async () => {
    const r = await install(['--product', 'ui'], { feeds: withPack({ requires: { node: 22 } }), deps: { nodeMajor: 22 } });
    assert.equal(r.code, 0, r.text);
  });
});
