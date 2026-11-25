import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { newContentKey, sealFile, sealedMeta, signedText } from '../installer/lib/sealed.mjs';

/**
 * What a manifest carries for the wrapped key. The installer never unwraps it (the licence service does, and gives the
 * installer the key), so a stand-in with the right shape is all these tests need. That also keeps them runnable on any
 * Node: making a real one needs ML-KEM, which only recent Node has, and the installer must run on older ones.
 */
const STAND_IN_WRAP = { kem: 'ml-kem-768', ct: 'AAAA', iv: 'AAAA', tag: 'AAAA', data: 'AAAA' };

/** A small zip writer, so tests build real archives with real headers. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function makeZip(files, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const method = deflate && data.length > 0 ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function newKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pubB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

/** latest.json exactly as `scripts/release.mjs sign` in the engine repo writes it. */
export function signedManifest({ version, assetName, artifact, privateKey, tamperSha }) {
  const release = { version, url: `https://github.com/example/releases/download/v${version}/${assetName}`, sha256: tamperSha ?? sha256(artifact) };
  const canonical = [`version=${release.version}`, `url=${release.url}`, `sha256=${release.sha256}`].join('\n');
  return { release, signature: sign(null, Buffer.from(canonical), privateKey).toString('base64') };
}

/**
 * A stand-in for the GitHub API and the storage host behind it. It answers the way GitHub does for a
 * private repository: 401 for a bad key, 404 for a repository the key cannot see, and asset downloads
 * that redirect to a different origin, which is where the key must not follow.
 */
export async function startMock({ tokens, repos }) {
  const log = { api: [], storage: [] };
  const storage = http.createServer((req, res) => {
    log.storage.push({ url: req.url, authorization: req.headers.authorization });
    const [, , repo, id] = req.url.split('/');
    const asset = repos[decodeURIComponent(repo)]?.assets.find((a) => String(a.id) === id);
    if (!asset) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(asset.body);
  });
  await new Promise((r) => storage.listen(0, '127.0.0.1', r));
  const storageBase = `http://127.0.0.1:${storage.address().port}`;

  const api = http.createServer((req, res) => {
    log.api.push({ url: req.url, authorization: req.headers.authorization, accept: req.headers.accept });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const allowed = tokens[token];
    if (!allowed) return res.writeHead(401).end('{}');
    const apiBase = `http://127.0.0.1:${api.address().port}`;
    const rel = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/);
    if (rel) {
      const repo = rel[1];
      if (!allowed.includes(repo) || !repos[repo]) return res.writeHead(404).end('{}');
      const r = repos[repo];
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ tag_name: `v${r.version}`, assets: r.assets.map((a) => ({ id: a.id, name: a.name, size: a.body.length, url: `${apiBase}/repos/${repo}/releases/assets/${a.id}` })) }));
    }
    const asset = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+)$/);
    if (asset) {
      const [, repo, id] = asset;
      if (!allowed.includes(repo)) return res.writeHead(404).end('{}');
      return res.writeHead(302, { location: `${storageBase}/dl/${encodeURIComponent(repo)}/${id}` }).end();
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${api.address().port}`,
    log,
    close: () => Promise.all([new Promise((r) => api.close(r)), new Promise((r) => storage.close(r))]),
  };
}

export const tmpDir = (prefix = 'echlon-pack-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A complete pair of product feeds, signed by `privateKey`. */
export function buildFeeds({ privateKey, uiVersion = '1.0.0', engineVersion = '2.0.0', target = 'linux-x64', uiFiles, tamper = {} }) {
  const uiZip = makeZip(
    uiFiles ?? {
      'echlon-pack.json': JSON.stringify({ name: 'ui', start: { win32: 'start.cmd', posix: 'start.sh' } }),
      'start.cmd': '@echo off\r\necho ui\r\n',
      'start.sh': '#!/bin/sh\necho ui\n',
      'app/server.mjs': 'console.log("ui");\n',
    },
  );
  const engineBin = Buffer.from(`engine-binary-${engineVersion}`);
  const uiName = `echlon-ui-${uiVersion}.zip`;
  const engineName = `echlon-engine-${target}`;
  return {
    'example/ui': {
      version: uiVersion,
      assets: [
        { id: 11, name: uiName, body: tamper.ui ? Buffer.concat([uiZip, Buffer.from('x')]) : uiZip },
        { id: 12, name: 'latest-ui.json', body: Buffer.from(JSON.stringify(signedManifest({ version: uiVersion, assetName: uiName, artifact: uiZip, privateKey: tamper.badSignature ? newKeys().privateKey : privateKey }))) },
      ],
    },
    'example/engine': {
      version: engineVersion,
      assets: [
        { id: 21, name: engineName, body: tamper.engine ? Buffer.from('tampered') : engineBin },
        { id: 22, name: `latest-${target}.json`, body: Buffer.from(JSON.stringify(signedManifest({ version: engineVersion, assetName: engineName, artifact: engineBin, privateKey }))) },
      ],
    },
  };
}

export function writeConfig(dir, pubB64) {
  const products = path.join(dir, 'products.json');
  fs.writeFileSync(
    products,
    JSON.stringify({
      ui: { name: 'Echlon UI', repo: 'example/ui', manifest: 'latest-ui.json' },
      engine: { name: 'Echlon Engine', repo: 'example/engine', manifest: 'latest-{target}.json' },
    }),
  );
  const pubkey = path.join(dir, 'release-pubkey.txt');
  fs.writeFileSync(pubkey, `${pubB64}\n`);
  return { products, pubkey };
}

export function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * A stand-in for the Echlon download service. It follows the contract of `POST /v1/download` in the engine
 * repo: 403 `{state}` for a key that may not have the product, otherwise the signed manifest and a short-lived
 * address for the file on a separate storage host, which must be fetched with no credential.
 */
export async function startService({ licences, repos, unavailable = false, tamperArtifactName = false, contentKeys = {}, withholdKey = false, wrongKey = false }) {
  const log = { service: [], storage: [] };
  const assets = Object.values(repos).flatMap((r) => r.assets);
  const storage = http.createServer((req, res) => {
    log.storage.push({ url: req.url, authorization: req.headers.authorization });
    const asset = assets.find((a) => `/dl/${a.id}` === req.url.split('?')[0]);
    if (!asset) return res.writeHead(404).end();
    res.writeHead(200).end(asset.body);
  });
  await new Promise((r) => storage.listen(0, '127.0.0.1', r));
  const storageBase = `http://127.0.0.1:${storage.address().port}`;
  const feeds = { ui: { repo: 'example/ui', manifest: () => 'latest-ui.json' }, engine: { repo: 'example/engine', manifest: (t) => `latest-${t}.json` } };

  const service = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      log.service.push({ url: req.url, method: req.method, body });
      const send = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
      if (req.url !== '/v1/download' || req.method !== 'POST') return send(404, {});
      if (unavailable) return send(503, { error: 'x' });
      const licence = licences[body.key];
      if (!licence) return send(403, { state: 'unknown' });
      if (licence.state) return send(403, { state: licence.state });
      if (!licence.products.includes(body.product)) return send(403, { state: 'product' });
      const feed = feeds[body.product];
      const repo = repos[feed.repo];
      const manifest = repo.assets.find((a) => a.name === feed.manifest(body.target ?? ''));
      if (!manifest) return send(404, { error: 'no release' });
      const parsed = JSON.parse(manifest.body.toString());
      const name = decodeURIComponent(parsed.release.url.split('/').pop());
      const artifact = repo.assets.find((a) => a.name === name);
      const key = parsed.release.sealed && !withholdKey ? (wrongKey ? Buffer.alloc(32, 9) : contentKeys[body.product]) : undefined;
      send(200, { product: body.product, version: parsed.release.version, manifest: parsed, artifact: { name: tamperArtifactName ? 'other.zip' : artifact.name, size: artifact.body.length, url: `${storageBase}/dl/${artifact.id}?sig=short-lived` }, ...(key ? { contentKey: key.toString('base64') } : {}) });
    });
  });
  await new Promise((r) => service.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${service.address().port}`,
    log,
    close: () => Promise.all([new Promise((r) => service.close(r)), new Promise((r) => storage.close(r))]),
  };
}

/**
 * A stand-in for this computer's AI tools: an empty home folder, no tool on PATH, and no command that can run.
 * Anything that reached for the real home folder would be writing to the person running the tests.
 */
/** Stands in for putting the install folder on the PATH, which a test must never do to the machine it runs on. */
export const noPath = () => 'PATH left alone (test)';

export function sandboxHosts(overrides = {}) {
  const home = tmpDir('echlon-home-');
  return {
    platform: process.platform,
    env: { PATH: '' },
    home,
    appdata: path.join(home, 'AppData', 'Roaming'),
    which: () => undefined,
    exec: async () => ({ code: 1, out: 'no commands run in tests' }),
    now: () => new Date('2026-11-25T12:00:00Z'),
    ...overrides,
  };
}

/**
 * A release published the way the release script does: the artifact encrypted, its key wrapped to a content key
 * pair, the manifest signed over the sealing details. `damage` makes the one thing a test wants to be wrong.
 */
export async function sealedRelease({ product, version, plainName, plainBody, assetName, manifestName, privateKey, damage = {} }) {
  const work = tmpDir('echlon-seal-');
  const plainFile = path.join(work, plainName);
  fs.writeFileSync(plainFile, plainBody);
  const sealedFile = path.join(work, assetName);
  const cek = newContentKey();
  const made = await sealFile(plainFile, sealedFile, cek, { chunk: 4096 });
  let body = fs.readFileSync(sealedFile);
  const meta = sealedMeta({ name: damage.sealedName ?? plainName, size: made.size, sha256: damage.innerSha ?? made.sha256, wrap: STAND_IN_WRAP });
  const release = { version, url: `https://github.com/example/releases/download/v${version}/${assetName}`, sha256: made.sealedSha256, sealed: meta };
  const manifest = { release, signature: sign(null, Buffer.from(signedText(release)), privateKey).toString('base64') };
  if (damage.afterSigning) damage.afterSigning(manifest);
  if (damage.flipByte !== undefined) {
    body = Buffer.from(body);
    body[damage.flipByte] ^= 1;
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { cek, assets: [{ id: damage.idBase ?? 40, name: assetName, body }, { id: (damage.idBase ?? 40) + 1, name: manifestName, body: Buffer.from(JSON.stringify(manifest)) }], product };
}

/** Both products sealed. Returns the feeds and the keys a service would release for them. */
export async function buildSealedFeeds({ privateKey, target = 'linux-x64', uiFiles, uiDamage, engineDamage, enginePackage }) {
  const uiZip = makeZip(
    uiFiles ?? {
      'echlon-pack.json': JSON.stringify({ name: 'ui', start: { win32: 'start.cmd', posix: 'start.sh' } }),
      'start.cmd': '@echo off\r\n',
      'start.sh': '#!/bin/sh\n',
      'app/server.mjs': 'console.log("SECRET-UI-LOGIC");\n',
    },
  );
  const ui = await sealedRelease({ product: 'ui', version: '1.0.0', plainName: 'echlon-ui-1.0.0.zip', plainBody: uiZip, assetName: 'echlon-ui-1.0.0.zip.sealed', manifestName: 'latest-ui.json', privateKey, damage: { idBase: 40, ...uiDamage } });
  const engineBin = Buffer.from(`SECRET-ENGINE-BINARY-${'x'.repeat(10000)}`);
  // An engine can be one file (the old shape) or a package: a zip of the program and what sits beside it, with a pack
  // manifest naming the program to run. `enginePackage` is the manifest's fields (overridable), plus extra files.
  const pkg = enginePackage
    ? makeZip({
        'echlon.exe': engineBin,
        echlon: engineBin,
        'rule-bank/a.json': '{"rule":1}',
        'echlon-pack.json': JSON.stringify({ name: 'engine', version: '2.0.0', target, licensed: true, exe: { win32: 'echlon.exe', posix: 'echlon' }, requires: {}, ...enginePackage.pack }),
        ...enginePackage.files,
      })
    : undefined;
  const engine = pkg
    ? await sealedRelease({ product: 'engine', version: '2.0.0', plainName: `echlon-engine-2.0.0-${target}.zip`, plainBody: pkg, assetName: `echlon-engine-2.0.0-${target}.zip.sealed`, manifestName: `latest-${target}.json`, privateKey, damage: { idBase: 50, ...engineDamage } })
    : await sealedRelease({ product: 'engine', version: '2.0.0', plainName: `echlon-engine-${target}`, plainBody: engineBin, assetName: `echlon-engine-${target}.sealed`, manifestName: `latest-${target}.json`, privateKey, damage: { idBase: 50, ...engineDamage } });
  return { repos: { 'example/ui': { version: '1.0.0', assets: ui.assets }, 'example/engine': { version: '2.0.0', assets: engine.assets } }, contentKeys: { ui: ui.cek, engine: engine.cek }, uiZip, engineBin };
}
