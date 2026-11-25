import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../installer/install.mjs';
import { PackError } from '../installer/lib/errors.mjs';
import { checkServiceUrl } from '../installer/lib/service.mjs';
import { buildFeeds, newKeys, sandboxHosts, startService, tmpDir, walk, writeConfig } from './helpers.mjs';

const BOTH = 'ech_lic_bothproducts0000000000000000';
const UI_ONLY = 'ech_lic_uionly0000000000000000000';
const ENGINE_ONLY = 'ech_lic_engineonly000000000000000';
const TARGET = 'linux-x64';
const keys = newKeys();
let service;
let cfg;

const LICENCES = {
  [BOTH]: { products: ['ui', 'engine'] },
  [UI_ONLY]: { products: ['ui'] },
  [ENGINE_ONLY]: { products: ['engine'] },
  ech_lic_revoked: { products: ['ui', 'engine'], state: 'revoked' },
  ech_lic_suspended: { products: ['ui', 'engine'], state: 'suspended' },
  ech_lic_expired: { products: ['ui', 'engine'], state: 'expired' },
  ech_lic_newstate: { products: ['ui', 'engine'], state: 'a-state-this-installer-has-never-heard-of' },
};

async function install(extra = [], { key = BOTH, feeds = buildFeeds({ privateKey: keys.privateKey, target: TARGET }), secrets, serviceOpts = {}, answers = [], serviceUrl, deps = {} } = {}) {
  const dir = tmpDir();
  if (service) await service.close();
  service = await startService({ licences: LICENCES, repos: feeds, ...serviceOpts });
  const lines = [];
  const left = secrets ? [...secrets] : undefined;
  const asked = [...answers];
  const code = await run(['--dir', dir, '--service', serviceUrl ?? service.base, '--target', TARGET, '--products', cfg.products, '--pubkey', cfg.pubkey, ...(left ? [] : ['--token-env', 'PACK_KEY']), ...extra], {
    env: { PACK_KEY: key },
    out: (l) => lines.push(l),
    askFn: async (q) => {
      lines.push(q);
      return asked.shift() ?? '';
    },
    askSecret: async (q) => {
      if (!left) throw new Error('the key must come from the environment in these tests');
      lines.push(q);
      return left.shift() ?? '';
    },
    runCommand: () => {},
    hostCtx: sandboxHosts(),
    ...deps,
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
  await service?.close();
});

describe('installing with a licence key', () => {
  it('installs both products from one licence key, through the service', async () => {
    const r = await install(['--product', 'both']);
    assert.equal(r.code, 0, r.text);
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0', 'app', 'server.mjs')));
    assert.ok(fs.existsSync(path.join(r.dir, 'engine', '2.0.0', `echlon-engine-${TARGET}`)));
    assert.match(r.text, /Done\./);
  });

  it('tells the customer each step in order, with the download bar between downloading and checking', async () => {
    const drawn = [];
    const stream = { isTTY: true, columns: 80, write: (s) => drawn.push(s) };
    const r = await install(['--product', 'ui'], { deps: { stream } });
    assert.equal(r.code, 0, r.text);
    const steps = ['Checking your key for Echlon UI', 'Downloading Echlon UI 1.0.0', 'Checking the download is exactly what Echlon signed', 'Unpacking Echlon UI', 'Installed Echlon UI 1.0.0'];
    let at = -1;
    for (const s of steps) {
      const i = r.lines.findIndex((l, n) => n > at && l.includes(s));
      assert.ok(i > at, `"${s}" is missing or out of order in:\n${r.text}`);
      at = i;
    }
    const bar = drawn.join('');
    assert.match(bar, /\r?Echlon UI 1\.0\.0 {2}\[#{20}\] 100%/);
    assert.ok(bar.endsWith('\n'));
  });

  it('sends the key to the service and nothing to the storage host the file comes from', async () => {
    await install(['--product', 'both']);
    assert.equal(service.log.service.length, 2);
    assert.ok(service.log.service.every((e) => e.body.key === BOTH));
    assert.ok(service.log.storage.length > 0);
    assert.ok(service.log.storage.every((e) => e.authorization === undefined));
  });

  it('asks the service for a platform only for the engine', async () => {
    await install(['--product', 'both']);
    const ui = service.log.service.find((e) => e.body.product === 'ui');
    const engine = service.log.service.find((e) => e.body.product === 'engine');
    assert.equal(ui.body.target, undefined);
    assert.equal(engine.body.target, TARGET);
  });

  it('never prints, stores or logs the licence key when the package is not licensed', async () => {
    const r = await install(['--product', 'both']);
    assert.ok(!r.text.includes(BOTH));
    for (const file of walk(r.dir)) assert.ok(!fs.readFileSync(file).includes(BOTH), `${file} holds the key`);
  });

  it('still checks the signature and the hash, so a service cannot swap what is installed', async () => {
    const tampered = await install(['--product', 'ui'], { feeds: buildFeeds({ privateKey: keys.privateKey, target: TARGET, tamper: { ui: true } }) });
    assert.equal(tampered.code, 1);
    assert.match(tampered.text, /does not match what was signed/);
    assert.ok(!fs.existsSync(path.join(tampered.dir, 'ui', '1.0.0')));
    const forged = await install(['--product', 'ui'], { feeds: buildFeeds({ privateKey: keys.privateKey, target: TARGET, tamper: { badSignature: true } }) });
    assert.equal(forged.code, 1);
    assert.match(forged.text, /signature does not match/);
  });

  it('refuses a service that names a different file from the one the signed release names', async () => {
    const r = await install(['--product', 'ui'], { serviceOpts: { tamperArtifactName: true } });
    assert.equal(r.code, 1);
    assert.match(r.text, /names a file that is not in it/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
  });
});

describe('a licence key for one product, or two keys', () => {
  it('installs the product the key covers and says the other is not for this key', async () => {
    const r = await install(['--product', 'both'], { key: UI_ONLY });
    assert.equal(r.code, 1);
    assert.ok(fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
    assert.ok(!fs.existsSync(path.join(r.dir, 'engine')));
    assert.match(r.text, /Not installed - Echlon Engine: This access key is not for Echlon Engine\./);
  });

  it('takes a separate licence key for each product', async () => {
    const r = await install(['--product', 'both'], { secrets: [UI_ONLY, ENGINE_ONLY], answers: ['n'] });
    assert.equal(r.code, 0, r.text);
    const used = service.log.service.map((e) => `${e.body.product}:${e.body.key}`).sort();
    assert.deepEqual(used, [`engine:${ENGINE_ONLY}`, `ui:${UI_ONLY}`]);
  });
});

describe('what the service refuses', () => {
  for (const [key, pattern] of [
    ['ech_lic_nobody', /not recognised/],
    ['ech_lic_revoked', /has been withdrawn/],
    ['ech_lic_suspended', /is suspended/],
    ['ech_lic_expired', /licence has ended/],
    ['ech_lic_newstate', /not recognised/],
  ]) {
    it(`says plainly: ${pattern}`, async () => {
      const r = await install(['--product', 'ui'], { key });
      assert.equal(r.code, 1);
      assert.match(r.text, pattern);
      assert.match(r.text, /Nothing was installed\./);
      assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
    });
  }

  it('says when the service is down, and when the product has no build for this computer', async () => {
    const down = await install(['--product', 'ui'], { serviceOpts: { unavailable: true } });
    assert.match(down.text, /not available right now/);
    const none = await install(['--product', 'engine', '--target', 'darwin-arm64']);
    assert.match(none.text, /No build of Echlon Engine for this computer \(darwin-arm64\)/);
  });

  it('says when it cannot reach the service at all', async () => {
    const r = await install(['--product', 'ui'], { serviceUrl: 'http://127.0.0.1:9' });
    assert.equal(r.code, 1);
    assert.match(r.text, /Could not reach the Echlon download service/);
  });
});

describe('where the licence key may go', () => {
  const SHIPPED = 'https://echlonai.echlonlabs.com';

  it('accepts the shipped service address, and plain http only to this machine', () => {
    assert.equal(checkServiceUrl(SHIPPED, SHIPPED), SHIPPED);
    assert.equal(checkServiceUrl('http://127.0.0.1:3900', SHIPPED), 'http://127.0.0.1:3900');
    assert.equal(checkServiceUrl('http://localhost:3900', SHIPPED), 'http://localhost:3900');
  });

  it('refuses any other address, plain http to the shipped host, and a look-alike host', () => {
    for (const url of ['https://evil.example', 'http://echlonai.echlonlabs.com', 'https://echlonai.echlonlabs.com.evil.example', 'http://example.com', 'not a url']) {
      assert.throws(() => checkServiceUrl(url, SHIPPED), PackError, url);
    }
  });

  it('refuses to run with a service address that is not the shipped one or this machine', async () => {
    await assert.rejects(
      () => run(['--dir', tmpDir(), '--service', 'https://evil.example', '--product', 'ui', '--token-env', 'PACK_KEY', '--products', cfg.products, '--pubkey', cfg.pubkey], { env: { PACK_KEY: BOTH }, out: () => {} }),
      /only ever sent to the Echlon download service/,
    );
  });

  it('does not take a file address that is not https unless it is on this machine', async () => {
    const { ServiceFeed } = await import('../installer/lib/service.mjs');
    const feed = new ServiceFeed({ key: BOTH, url: 'http://127.0.0.1:1', fetchImpl: async () => new Response('x') });
    await assert.rejects(() => feed.save('http://evil.example/a.zip', path.join(tmpDir(), 'a.zip'), 'Echlon UI'), /insecure address/);
  });
});

describe('keeping the licence key for a licensed UI', () => {
  const licensedUi = (licensed) =>
    buildFeeds({
      privateKey: keys.privateKey,
      target: TARGET,
      uiFiles: {
        'echlon-pack.json': JSON.stringify({ name: 'ui', licensed, start: { win32: 'start.cmd', posix: 'start.sh' } }),
        'start.cmd': '@echo off\r\n',
        'start.sh': '#!/bin/sh\n',
        'app/server.mjs': 'x\n',
      },
    });
  const keyFile = (r) => path.join(r.dir, 'ui', 'data', 'licence.key');

  it('writes the key where the UI reads it, owner-only, and says so without printing it', async () => {
    const r = await install(['--product', 'ui'], { feeds: licensedUi(true) });
    assert.equal(r.code, 0, r.text);
    assert.equal(fs.readFileSync(keyFile(r), 'utf8'), `${BOTH}\n`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile(r)).mode & 0o777, 0o600);
    assert.match(r.text, /licence key is kept for the UI so it can renew its licence/);
    assert.ok(!r.text.includes(BOTH));
  });

  it('writes it nowhere else: not into the engine, not into the launchers, not into the UI settings', async () => {
    const r = await install(['--product', 'both'], { feeds: licensedUi(true) });
    assert.equal(r.code, 0, r.text);
    const holders = walk(r.dir).filter((f) => fs.readFileSync(f).includes(BOTH));
    assert.deepEqual(holders, [keyFile(r)]);
  });

  it('does not write it for a package that is not licensed', async () => {
    for (const licensed of [false, undefined]) {
      const r = await install(['--product', 'ui'], { feeds: licensedUi(licensed) });
      assert.ok(!fs.existsSync(keyFile(r)), String(licensed));
    }
  });

  it('keeps the UI key, not the engine key, when each product has its own', async () => {
    const ENGINE = 'ech_lic_engineonly000000000000000';
    const r = await install(['--product', 'both'], { feeds: licensedUi(true), secrets: [UI_ONLY, ENGINE], answers: ['n'] });
    assert.equal(r.code, 0, r.text);
    assert.equal(fs.readFileSync(keyFile(r), 'utf8'), `${UI_ONLY}\n`);
    assert.ok(!walk(r.dir).some((f) => fs.readFileSync(f).includes(ENGINE)));
  });

  it('does not write it when the engine alone is installed', async () => {
    const r = await install(['--product', 'engine'], { feeds: licensedUi(true) });
    assert.ok(!walk(r.dir).some((f) => fs.readFileSync(f).includes(BOTH)));
  });
});
