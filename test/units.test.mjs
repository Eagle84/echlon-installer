import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PackError } from '../installer/lib/errors.mjs';
import { applyKey } from '../installer/lib/prompt.mjs';
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
    assert.ok(nix.text.includes(`exec ${shq(path.join("/o'b", 'engine/1/echlon'))} --http`));
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

  it('the shipped feed config names both products and no secret', () => {
    const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'products.json'), 'utf8'));
    assert.deepEqual(Object.keys(products).sort(), ['engine', 'ui']);
    for (const p of Object.values(products)) assert.match(p.repo, /^[\w.-]+\/[\w.-]+$/);
    assert.ok(!/ghp_|github_pat_|BEGIN .*PRIVATE KEY/.test(JSON.stringify(products)));
  });
});
