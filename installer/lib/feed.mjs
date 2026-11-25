import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PackError } from './errors.mjs';

export const GITHUB_API = 'https://api.github.com';

/**
 * The key is sent only to the API host the pack was built for. A different host is accepted only for a
 * test on this machine (loopback), so nothing in the environment or on the command line can point the
 * key at somebody else's server.
 */
export function checkApiBase(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new PackError('The feed address is not valid.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (base.replace(/\/+$/, '') === GITHUB_API) return GITHUB_API;
  if (loopback && u.protocol === 'http:') return base.replace(/\/+$/, '');
  throw new PackError('The key is only ever sent to api.github.com. A different feed address is refused.');
}

/** A private release feed on GitHub, read with one access key. */
export class Feed {
  constructor({ token, apiBase = GITHUB_API, fetchImpl = fetch }) {
    if (!token) throw new PackError('No access key was given.');
    this.token = token;
    this.base = checkApiBase(apiBase);
    this.fetch = fetchImpl;
  }

  headers(accept) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'echlon-customer-pack',
    };
  }

  async request(url, accept, what) {
    let res;
    try {
      res = await this.fetch(url, { headers: this.headers(accept), redirect: 'follow' });
    } catch {
      throw new PackError('Could not reach GitHub. Check the internet connection and try again.');
    }
    if (res.status === 401) throw new PackError('The access key was not accepted. Check it and try again.');
    // GitHub answers 404, not 403, for a private repository the key cannot see.
    if (res.status === 404) throw new PackError(`This key does not include ${what}.`);
    if (res.status === 403 || res.status === 429) throw new PackError('GitHub refused the request (a limit was reached, or the key has no access). Wait a few minutes and try again.');
    if (!res.ok) throw new PackError(`GitHub answered with an error (HTTP ${res.status}).`);
    return res;
  }

  /** The newest release of a repository: its tag and its assets. */
  async latest(repo, what) {
    const res = await this.request(`${this.base}/repos/${repo}/releases/latest`, 'application/vnd.github+json', what);
    const body = await res.json();
    if (!Array.isArray(body.assets)) throw new PackError(`The feed for ${what} has no release yet.`);
    return { tag: body.tag_name, assets: body.assets.map((a) => ({ id: a.id, name: a.name, size: a.size, url: a.url })) };
  }

  async json(asset, what) {
    const res = await this.request(asset.url, 'application/octet-stream', what);
    try {
      return JSON.parse(await res.text());
    } catch {
      throw new PackError('The release information could not be read.');
    }
  }

  async download(asset, destFile, what) {
    const res = await this.request(asset.url, 'application/octet-stream', what);
    if (!res.body) throw new PackError('The download was empty.');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destFile));
  }
}
