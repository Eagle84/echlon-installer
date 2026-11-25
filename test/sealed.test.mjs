import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../installer/install.mjs';
import { PackError } from '../installer/lib/errors.mjs';
import { verifyManifest } from '../installer/lib/verify.mjs';
import { buildFeeds, buildSealedFeeds, newKeys, noPath, sandboxHosts, startMock, startService, tmpDir, walk, writeConfig } from './helpers.mjs';

const LIC = 'ech_lic_sealedkey0000000000000000';
const GOOD = 'ghp_goodkey_00000000000000000000';
const TARGET = 'linux-x64';
const keys = newKeys();
let cfg;
let service;
let mock;

async function install(extra = [], { sealed, token = LIC, serviceOpts = {}, answers = [] } = {}) {
  const dir = tmpDir();
  if (service) await service.close();
  if (mock) await mock.close();
  service = await startService({ licences: { [LIC]: { products: ['ui', 'engine'] } }, repos: sealed.repos, contentKeys: sealed.contentKeys, ...serviceOpts });
  mock = await startMock({ tokens: { [GOOD]: ['example/ui', 'example/engine'] }, repos: sealed.repos });
  const lines = [];
  const asked = [...answers];
  const code = await run(['--dir', dir, '--service', service.base, '--api', mock.base, '--target', TARGET, '--products', cfg.products, '--pubkey', cfg.pubkey, '--token-env', 'PACK_KEY', ...extra], {
    env: { PACK_KEY: token },
    out: (l) => lines.push(l),
    askFn: async (q) => (lines.push(q), asked.shift() ?? ''),
    runCommand: () => {},
    hostCtx: sandboxHosts(),
    pathAdder: noPath,
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
  await mock?.close();
});

describe('installing a sealed release', () => {
  it('opens it with the key the licence service gave, and installs exactly what was sealed', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    const r = await install(['--product', 'both'], { sealed });
    assert.equal(r.code, 0, r.text);
    assert.equal(fs.readFileSync(path.join(r.dir, 'ui', '1.0.0', 'app', 'server.mjs'), 'utf8'), 'console.log("SECRET-UI-LOGIC");\n');
    assert.ok(fs.readFileSync(path.join(r.dir, 'engine', '2.0.0', `echlon-engine-${TARGET}`)).equals(sealed.engineBin));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'engine', 'current.json'), 'utf8')), { version: '2.0.0', file: `echlon-engine-${TARGET}` });
    assert.match(r.text, /Unsealing Echlon UI/);
    assert.match(r.text, /Unsealing Echlon Engine/);
  });

  it('downloads only ciphertext: what crosses the wire and sits in the release has nothing readable in it', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    for (const repo of Object.values(sealed.repos)) {
      for (const asset of repo.assets.filter((a) => a.name.endsWith('.sealed'))) {
        assert.equal(asset.body.subarray(0, 8).toString(), 'ECHSEAL1');
        assert.ok(!asset.body.includes('SECRET-UI-LOGIC') && !asset.body.includes('SECRET-ENGINE-BINARY') && !asset.body.includes('server.mjs'), asset.name);
      }
    }
  });

  it('never prints the key, never writes it anywhere, and leaves no unsealed copy behind', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    const r = await install(['--product', 'both'], { sealed });
    assert.equal(r.code, 0, r.text);
    for (const k of Object.values(sealed.contentKeys)) {
      for (const form of [k.toString('base64'), k.toString('hex')]) {
        assert.ok(!r.text.includes(form));
        for (const file of walk(r.dir)) assert.ok(!fs.readFileSync(file).includes(form), `${file} holds the release key`);
      }
    }
    assert.ok(!walk(r.dir).some((f) => /\.sealed$|unsealed-/.test(f)), 'no sealed or unsealed temporary file in the install');
  });

  it('refuses a release whose key the service will not give, and installs nothing', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    const r = await install(['--product', 'ui'], { sealed, serviceOpts: { withholdKey: true } });
    assert.equal(r.code, 1);
    assert.match(r.text, /is sealed, and only a licence key can open it/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
  });

  it('refuses a key that is not the one it was sealed with, saying it could not be unsealed', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    const r = await install(['--product', 'ui'], { sealed, serviceOpts: { wrongKey: true } });
    assert.equal(r.code, 1);
    assert.match(r.text, /could not be unsealed/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')) && !fs.existsSync(path.join(r.dir, 'ui', 'current.json')));
  });

  it('refuses a download that was altered on the way, before it is opened', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, uiDamage: { flipByte: 200 } });
    const r = await install(['--product', 'ui'], { sealed });
    assert.equal(r.code, 1);
    assert.match(r.text, /does not match what was signed/);
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
  });

  it('refuses a manifest whose sealing details were changed after it was signed', async () => {
    for (const afterSigning of [(m) => (m.release.sealed.sha256 = 'f'.repeat(64)), (m) => (m.release.sealed.name = 'other.zip'), (m) => (m.release.sealed.size += 1), (m) => delete m.release.sealed]) {
      const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, uiDamage: { afterSigning } });
      const r = await install(['--product', 'ui'], { sealed });
      assert.equal(r.code, 1, String(afterSigning));
      assert.match(r.text, /signature does not match|incomplete/, String(afterSigning));
      assert.ok(!fs.existsSync(path.join(r.dir, 'ui', '1.0.0')));
    }
  });

  it('refuses a release that was signed but whose contents are not what it says, and one that names a path instead of a file', async () => {
    const wrongInner = await buildSealedFeeds({ privateKey: keys.privateKey, uiDamage: { innerSha: 'e'.repeat(64) } });
    const a = await install(['--product', 'ui'], { sealed: wrongInner });
    assert.equal(a.code, 1);
    assert.match(a.text, /What was inside Echlon UI does not match what was signed/);
    assert.ok(!fs.existsSync(path.join(a.dir, 'ui', '1.0.0')));
    for (const sealedName of ['../evil.zip', 'a/b.zip', 'a\\b.zip', '..', '']) {
      const bad = await buildSealedFeeds({ privateKey: keys.privateKey, uiDamage: { sealedName } });
      const b = await install(['--product', 'ui'], { sealed: bad });
      assert.equal(b.code, 1, JSON.stringify(sealedName));
      assert.match(b.text, /incomplete/, JSON.stringify(sealedName));
    }
  });

  it('is not opened by a GitHub token, which has no key to open it with', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    const r = await install(['--product', 'ui'], { sealed, token: GOOD });
    assert.equal(r.code, 1);
    assert.match(r.text, /is sealed, and only a licence key can open it/);
  });

  it('leaves an ordinary release exactly as it was, and ignores a key it did not need', async () => {
    const plain = buildFeeds({ privateKey: keys.privateKey, target: TARGET });
    const dir = tmpDir();
    if (service) await service.close();
    service = await startService({ licences: { [LIC]: { products: ['ui', 'engine'] } }, repos: plain, contentKeys: { ui: Buffer.alloc(32, 1) } });
    const lines = [];
    const code = await run(['--dir', dir, '--service', service.base, '--target', TARGET, '--products', cfg.products, '--pubkey', cfg.pubkey, '--token-env', 'PACK_KEY', '--product', 'ui'], { env: { PACK_KEY: LIC }, out: (l) => lines.push(l), runCommand: () => {}, hostCtx: sandboxHosts() });
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(!lines.some((l) => /Unsealing/.test(l)));
  });
});

describe('the signature over a sealed release', () => {
  it('is checked over the sealing details, so a manifest cannot say one thing and be signed for another', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    const manifest = JSON.parse(sealed.repos['example/ui'].assets.find((a) => a.name === 'latest-ui.json').body.toString());
    assert.equal(verifyManifest(manifest, keys.pubB64).sealed.name, 'echlon-ui-1.0.0.zip');
    const moved = JSON.parse(JSON.stringify(manifest));
    moved.release.sealed.wrap.ct = 'BBBB';
    assert.throws(() => verifyManifest(moved, keys.pubB64), /signature does not match/);
  });
});
