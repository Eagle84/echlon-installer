import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import { PackError } from './errors.mjs';

/**
 * What a release is signed over: the same three lines `scripts/release.mjs sign` writes in the engine
 * repo. The signature covers the sha256 of the artifact rather than the artifact, so checking a few
 * hundred bytes of JSON and then the hash covers the whole download.
 */
export const canonical = (release) => [`version=${release.version}`, `url=${release.url}`, `sha256=${release.sha256}`].join('\n');

const PLACEHOLDER = /REPLACE|^\s*$/i;

export function publicKeyFrom(base64Spki) {
  if (!base64Spki || PLACEHOLDER.test(base64Spki)) {
    throw new PackError('This pack has no release key in it yet, so nothing it downloads can be verified. Get a current copy of the pack.');
  }
  try {
    return createPublicKey({ key: Buffer.from(base64Spki.trim(), 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new PackError('The release key in this pack is not readable. Get a current copy of the pack.');
  }
}

/** The release inside a manifest, once its signature checks out. Anything else is refused. */
export function verifyManifest(manifest, base64Spki) {
  const r = manifest?.release;
  if (!r || [r.version, r.url, r.sha256].some((v) => typeof v !== 'string' || !v) || typeof manifest.signature !== 'string') {
    throw new PackError('The release information is incomplete, so it was not installed.');
  }
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonical(r)), publicKeyFrom(base64Spki), Buffer.from(manifest.signature, 'base64'));
  } catch (e) {
    if (e instanceof PackError) throw e;
  }
  if (!ok) throw new PackError('The release signature does not match, so it was not installed. Nothing was changed.');
  return r;
}

export async function sha256OfFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}
