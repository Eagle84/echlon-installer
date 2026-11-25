import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PackError } from '../installer/lib/errors.mjs';
import { PassThrough } from 'node:stream';
import { applyKey, ask } from '../installer/lib/prompt.mjs';
import { assetNameOf } from '../installer/lib/product.mjs';
import { canonical, verifyManifest } from '../installer/lib/verify.mjs';
import { checkInstallDir, engineLauncher, shq, uiLauncher, withEngineConnection } from '../installer/lib/wire.mjs';
import { extractZip, listZip, safeTarget } from '../installer/lib/zip.mjs';
import { makeZip, newKeys, signedManifest, tmpDir } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('typing a key without showing it', () => {
  it('adds what is typed, removes one on backspace, ends on Enter and cancels on Ctrl-C', () => {
    let s = { buffer: '' };
    for (const ch of 'ab') s = applyKey(s.buffer, ch);
    assert.equal(s.buffer, 'ab');
    assert.equal(applyKey('ab', '\u007f').buffer, 'a');
    assert.equal(applyKey('', '\u007f').buffer, '');
    assert.equal(applyKey('ab', '\r').done, true);
    assert.equal(applyKey('ab', '\u0003').cancelled, true);
    assert.equal(applyKey('ab', '\u001b').buffer, 'ab');
  });
});

describe('asking a question', () => {
  const streams = () => ({ input: new PassThrough(), output: new PassThrough() });

  it('returns the answer, trimmed', async () => {
    const io = streams();
    const p = ask('Where? ', io);
    io.input.write('  here  \n');
    assert.equal(await p, 'here');
  });

  it('fails loudly when the input ends before an answer, instead of the program just stopping', async () => {
    const io = streams();
    const p = ask('Where? ', io);
    io.input.end();
    await assert.rejects(p, /input closed\. Nothing was installed/);
  });
});

describe('checking a release', () => {
  const keys = newKeys();
  const art = Buffer.from('artifact');

  it('accepts a release signed with the key and hands back what was signed', () => {
    const m = signedManifest({ version: '1.2.3', assetName: 'a.zip', artifact: art, privateKey: keys.privateKey });
    assert.deepEqual(verifyManifest(m, keys.pubB64), m.release);
  });

  it('signs over the same three lines the engine repo’s release script signs', () => {
    assert.equal(canonical({ version: '1', url: 'u', sha256: 'h' }), 'version=1\nurl=u\nsha256=h');
  });

  it('refuses a release whose version, url or hash was changed after signing', () => {
    const m = signedManifest({ version: '1.2.3', assetName: 'a.zip', artifact: art, privateKey: keys.privateKey });
    for (const field of ['version', 'url', 'sha256']) {
      const bad = { ...m, release: { ...m.release, [field]: `${m.release[field]}x` } };
      assert.throws(() => verifyManifest(bad, keys.pubB64), /signature does not match/);
    }
  });

  it('refuses an incomplete manifest, and a key that is not there or not readable', () => {
    assert.throws(() => verifyManifest({ release: { version: '1' }, signature: 's' }, keys.pubB64), /incomplete/);
    assert.throws(() => verifyManifest(null, keys.pubB64), PackError);
    const m = signedManifest({ version: '1', assetName: 'a', artifact: art, privateKey: keys.privateKey });
    assert.throws(() => verifyManifest(m, 'REPLACE_WITH_RELEASE_PUBKEY'), /no release key/);
    assert.throws(() => verifyManifest(m, '!!!not-a-key!!!'), PackError);
  });
});

describe('unpacking', () => {
  it('unpacks stored and deflated files, including nested folders', () => {
    const dir = tmpDir();
    const zip = path.join(dir, 'a.zip');
    fs.writeFileSync(zip, makeZip({ 'a.txt': 'hello', 'sub/b.txt': 'x'.repeat(5000), 'empty.txt': '' }));
    const names = extractZip(zip, path.join(dir, 'out'));
    assert.deepEqual(names.sort(), ['a.txt', 'empty.txt', 'sub/b.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'out', 'sub', 'b.txt'), 'utf8'), 'x'.repeat(5000));
    assert.equal(fs.readFileSync(path.join(dir, 'out', 'a.txt'), 'utf8'), 'hello');
  });

  it('refuses a name that leaves the folder, however it is written', () => {
    const root = tmpDir();
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:\\win', '..\\x']) assert.throws(() => safeTarget(root, bad), /unsafe path/, bad);
    assert.ok(safeTarget(root, 'a/b.txt').startsWith(root));
  });

  it('refuses something that is not an archive, and a file whose size does not match its header', () => {
    assert.throws(() => listZip(Buffer.from('not a zip at all, just text here')), /not a valid archive/);
    const dir = tmpDir();
    const zip = makeZip({ 'a.txt': 'hello world '.repeat(50) });
    // Damage the compressed bytes, which start right after the 30-byte header and the 5-byte name.
    zip[30 + 5 + 3] ^= 0xff;
    zip[30 + 5 + 4] ^= 0xff;
    fs.writeFileSync(path.join(dir, 'bad.zip'), zip);
    assert.throws(() => extractZip(path.join(dir, 'bad.zip'), path.join(dir, 'out')), /damaged/);
    // Nothing is left behind by a failed unpack of a single bad file's folder beyond what was already safe.
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'a.txt')));
  });
});

describe('names and quoting', () => {
  it('names an asset by the last part of its url', () => {
    assert.equal(assetNameOf('https://github.com/o/r/releases/download/v1/echlon-ui-1.zip'), 'echlon-ui-1.zip');
    assert.equal(assetNameOf('https://x/y/a%20b.zip'), 'a b.zip');
    assert.equal(assetNameOf('plain/path/file.bin'), 'file.bin');
  });

  it('quotes a path with a single quote in it so a shell reads it as one word', () => {
    assert.equal(shq("a'b"), "'a'\\''b'");
    assert.equal(shq('plain'), "'plain'");
  });

  it('refuses an install folder a Windows start script cannot hold', () => {
    assert.throws(() => checkInstallDir('C:\\Users\\a&b\\Echlon', 'win32'), /Windows start scripts/);
    assert.throws(() => checkInstallDir('C:\\100%\\Echlon', 'win32'), PackError);
    checkInstallDir('C:\\Users\\Dana Levi\\Echlon', 'win32');
    checkInstallDir("/home/o'brien/Echlon", 'linux');
  });
});

describe('what is written for the customer', () => {
  it('replaces an earlier engine connection and leaves every other setting alone', () => {
    const before = { theme: 'dark', connections: [{ id: 'x', vendor: 'jira', label: 'J' }, { id: 'old', vendor: 'echlon-engine', label: 'old' }] };
    const after = withEngineConnection(before, 'tok');
    assert.equal(after.theme, 'dark');
    assert.equal(after.connections.filter((c) => c.vendor === 'echlon-engine').length, 1);
    assert.equal(after.connections.find((c) => c.vendor === 'jira').label, 'J');
    assert.deepEqual(after.connections.find((c) => c.vendor === 'echlon-engine').secrets, { apiKey: 'tok' });
  });

  it('writes a start script per platform that sets the token and starts the right thing', () => {
    const win = engineLauncher({ platform: 'win32', installDir: 'C:\\E', exeRelative: 'engine\\1\\echlon.exe', token: 'tok' });
    assert.equal(win.name, 'start-engine.cmd');
    assert.match(win.text, /set "ECHLON_MCP_TOKEN=tok"/);
    assert.match(win.text, /echlon\.exe" --http/);
    const nix = engineLauncher({ platform: 'linux', installDir: "/o'b", exeRelative: 'engine/1/echlon', token: 'tok' });
    assert.equal(nix.name, 'start-engine.sh');
    assert.match(nix.text, /^#!\/bin\/sh/);
    assert.match(nix.text, /ECHLON_MCP_TOKEN='tok'/);
    assert.ok(nix.text.includes(`exec ${shq(path.posix.join("/o'b", 'engine/1/echlon'))} --http`));
    assert.ok(nix.text.includes(`'\\''`), 'the single quote in the folder name is closed, escaped and reopened');
  });

  it('starts the UI with its data kept outside the versioned folder, so an update keeps it', () => {
    const nix = uiLauncher({ platform: 'linux', versionDir: '/E/ui/1.0.0', startRelative: 'start.sh', dataDir: '/E/ui/data' });
    assert.match(nix.text, /ECHLON_DATA_DIR='\/E\/ui\/data'/);
    assert.match(nix.text, /cd '\/E\/ui\/1\.0\.0'/);
    const win = uiLauncher({ platform: 'win32', versionDir: 'C:\\E\\ui\\1', startRelative: 'start.cmd', dataDir: 'C:\\E\\ui\\data' });
    assert.match(win.text, /set "ECHLON_DATA_DIR=C:\\E\\ui\\data"/);
    assert.match(win.text, /call "C:\\E\\ui\\1\\start\.cmd"/);
  });
});

describe('the entry scripts', () => {
  it('install.sh is valid shell', (t) => {
    const r = spawnSync('sh', ['-n', path.join(ROOT, 'install.sh')], { encoding: 'utf8' });
    if (r.error) return t.skip('no sh on this machine');
    assert.equal(r.status, 0, r.stderr);
  });

  it('install.ps1 parses as PowerShell', (t) => {
    const script = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, 'install.ps1').replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    if (r.error) return t.skip('no PowerShell on this machine');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it('install.bat hands over to install.ps1 for this run only', () => {
    const bat = fs.readFileSync(path.join(ROOT, 'install.bat'), 'utf8');
    assert.match(bat, /-ExecutionPolicy Bypass -File "%~dp0install\.ps1" %\*/);
  });

  it('install.bat keeps the window open when started by double-click, and keeps the exit code', () => {
    const bat = fs.readFileSync(path.join(ROOT, 'install.bat'), 'utf8');
    assert.match(bat, /find \/i "\/c"/);
    assert.match(bat, /\bpause\b/);
    assert.match(bat, /exit \/b %echlon_code%/);
  });

  it('the shipped feed config names both products and no secret', () => {
    const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'products.json'), 'utf8'));
    assert.deepEqual(Object.keys(products).sort(), ['engine', 'ui']);
    for (const p of Object.values(products)) assert.match(p.repo, /^[\w.-]+\/[\w.-]+$/);
    assert.ok(!/ghp_|github_pat_|BEGIN .*PRIVATE KEY/.test(JSON.stringify(products)));
  });
});

describe('the shipped release key and service address', () => {
  it('is a real Ed25519 public key, not the placeholder, so a release signed by the matching private key can be verified', async () => {
    const { createPublicKey } = await import('node:crypto');
    const text = fs.readFileSync(path.join(ROOT, 'release-pubkey.txt'), 'utf8').trim();
    assert.ok(!/REPLACE/.test(text), 'still the placeholder');
    const key = createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
    assert.equal(key.asymmetricKeyType, 'ed25519');
  });

  it('names the licence service over https, as a bare origin with no path', () => {
    const url = new URL(fs.readFileSync(path.join(ROOT, 'service.txt'), 'utf8').trim());
    assert.equal(url.protocol, 'https:');
    assert.equal(url.origin + '/', url.href);
    assert.equal(url.hostname, 'licence.echlonlabs.com');
  });
});

describe('what the installer needs of Node', () => {
  // The launchers accept Node 20 and newer, and an engine-only install needs nothing newer, so the installer must LOAD
  // on Node 20. A named import of something only recent Node has makes the whole installer fail at start, even for a
  // plain release. Tests run on one Node, so this reads the imports instead of trusting that run.
  const NODE_20_CRYPTO = new Set(['createCipheriv', 'createDecipheriv', 'createHash', 'createPublicKey', 'createPrivateKey', 'generateKeyPairSync', 'hkdfSync', 'randomBytes', 'sign', 'verify', 'randomUUID']);

  it('imports from node:crypto only what Node 20 has, in every file the installer loads', () => {
    const files = [path.join(ROOT, 'installer', 'install.mjs'), ...fs.readdirSync(path.join(ROOT, 'installer', 'lib')).map((f) => path.join(ROOT, 'installer', 'lib', f))];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:crypto'/g)) {
        for (const name of m[1].split(',').map((n) => n.trim()).filter(Boolean)) {
          assert.ok(NODE_20_CRYPTO.has(name), `${path.basename(file)} imports ${name} from node:crypto by name; it may not exist on Node 20, and then the installer cannot start`);
        }
      }
    }
  });

  it('keeps the key-wrapping functions out of the names it imports, and says why', () => {
    const text = fs.readFileSync(path.join(ROOT, 'installer', 'lib', 'sealed.mjs'), 'utf8');
    assert.ok(!/^\s+(encapsulate|decapsulate),/m.test(text));
    assert.match(text, /kem\.encapsulate\(/);
    assert.match(text, /never imported by name/);
  });

  it('declares the Node it needs as 20, the same as the launchers', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines.node, '>=20');
    assert.match(fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8'), /\$need = 20/);
    assert.match(fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'), /need=20/);
  });
});
