import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PackError } from './errors.mjs';

export const LICENCE_KEY_PREFIX = 'ech_lic_';
export const isLicenceKey = (key) => typeof key === 'string' && key.startsWith(LICENCE_KEY_PREFIX);

const loopbackHost = (h) => ['127.0.0.1', 'localhost', '[::1]'].includes(h);

/**
 * The licence key is sent only to the service address the pack was built with. A different address is
 * accepted only for a test on this machine (plain http to loopback), so nothing typed or in the environment
 * can point a customer's key at somebody else's server.
 */
export function checkServiceUrl(url, shipped) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new PackError('The download service address is not valid.');
  }
  const same = shipped && u.origin === new URL(shipped).origin;
  if (u.protocol === 'https:' && same) return u.origin;
  if (u.protocol === 'http:' && loopbackHost(u.hostname)) return u.origin;
  throw new PackError('The licence key is only ever sent to the Echlon download service. A different address is refused.');
}

const REFUSED = {
  unknown: () => 'The access key was not recognised. Check it and try again.',
  revoked: () => 'This access key has been withdrawn. Contact Echlon.',
  suspended: () => 'This licence is suspended. Contact Echlon.',
  expired: () => 'This licence has ended. Contact Echlon to renew it.',
  product: (name) => `This access key is not for ${name}.`,
};

/**
 * A release read through the Echlon download service with a licence key. The service decides whether the key
 * may have the product and answers with the signed manifest and a short-lived address for the file; the file
 * is fetched with no credential, so the key goes to the service and nowhere else.
 */
export class ServiceFeed {
  constructor({ key, url, shipped = url, fetchImpl = fetch }) {
    if (!key) throw new PackError('No access key was given.');
    this.key = key;
    this.base = checkServiceUrl(url, shipped);
    this.fetch = fetchImpl;
  }

  async release({ id, def, target }) {
    let res;
    try {
      res = await this.fetch(`${this.base}/v1/download`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'echlon-customer-pack' },
        body: JSON.stringify({ key: this.key, product: id, ...(id === 'engine' ? { target } : {}) }),
      });
    } catch {
      throw new PackError('Could not reach the Echlon download service. Check the internet connection and try again.');
    }
    if (res.status === 403) {
      const state = (await res.json().catch(() => ({}))).state;
      throw new PackError((REFUSED[state] ?? REFUSED.unknown)(def.name));
    }
    if (res.status === 429) throw new PackError('Too many attempts. Wait a few minutes and try again.');
    if (res.status === 404) throw new PackError(`No build of ${def.name} for this computer (${target}) has been published yet.`);
    if (res.status === 400) throw new PackError('The download service did not accept the request.');
    if (!res.ok) throw new PackError('The Echlon download service is not available right now. Try again later.');
    const body = await res.json().catch(() => null);
    if (!body?.manifest || !body?.artifact?.url || !body?.artifact?.name) throw new PackError('The download service gave an answer that could not be read.');
    const { manifest, artifact } = body;
    return {
      manifest,
      artifactFor: (name) => (name === artifact.name ? { save: (file) => this.save(artifact.url, file, def.name) } : null),
    };
  }

  /** The file, from the address the service gave. No credential is sent: the address is the credential. */
  async save(url, file, what) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopbackHost(u.hostname))) throw new PackError('The download service gave an insecure address, so nothing was downloaded.');
    let res;
    try {
      res = await this.fetch(url, { redirect: 'follow' });
    } catch {
      throw new PackError('Could not reach the download. Check the internet connection and try again.');
    }
    if (!res.ok || !res.body) throw new PackError(`The download of ${what} failed (HTTP ${res.status}). The link may have expired; try again.`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  }
}
