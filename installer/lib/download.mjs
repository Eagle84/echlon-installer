import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * A response body written to a file, telling `onProgress(received, total)` as the bytes arrive. `total` is the
 * length the server declared, else the size the release listed, else unknown.
 */
export async function saveBody(res, file, onProgress, listedSize) {
  const declared = Number(res.headers?.get?.('content-length'));
  const total = declared > 0 ? declared : listedSize;
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      onProgress?.(received, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(file));
  return received;
}
