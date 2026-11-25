import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeZip, tmpDir } from './helpers.mjs';

/**
 * install.ps1 on a computer with no Node: it must fetch the pinned runtime, refuse anything that does not match its
 * checksum, and leave nothing half-done. The Node it fetches here is a stand-in file, so the hand-over to the
 * installer at the end cannot run; everything before it can, and is what is checked.
 */
const VERSION = '26.13.1';
const FOLDER = `node-v${VERSION}-win-x64`;
const ROUTE = `/v${VERSION}/${FOLDER}.zip`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const HERE = path.resolve(import.meta.dirname, '..');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const zip = makeZip({ [`${FOLDER}/node.exe`]: 'not really node', [`${FOLDER}/npm.cmd`]: '@echo off' });
let server;
let base;
const served = [];

before(async () => {
  if (process.platform !== 'win32') return;
  server = http.createServer((req, res) => {
    served.push(req.url);
    if (req.url !== ROUTE) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': zip.length }).end(zip);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

// Asynchronous on purpose: this process also serves the download, and a blocked process cannot answer.
const bootstrap = async (checksum, args = ['--yes'], extraEnv = {}) => {
  const root = tmpDir('echlon-boot-');
  const runtime = path.join(tmpDir('echlon-boot-pin-'), 'runtime.txt');
  fs.writeFileSync(runtime, `version=${VERSION}\nwin-x64.zip=${checksum}\nwin-arm64.zip=${checksum}\n`);
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'install.ps1'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    // No Node on the PATH at all: only the folders PowerShell itself needs.
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PATH: path.dirname(POWERSHELL), ECHLON_RUNTIME_FILE: runtime, ECHLON_RUNTIME_ROOT: root, ECHLON_NODE_DIST: base, LOCALAPPDATA: tmpDir('echlon-boot-appdata-'), ...extraEnv },
  });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  const status = await new Promise((resolve) => child.on('close', resolve));
  return { root, text, status, listing: fs.readdirSync(root) };
};

describe('install.ps1 on a computer with no Node', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  it('downloads the pinned Node, checks it, and unpacks it whole into the profile', async () => {
    served.length = 0;
    const r = await bootstrap(sha(zip));
    assert.match(r.text, /download its own copy of Node 26\.13\.1/);
    assert.match(r.text, /Node 26\.13\.1 is ready\./);
    assert.deepEqual(served, [ROUTE]);
    assert.ok(fs.existsSync(path.join(r.root, FOLDER, 'node.exe')));
    assert.deepEqual(r.listing, [FOLDER], 'no download folder is left behind');
  });

  it('refuses a download that does not match its checksum, and leaves nothing behind', async () => {
    const r = await bootstrap(sha(Buffer.from('something else')));
    assert.equal(r.status, 1);
    assert.match(r.text, /did not match its published checksum/);
    assert.deepEqual(r.listing, []);
  });

  it('says plainly when the download is not there', async () => {
    const r = await bootstrap(sha(zip), ['--yes'], { ECHLON_NODE_DIST: `${base}/missing` });
    assert.equal(r.status, 1);
    assert.match(r.text, /Could not download Node 26\.13\.1/);
    assert.deepEqual(r.listing, []);
  });

  it('does not download without a yes, and says how to get Node another way', async () => {
    served.length = 0;
    const r = await bootstrap(sha(zip), []);
    assert.equal(r.status, 1, 'with no one to answer, the question is not a yes');
    assert.deepEqual(served, []);
    assert.deepEqual(r.listing, []);
  });
});
