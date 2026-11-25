import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { tmpDir } from './helpers.mjs';

/**
 * install.sh on a computer with no Node: it must fetch the pinned runtime, refuse anything that does not match its
 * checksum, leave nothing half-done, and hand over to the Node it fetched. The Node here is a shell script that says
 * what it was asked to run, so the hand-over itself can be seen.
 */
const VERSION = '26.13.1';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const PLAT = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${ARCH}`;
const FOLDER = `node-v${VERSION}-${PLAT}`;
const ROUTE = `/v${VERSION}/${FOLDER}.tar.gz`;
const HERE = path.resolve(import.meta.dirname, '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const usable = process.platform !== 'win32' && (() => { try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

let archive;
let server;
let base;
const served = [];

before(async () => {
  if (!usable) return;
  const src = tmpDir('echlon-sh-src-');
  const bin = path.join(src, FOLDER, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho "fake node ran: $*"\n', { mode: 0o755 });
  const file = path.join(tmpDir('echlon-sh-tar-'), 'a.tar.gz');
  execFileSync('tar', ['-czf', file, '-C', src, FOLDER]);
  archive = fs.readFileSync(file);
  server = http.createServer((req, res) => {
    served.push(req.url);
    if (req.url !== ROUTE) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': archive.length }).end(archive);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

// Asynchronous on purpose: this process also serves the download, and a blocked process cannot answer.
const bootstrap = async (checksum, args = ['--yes'], extraEnv = {}) => {
  const root = tmpDir('echlon-sh-root-');
  const pin = path.join(tmpDir('echlon-sh-pin-'), 'runtime.txt');
  // Windows line endings on purpose: a file edited on Windows must still be read right.
  fs.writeFileSync(pin, `version=${VERSION}\r\n${PLAT}.tar.gz=${checksum}\r\n`);
  // A PATH with the basic tools and no node.
  const tools = tmpDir('echlon-sh-tools-');
  for (const t of ['sh', 'dirname', 'sed', 'tr', 'head', 'cut', 'uname', 'tar', 'gzip', 'mktemp', 'rm', 'mv', 'mkdir', 'curl', 'wget', 'sha256sum', 'shasum', 'openssl', 'cat', 'read', 'printf']) {
    try {
      const where = execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
      if (where.startsWith('/')) fs.symlinkSync(where, path.join(tools, t));
    } catch { /* not every tool exists everywhere */ }
  }
  const child = spawn('/bin/sh', [path.join(HERE, 'install.sh'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    env: { PATH: tools, HOME: tmpDir('echlon-sh-home-'), ECHLON_RUNTIME_FILE: pin, ECHLON_RUNTIME_ROOT: root, ECHLON_NODE_DIST: base, ...extraEnv },
  });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  const status = await new Promise((resolve) => child.on('close', resolve));
  return { root, text, status, listing: fs.readdirSync(root) };
};

describe('install.sh on a computer with no Node', { skip: !usable && 'needs a Unix-like system with tar' }, () => {
  it('downloads the pinned Node, checks it, unpacks it whole into the profile, and runs the installer on it', async () => {
    served.length = 0;
    const r = await bootstrap(sha(archive));
    assert.match(r.text, /download its own copy of Node 26\.13\.1/);
    assert.match(r.text, /Node 26\.13\.1 is ready\./);
    assert.match(r.text, /fake node ran: .*installer\/install\.mjs --yes/, 'the installer was started on the downloaded Node, with the arguments given');
    assert.deepEqual(served, [ROUTE]);
    assert.deepEqual(r.listing, [FOLDER], 'no download folder is left behind');
  });

  it('refuses a download that does not match its checksum, and leaves nothing behind', async () => {
    const r = await bootstrap(sha(Buffer.from('something else')));
    assert.equal(r.status, 1);
    assert.match(r.text, /did not match its published checksum/);
    assert.ok(!/fake node ran/.test(r.text));
    assert.deepEqual(r.listing, []);
  });

  it('says plainly when the download is not there', async () => {
    const r = await bootstrap(sha(archive), ['--yes'], { ECHLON_NODE_DIST: `${base}/missing` });
    assert.equal(r.status, 1);
    assert.match(r.text, /Could not download Node 26\.13\.1/);
    assert.deepEqual(r.listing, []);
  });

  it('does not download without a yes', async () => {
    served.length = 0;
    const r = await bootstrap(sha(archive), []);
    assert.equal(r.status, 1);
    assert.deepEqual(served, []);
    assert.deepEqual(r.listing, []);
  });
});
