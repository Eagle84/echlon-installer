import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { PackError } from './errors.mjs';

/**
 * A zip reader with no dependency, for the one job here: unpacking a release into a folder. It reads
 * the central directory (the only reliable index), supports stored and deflated entries, and refuses
 * anything that would write outside the folder. Zip64 and encryption are refused, not guessed at.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The checksum a zip stores for each file. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

export function listZip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      e = i;
      break;
    }
  }
  if (e < 0) throw new PackError('The download is not a valid archive.');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (count === 0xffff || p === 0xffffffff) throw new PackError('The archive is too large for this installer (zip64).');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN) throw new PackError('The archive index is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (flags & 1) throw new PackError('The archive is encrypted, which this installer does not support.');
    entries.push({ name, method, crc, csize, size, offset, dir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

/** Where an entry lands, refused if it would leave the folder (a name such as ../x or an absolute path). */
export function safeTarget(root, name) {
  const clean = name.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) throw new PackError(`The archive names an unsafe path (${name}), so it was not installed.`);
  const target = path.resolve(root, clean);
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PackError(`The archive names an unsafe path (${name}), so it was not installed.`);
  return target;
}

export function extractZip(file, destDir) {
  const buf = fs.readFileSync(file);
  const entries = listZip(buf);
  // Check every path before writing anything, so a bad archive leaves nothing behind.
  const targets = entries.map((en) => safeTarget(destDir, en.name));
  fs.mkdirSync(destDir, { recursive: true });
  entries.forEach((en, i) => {
    const target = targets[i];
    if (en.dir) {
      fs.mkdirSync(target, { recursive: true });
      return;
    }
    if (buf.readUInt32LE(en.offset) !== LOC) throw new PackError('The archive is damaged.');
    const start = en.offset + 30 + buf.readUInt16LE(en.offset + 26) + buf.readUInt16LE(en.offset + 28);
    const raw = buf.subarray(start, start + en.csize);
    let data;
    if (en.method === 0) data = raw;
    else if (en.method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch {
        throw new PackError('The archive is damaged (a file could not be unpacked).');
      }
    } else throw new PackError('The archive uses a compression this installer does not support.');
    if (data.length !== en.size || crc32(data) !== en.crc) throw new PackError('The archive is damaged (a file does not match its checksum).');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  });
  return entries.filter((en) => !en.dir).map((en) => en.name);
}
