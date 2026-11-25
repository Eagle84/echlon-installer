import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PackError } from '../installer/lib/errors.mjs';
import { archiveName, ensureNode, parseRuntime, platformKey, runtimeBin, runtimeRoot } from '../installer/lib/runtime.mjs';
import { makeZip, tmpDir } from './helpers.mjs';

const VERSION = '26.13.1';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// The flavour this computer can really unpack: a zip on Windows, a tar.gz elsewhere. Every behaviour is checked on it.
const HOST = process.platform === 'win32' ? 'win32' : 'linux';
const KEY = HOST === 'win32' ? 'win-x64' : 'linux-x64';
const FILE = `${KEY}.${HOST === 'win32' ? 'zip' : 'tar.gz'}`;
const FOLDER = `node-v${VERSION}-${KEY}`;
const ROUTE = `/v${VERSION}/${FOLDER}.${HOST === 'win32' ? 'zip' : 'tar.gz'}`;
const NODE_AT = (root) => (HOST === 'win32' ? path.join(root, FOLDER, 'node.exe') : path.join(root, FOLDER, 'bin', 'node'));

let tarOk = true;
try {
  if (HOST !== 'win32') execFileSync('tar', ['--version'], { stdio: 'ignore' });
} catch {
  tarOk = false;
}

/** An archive shaped like Node's: one folder holding node (or, with `withNode` false, something else). */
function makeArchive({ withNode = true } = {}) {
  if (HOST === 'win32') return makeZip(withNode ? { [`${FOLDER}/node.exe`]: 'MZ fake node', [`${FOLDER}/npm.cmd`]: '@echo off' } : { [`${FOLDER}/readme.txt`]: 'no node here' });
  const src = tmpDir('echlon-tar-src-');
  const dir = path.join(src, FOLDER, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, withNode ? 'node' : 'readme'), '#!/bin/sh\n', { mode: 0o755 });
  const file = path.join(tmpDir('echlon-tar-'), 'node.tar.gz');
  execFileSync('tar', ['-czf', file, '-C', src, FOLDER]);
  return fs.readFileSync(file);
}

/** A stand-in for nodejs.org/dist that serves what it is given, counting what was asked for. */
function startDist(files) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push(req.url);
    const body = files[req.url];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise((r) => server.close(r)) })));
}

describe('the pinned runtime file', () => {
  it('names a version and a checksum per platform, and ignores comments', () => {
    const pin = parseRuntime(`# a comment\nversion=${VERSION}\nwin-x64.zip=${'a'.repeat(64)}\nlinux-x64.tar.gz=${'b'.repeat(64)}\nnonsense\nwin-x64.zip.bad=zzz\n`);
    assert.equal(pin.version, VERSION);
    assert.deepEqual(Object.keys(pin.files), ['win-x64.zip', 'linux-x64.tar.gz']);
  });

  it('refuses a file with no version, and ignores a checksum that is not 64 hex digits', () => {
    assert.throws(() => parseRuntime(`win-x64.zip=${'a'.repeat(64)}`), PackError);
    assert.deepEqual(parseRuntime(`version=${VERSION}\nwin-x64.zip=abc`).files, {});
  });

  it('is the one this installer ships: every platform it supports has a checksum', () => {
    const pin = parseRuntime(fs.readFileSync(new URL('../runtime.txt', import.meta.url), 'utf8'));
    assert.match(pin.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Number(pin.version.split('.')[0]) >= 26, 'the UI needs Node 26');
    for (const key of ['win-x64.zip', 'win-arm64.zip', 'linux-x64.tar.gz', 'linux-arm64.tar.gz', 'darwin-x64.tar.gz', 'darwin-arm64.tar.gz']) assert.match(pin.files[key] ?? '', /^[0-9a-f]{64}$/, key);
  });
});

describe('where the runtime lives', () => {
  it('is in the person\'s own profile, never system-wide, and can be moved by the environment', () => {
    assert.equal(runtimeRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' }, home: 'C:\\Users\\p' }), 'C:\\Users\\p\\AppData\\Local\\Echlon\\runtime');
    assert.equal(runtimeRoot({ platform: 'linux', env: {}, home: '/home/p' }), '/home/p/.local/share/echlon/runtime');
    assert.equal(runtimeRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/x' }, home: '/home/p' }), '/x/echlon/runtime');
    assert.equal(runtimeRoot({ platform: 'linux', env: { ECHLON_RUNTIME_ROOT: '/elsewhere' }, home: '/home/p' }), '/elsewhere');
  });

  it('names Node\'s own platform and archive, and the folder node is in', () => {
    const pin = { version: VERSION, files: {} };
    assert.equal(platformKey('win32', 'x64'), 'win-x64');
    assert.equal(archiveName(pin, 'win-x64'), `node-v${VERSION}-win-x64.zip`);
    assert.equal(archiveName(pin, 'linux-arm64'), `node-v${VERSION}-linux-arm64.tar.gz`);
    assert.equal(runtimeBin('/r', pin, 'linux-x64', 'linux'), `/r/node-v${VERSION}-linux-x64/bin`);
    assert.equal(runtimeBin('C:\\r', pin, 'win-x64', 'win32'), `C:\\r\\node-v${VERSION}-win-x64`);
  });
});

describe('finding or fetching a Node that is new enough', { skip: !tarOk && 'needs tar' }, () => {
  let dist;
  let archive;
  let pin;
  const run = (over = {}) => ensureNode({ minMajor: 26, haveMajor: 22, pin, platform: HOST, arch: 'x64', root: over.root ?? tmpDir('echlon-rt-'), dist: dist.base, ...over });
  const leftovers = (root) => (fs.existsSync(root) ? fs.readdirSync(root) : []);

  before(async () => {
    archive = makeArchive();
    pin = { version: VERSION, files: { [FILE]: sha(archive) } };
    dist = await startDist({ [ROUTE]: archive });
  });
  after(() => dist.close());

  it('uses the Node the computer already has when it is new enough, and downloads nothing', async () => {
    dist.log.length = 0;
    const r = await run({ haveMajor: 26, fetchFn: () => assert.fail('nothing should be fetched') });
    assert.deepEqual(r, { major: 26, via: 'system' });
    assert.equal(dist.log.length, 0);
  });

  it('tells the products to start on the runtime when the launcher script started the installer on it', async () => {
    const root = tmpDir('echlon-rt-');
    const inside = NODE_AT(root);
    const r = await run({ root, haveMajor: 26, execPath: inside, fetchFn: () => assert.fail('nothing to fetch') });
    assert.deepEqual(r, { major: 26, via: 'system', binDir: path.dirname(inside) });
    const elsewhere = await run({ root, haveMajor: 26, execPath: path.join(tmpDir('echlon-other-'), 'node') });
    assert.deepEqual(elsewhere, { major: 26, via: 'system' }, 'a Node installed the ordinary way is left to the PATH');
  });

  it('downloads the pinned Node, checks it, unpacks it into the profile, and says where', async () => {
    dist.log.length = 0;
    const root = tmpDir('echlon-rt-');
    const said = [];
    const r = await run({ root, log: (l) => said.push(l) });
    assert.equal(r.via, 'runtime');
    assert.equal(r.major, 26);
    assert.equal(r.binDir, runtimeBin(root, pin, KEY, HOST));
    assert.ok(fs.existsSync(NODE_AT(root)));
    assert.deepEqual(dist.log, [ROUTE]);
    assert.ok(said.some((l) => /download its own copy of Node 26\.13\.1/.test(l) && /Nothing on your system is changed/.test(l)));
    assert.ok(said.some((l) => /is ready/.test(l)));
    assert.deepEqual(leftovers(root), [FOLDER], 'no download folder is left behind');
  });

  it('reuses what it already unpacked, and asks nothing and downloads nothing the second time', async () => {
    const root = tmpDir('echlon-rt-');
    await run({ root });
    dist.log.length = 0;
    const again = await run({ root, confirm: () => assert.fail('no question the second time') });
    assert.equal(again.via, 'runtime');
    assert.equal(dist.log.length, 0);
  });

  it('asks first, and downloads nothing when the answer is no', async () => {
    dist.log.length = 0;
    const root = tmpDir('echlon-rt-');
    await assert.rejects(run({ root, confirm: async () => false }), (e) => e instanceof PackError && /cannot run without Node 26/.test(e.message));
    assert.equal(dist.log.length, 0);
    assert.deepEqual(leftovers(root), []);
  });

  it('throws away a download that does not match its pinned checksum, and installs nothing', async () => {
    const root = tmpDir('echlon-rt-');
    const wrong = { version: VERSION, files: { [FILE]: sha(Buffer.from('something else')) } };
    await assert.rejects(run({ root, pin: wrong }), (e) => e instanceof PackError && /did not match its published checksum/.test(e.message));
    assert.deepEqual(leftovers(root), [], 'nothing unpacked, nothing left in the profile');
  });

  it('says plainly when the download is not there or the network is down', async () => {
    await assert.rejects(run({ dist: `${dist.base}/nope` }), (e) => e instanceof PackError && /Could not download Node 26\.13\.1 \(404\)/.test(e.message));
    await assert.rejects(run({ fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }), (e) => e instanceof PackError && /Check the internet connection/.test(e.message));
  });

  it('refuses a platform it has no checksum for, and a pin older than what is needed', async () => {
    await assert.rejects(run({ platform: 'linux', arch: 'riscv64' }), (e) => e instanceof PackError && /no Node to offer for linux-riscv64/.test(e.message));
    await assert.rejects(run({ minMajor: 30 }), (e) => e instanceof PackError && /Get a newer installer/.test(e.message));
  });

  it('refuses an archive that does not hold node, even with the right checksum', async () => {
    const empty = makeArchive({ withNode: false });
    const d = await startDist({ [ROUTE]: empty });
    try {
      const root = tmpDir('echlon-rt-');
      await assert.rejects(run({ root, dist: d.base, pin: { version: VERSION, files: { [FILE]: sha(empty) } } }), (e) => e instanceof PackError && /did not hold the program/.test(e.message));
      assert.deepEqual(leftovers(root), []);
    } finally {
      await d.close();
    }
  });
});
