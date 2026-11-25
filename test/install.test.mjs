import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../installer/install.mjs';
import { PackError } from '../installer/lib/errors.mjs';
import { buildFeeds, newKeys, startMock, tmpDir, walk, writeConfig } from './helpers.mjs';

const GOOD = 'ghp_goodkey_00000000000000000000';
const UI_ONLY = 'ghp_uionly_00000000000000000000';
const TARGET = 'linux-x64';

const keys = newKeys();
let mock;
let cfg;

async function install(extra = [], { token = GOOD, feeds = buildFeeds({ privateKey: keys.privateKey, target: TARGET }), pubkey = cfg.pubkey, answers = [] } = {}) {
  const dir = tmpDir();
  mock?.close && (await mock.close());
  mock = await startMock({ tokens: { [GOOD]: ['example/ui', 'example/engine'], [UI_ONLY]: ['example/ui'] }, repos: feeds });
  const lines = [];
  const asked = [...answers];
  const code = await run(['--dir', dir, '--api', mock.base, '--target', TARGET, '--products', cfg.products, '--pubkey', pubkey, '--token-env', 'PACK_KEY', ...extra], {
    env: { PACK_KEY: token },
    out: (l) => lines.push(l),
    askFn: async (q) => {
      lines.push(q);
      return asked.shift() ?? '';
    },
    askSecret: async () => {
      throw new Error('the key must come from the environment in these tests');
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
    assert.match(r.text, /Not installed - Echlon Engine: This key does not include Echlon Engine\./);
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
