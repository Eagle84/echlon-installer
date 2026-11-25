import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../installer/install.mjs';
import { PackError } from '../installer/lib/errors.mjs';
import { buildSealedFeeds, newKeys, sandboxHosts, startMock, startService, tmpDir, walk, writeConfig } from './helpers.mjs';

const LIC = 'ech_lic_enginepackage000000000000';
const GOOD = 'ghp_goodkey_00000000000000000000';
const TARGET = 'linux-x64';
const HOST_EXE = process.platform === 'win32' ? 'echlon.exe' : 'echlon';
const keys = newKeys();
let cfg;
let service;
let mock;

async function install(extra = [], { sealed, token = LIC, entry } = {}) {
  const dir = tmpDir();
  if (service) await service.close();
  if (mock) await mock.close();
  service = await startService({ licences: { [LIC]: { products: ['ui', 'engine'] } }, repos: sealed.repos, contentKeys: sealed.contentKeys });
  mock = await startMock({ tokens: { [GOOD]: ['example/ui', 'example/engine'] }, repos: sealed.repos });
  const lines = [];
  const seen = [];
  const code = await run(['--dir', dir, '--service', service.base, '--api', mock.base, '--target', TARGET, '--products', cfg.products, '--pubkey', cfg.pubkey, '--token-env', 'PACK_KEY', ...extra], {
    env: { PACK_KEY: token },
    out: (l) => lines.push(l),
    askFn: async () => '',
    runCommand: () => {},
    hostCtx: sandboxHosts(),
    entryOf: entry ?? (async (exe) => (seen.push(exe), { command: exe, args: [], env: { A: '1' } })),
  }).catch((e) => {
    if (e instanceof PackError) {
      lines.push(e.message);
      return 1;
    }
    throw e;
  });
  return { dir, lines, text: lines.join('\n'), code, seen };
}

before(() => {
  cfg = writeConfig(tmpDir(), keys.pubB64);
});
after(async () => {
  await service?.close();
  await mock?.close();
});

describe('installing the engine as a package', () => {
  it('unpacks the whole folder, and launches the program the package names for this system', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: {} });
    const r = await install(['--product', 'engine'], { sealed });
    assert.equal(r.code, 0, r.text);
    const dest = path.join(r.dir, 'engine', '2.0.0');
    assert.ok(fs.existsSync(path.join(dest, HOST_EXE)));
    assert.ok(fs.existsSync(path.join(dest, 'rule-bank', 'a.json')), 'what sits beside the program came with it');
    const launcher = fs.readFileSync(path.join(r.dir, process.platform === 'win32' ? 'start-engine.cmd' : 'start-engine.sh'), 'utf8');
    assert.ok(launcher.includes(HOST_EXE), 'the launcher runs the named program, not the zip');
    assert.ok(!launcher.includes('.zip'));
  });

  it('gives an AI-tool connection the path of the program, not of the package', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: {} });
    const r = await install(['--product', 'engine', '--connect', 'all'], { sealed });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.seen.length, 1);
    assert.equal(path.basename(r.seen[0]), HOST_EXE);
    assert.ok(r.seen[0].includes(path.join('engine', '2.0.0')));
  });

  it('makes the program runnable on Linux, which a zip does not carry', async (t) => {
    if (process.platform === 'win32') return t.skip('Windows has no execute bit');
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: {} });
    const r = await install(['--product', 'engine'], { sealed });
    assert.equal(fs.statSync(path.join(r.dir, 'engine', '2.0.0', 'echlon')).mode & 0o111, 0o111);
  });

  it('keeps the licence key beside the engine for a licensed package, and says so without printing it', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: {} });
    const r = await install(['--product', 'engine'], { sealed });
    const keyFile = path.join(r.dir, 'engine', '2.0.0', 'licence.key');
    assert.equal(fs.readFileSync(keyFile, 'utf8'), `${LIC}\n`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.match(r.text, /licence key is kept for the engine/);
    assert.ok(!r.text.includes(LIC));
  });

  it('writes the key only where a product reads it, when both are installed', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: {}, uiFiles: { 'echlon-pack.json': JSON.stringify({ name: 'ui', licensed: true, start: { win32: 'start.cmd', posix: 'start.sh' } }), 'start.cmd': 'x', 'start.sh': 'x', 'app/server.mjs': 'x' } });
    const r = await install(['--product', 'both'], { sealed });
    assert.equal(r.code, 0, r.text);
    const holders = walk(r.dir).filter((f) => fs.readFileSync(f).includes(LIC)).map((f) => path.relative(r.dir, f).split(path.sep).join('/')).sort();
    assert.deepEqual(holders, ['engine/2.0.0/licence.key', 'ui/data/licence.key']);
  });

  it('does not keep a key for a package that is not licensed', async () => {
    const plain = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: { pack: { licensed: false } } });
    const a = await install(['--product', 'engine'], { sealed: plain });
    assert.equal(a.code, 0, a.text);
    assert.ok(!fs.existsSync(path.join(a.dir, 'engine', '2.0.0', 'licence.key')));
    assert.ok(!walk(a.dir).some((f) => fs.readFileSync(f).includes(LIC)));
  });

  it('cannot be installed with a GitHub token at all, so no token is ever kept as a licence key', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: {} });
    const b = await install(['--product', 'engine'], { sealed, token: GOOD });
    assert.equal(b.code, 1);
    assert.match(b.text, /only a licence key can open it/);
    assert.ok(!fs.existsSync(path.join(b.dir, 'engine')));
    assert.ok(!walk(b.dir).some((f) => fs.readFileSync(f).includes(GOOD)));
  });
});

describe('a package that names something it should not', () => {
  const bad = async (pack, files) => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey, enginePackage: { pack, ...(files ? { files } : {}) } });
    return install(['--product', 'engine'], { sealed });
  };

  it('a program that is not in the package, or that has no entry for this system, installs nothing', async () => {
    const missing = await bad({ exe: { win32: 'nothing.exe', posix: 'nothing' } });
    assert.equal(missing.code, 1);
    assert.match(missing.text, /names a program that is not in the package/);
    assert.ok(!fs.existsSync(path.join(missing.dir, 'engine', '2.0.0')) && !fs.existsSync(path.join(missing.dir, 'engine', 'current.json')));
    const other = await bad({ exe: { darwin: 'echlon' } });
    assert.equal(other.code, 1);
    assert.match(other.text, /is not for this computer/);
  });

  it('a program that is a path out of the package, absolute, or empty', async () => {
    for (const name of ['../evil.exe', '..\\evil.exe', 'a/../../b', '/etc/passwd', 'C:\\Windows\\x.exe', '']) {
      const r = await bad({ exe: { win32: name, posix: name } });
      assert.equal(r.code, 1, JSON.stringify(name));
      assert.match(r.text, /not a plain path inside the package|names a program that is not in the package/, JSON.stringify(name));
      assert.ok(!fs.existsSync(path.join(r.dir, 'engine', '2.0.0')));
    }
  });

  it('a package with no program named still installs as a folder, as before (the old single-file engine is unchanged too)', async () => {
    const sealed = await buildSealedFeeds({ privateKey: keys.privateKey });
    const r = await install(['--product', 'engine'], { sealed });
    assert.equal(r.code, 0, r.text);
    assert.ok(fs.existsSync(path.join(r.dir, 'engine', '2.0.0', `echlon-engine-${TARGET}`)));
  });
});
