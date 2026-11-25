import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
// The two key-wrapping functions are used as kem.encapsulate / kem.decapsulate, never imported by name: they exist only
// on recent Node, and a named import makes this whole module (and the installer that loads it) fail to load on older ones.
// Opening a sealed file needs none of them.
import * as kem from 'node:crypto';
import fs from 'node:fs';

/**
 * Sealed releases: a file encrypted so that a copy of it, wherever it is found, is worthless without the key,
 * and the key is released only by the licence service.
 *
 *   the file   AES-256-GCM in chunks, under a random key made for this release
 *   the key    wrapped to the operator's ML-KEM-768 public key, so whoever builds a release (CI) can seal it and
 *              cannot open it: only the private half, held by the licence service, can unwrap
 *
 * The same file is kept, byte for byte, in the engine (the licence service), the UI release script and the
 * customer installer. Each side uses a different part of it; all of them must agree on the format below.
 *
 * File layout:
 *   "ECHSEAL1"  8 bytes
 *   u32 BE      header length
 *   header      JSON { v, alg, chunk, np (4 random bytes, base64), size (plaintext bytes) }
 *   chunks      for each chunk: ciphertext (up to `chunk` bytes) then its 16-byte tag
 *
 * Chunk i is sealed under nonce np || u64(i), and authenticates sha256(header) || u64(i) || final-flag, so a
 * chunk cannot be moved, repeated, dropped from the end, or carried into another file or header.
 */
export class SealedError extends Error {}

export const MAGIC = Buffer.from('ECHSEAL1');
export const CHUNK = 1 << 20;
const MAX_CHUNK = 16 << 20;
const TAG = 16;
const WRAP_INFO = Buffer.from('echlon-sealed-wrap-v1');

const sha256 = (b) => createHash('sha256').update(b).digest();
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/** A key pair for wrapping. The public half goes to whoever builds releases; the private half stays with the licence service. */
export function generateContentKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ml-kem-768');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** A fresh release key. */
export const newContentKey = () => randomBytes(32);

/** The release key, wrapped so that only the holder of the matching private key can recover it. */
export function wrapKey(publicKeyB64, cek) {
  if (!Buffer.isBuffer(cek) || cek.length !== 32) throw new SealedError('The release key must be 32 bytes.');
  const pub = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), type: 'spki', format: 'der' });
  const { sharedKey, ciphertext } = kem.encapsulate(pub);
  const kek = Buffer.from(hkdfSync('sha256', sharedKey, Buffer.alloc(0), WRAP_INFO, 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  const data = Buffer.concat([c.update(cek), c.final()]);
  return { kem: 'ml-kem-768', ct: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function unwrapKey(privateKeyPem, wrap) {
  try {
    if (!wrap || wrap.kem !== 'ml-kem-768') throw new Error('unknown wrapping');
    const priv = createPrivateKey(privateKeyPem);
    const sharedKey = kem.decapsulate(priv, Buffer.from(wrap.ct, 'base64'));
    const kek = Buffer.from(hkdfSync('sha256', sharedKey, Buffer.alloc(0), WRAP_INFO, 32));
    const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(wrap.iv, 'base64'));
    d.setAuthTag(Buffer.from(wrap.tag, 'base64'));
    const cek = Buffer.concat([d.update(Buffer.from(wrap.data, 'base64')), d.final()]);
    if (cek.length !== 32) throw new Error('wrong length');
    return cek;
  } catch {
    throw new SealedError('The release key could not be unwrapped with this private key.');
  }
}

const aad = (headerDigest, i, final) => Buffer.concat([headerDigest, u64(i), Buffer.from([final ? 1 : 0])]);
const nonce = (np, i) => Buffer.concat([np, u64(i)]);
const chunkCount = (size, chunk) => Math.max(1, Math.ceil(size / chunk));

/** Encrypts `inFile` to `outFile`. Returns the plaintext's size and sha256 and the ciphertext's sha256. */
export async function sealFile(inFile, outFile, cek, { chunk = CHUNK } = {}) {
  if (!Buffer.isBuffer(cek) || cek.length !== 32) throw new SealedError('The release key must be 32 bytes.');
  if (!Number.isInteger(chunk) || chunk < 16 || chunk > MAX_CHUNK) throw new SealedError('The chunk size is out of range.');
  const size = fs.statSync(inFile).size;
  const np = randomBytes(4);
  const header = Buffer.from(JSON.stringify({ v: 1, alg: 'AES-256-GCM-STREAM', chunk, np: np.toString('base64'), size }), 'utf8');
  const digest = sha256(header);
  const lead = Buffer.concat([MAGIC, Buffer.from([(header.length >>> 24) & 255, (header.length >>> 16) & 255, (header.length >>> 8) & 255, header.length & 255]), header]);

  const inH = await fs.promises.open(inFile, 'r');
  const outH = await fs.promises.open(outFile, 'w');
  const plain = createHash('sha256');
  const sealed = createHash('sha256');
  try {
    await outH.write(lead);
    sealed.update(lead);
    const total = chunkCount(size, chunk);
    const buf = Buffer.alloc(chunk);
    let position = 0;
    for (let i = 0; i < total; i++) {
      const want = Math.min(chunk, size - position);
      let got = 0;
      while (got < want) {
        const r = await inH.read(buf, got, want - got, position + got);
        if (r.bytesRead === 0) throw new SealedError('The file ended before its size said it would.');
        got += r.bytesRead;
      }
      position += want;
      const part = buf.subarray(0, want);
      plain.update(part);
      const c = createCipheriv('aes-256-gcm', cek, nonce(np, i));
      c.setAAD(aad(digest, i, i === total - 1));
      const ct = Buffer.concat([c.update(part), c.final(), c.getAuthTag()]);
      await outH.write(ct);
      sealed.update(ct);
    }
  } catch (e) {
    await inH.close();
    await outH.close();
    fs.rmSync(outFile, { force: true });
    throw e;
  }
  await inH.close();
  await outH.close();
  return { size, sha256: plain.digest('hex'), sealedSha256: sealed.digest('hex') };
}

/** Decrypts `inFile` to `outFile`, checking every chunk. A damaged, truncated or extended file is an error and leaves no output. */
export async function openFile(inFile, outFile, cek, { onProgress } = {}) {
  if (!Buffer.isBuffer(cek) || cek.length !== 32) throw new SealedError('The release key must be 32 bytes.');
  const total = fs.statSync(inFile).size;
  const inH = await fs.promises.open(inFile, 'r');
  let outH;
  const fail = async (message) => {
    await inH.close();
    if (outH) await outH.close();
    fs.rmSync(outFile, { force: true });
    throw new SealedError(message);
  };
  try {
    const lead = Buffer.alloc(12);
    const r = await inH.read(lead, 0, 12, 0);
    if (r.bytesRead < 12 || !lead.subarray(0, 8).equals(MAGIC)) return await fail('This is not a sealed file.');
    const hlen = lead.readUInt32BE(8);
    if (hlen < 2 || hlen > 4096 || 12 + hlen > total) return await fail('The sealed file header is damaged.');
    const header = Buffer.alloc(hlen);
    await inH.read(header, 0, hlen, 12);
    let h;
    try {
      h = JSON.parse(header.toString('utf8'));
    } catch {
      return await fail('The sealed file header is damaged.');
    }
    const np = Buffer.from(typeof h?.np === 'string' ? h.np : '', 'base64');
    if (h?.v !== 1 || h.alg !== 'AES-256-GCM-STREAM' || !Number.isInteger(h.chunk) || h.chunk < 16 || h.chunk > MAX_CHUNK || !Number.isInteger(h.size) || h.size < 0 || np.length !== 4) {
      return await fail('The sealed file header is not one this installer understands.');
    }
    const count = chunkCount(h.size, h.chunk);
    const expected = 12 + hlen + h.size + count * TAG;
    if (total !== expected) return await fail('The sealed file is the wrong length: it was cut short or added to.');
    const digest = sha256(header);
    outH = await fs.promises.open(outFile, 'w');
    const plain = createHash('sha256');
    let position = 12 + hlen;
    let done = 0;
    for (let i = 0; i < count; i++) {
      const len = Math.min(h.chunk, h.size - i * h.chunk);
      const buf = Buffer.alloc(len + TAG);
      let got = 0;
      while (got < buf.length) {
        const rd = await inH.read(buf, got, buf.length - got, position + got);
        if (rd.bytesRead === 0) return await fail('The sealed file ended early.');
        got += rd.bytesRead;
      }
      position += buf.length;
      let part;
      try {
        const d = createDecipheriv('aes-256-gcm', cek, nonce(np, i));
        d.setAAD(aad(digest, i, i === count - 1));
        d.setAuthTag(buf.subarray(len));
        part = Buffer.concat([d.update(buf.subarray(0, len)), d.final()]);
      } catch {
        return await fail('The sealed file did not unlock: it is damaged, or the key is not the one it was sealed with.');
      }
      plain.update(part);
      await outH.write(part);
      done += len;
      onProgress?.(done, h.size);
    }
    await inH.close();
    await outH.close();
    return { size: h.size, sha256: plain.digest('hex') };
  } catch (e) {
    if (e instanceof SealedError) throw e;
    await inH.close().catch(() => undefined);
    if (outH) await outH.close().catch(() => undefined);
    fs.rmSync(outFile, { force: true });
    throw new SealedError(`The sealed file could not be read: ${e.message}`);
  }
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

/** What a manifest says about a sealed release: the name and hash of what is inside, and the wrapped key. */
export function sealedMeta({ name, size, sha256: plainSha256, wrap }) {
  return { v: 1, name, size, sha256: plainSha256, wrap };
}

/** The same bytes whatever order the fields were written in, so a signature over its digest is stable. */
export const canonicalSealed = (meta) => JSON.stringify(sortKeys(meta));
export const sealedDigest = (meta) => createHash('sha256').update(canonicalSealed(meta)).digest('hex');

/**
 * The text a release signature covers. A plain release is the three lines it always was, so every older
 * signature still verifies; a sealed one adds a fourth that commits to the sealing details.
 */
export function signedText({ version, url, sha256: digest, sealed }) {
  const lines = [`version=${version}`, `url=${url}`, `sha256=${digest}`];
  if (sealed) lines.push(`sealed=${sealedDigest(sealed)}`);
  return lines.join('\n');
}
