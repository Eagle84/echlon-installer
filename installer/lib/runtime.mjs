import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PackError } from './errors.mjs';
import { saveBody } from './download.mjs';
import { quietProgress } from './progress.mjs';
import { extractZip } from './zip.mjs';

/**
 * The Node runtime Echlon brings with it when a computer has none that is new enough (the UI needs a newer Node than
 * most computers have). It is one pinned release, checked against a SHA-256 written in runtime.txt, put in a folder
 * of its own in the person's profile. Nothing system-wide changes: no PATH entry, no installer run, no administrator.
 * The products that need it are told exactly where it is.
 */
export const DEFAULT_DIST = 'https://nodejs.org/dist';

/** `version=...` and `<platform>-<arch>.<ext>=<sha256>` lines; anything else (comments) is ignored. */
export function parseRuntime(text) {
  const pin = { version: undefined, files: {} };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'version') pin.version = value;
    else if (/^[a-z]+-[a-z0-9]+\.(zip|tar\.gz)$/.test(key) && /^[0-9a-f]{64}$/.test(value)) pin.files[key] = value;
  }
  if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? '')) throw new PackError('runtime.txt does not name a Node version.');
  return pin;
}

/** Node's own name for the platform: win, linux or darwin, and x64 or arm64. */
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform === 'win32' ? 'win' : platform}-${arch}`;

export const archiveName = (pin, key) => `node-v${pin.version}-${key}.${key.startsWith('win') ? 'zip' : 'tar.gz'}`;

/** Where the private runtime lives: the person's own profile, shared by every install of theirs. */
export function runtimeRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.ECHLON_RUNTIME_ROOT) return env.ECHLON_RUNTIME_ROOT;
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Echlon', 'runtime');
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'echlon', 'runtime');
}

/** The folder with `node` (and `npm`) in it, once the runtime is unpacked. */
export function runtimeBin(root, pin, key, platform = process.platform) {
  const base = (platform === 'win32' ? path.win32 : path.posix).join(root, `node-v${pin.version}-${key}`);
  return platform === 'win32' ? base : path.posix.join(base, 'bin');
}

const nodeFileIn = (bin, platform) => (platform === 'win32' ? path.win32.join(bin, 'node.exe') : path.posix.join(bin, 'node'));

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * A Node at least `minMajor`: the one this computer already has when it is new enough, otherwise the pinned private
 * runtime, downloaded and unpacked first if it is not there yet. Returns `{ major, binDir, via }`; `binDir` is
 * undefined when the computer's own Node is used. `confirm()` is asked before anything is downloaded.
 */
export async function ensureNode({
  minMajor,
  haveMajor = Number(process.versions.node.split('.')[0]),
  pin,
  platform = process.platform,
  arch = process.arch,
  root = runtimeRoot({ platform }),
  dist = process.env.ECHLON_NODE_DIST || DEFAULT_DIST,
  execPath = process.execPath,
  fetchFn = fetch,
  progress = quietProgress,
  log = () => {},
  confirm = async () => true,
  extract,
  name = 'Echlon',
}) {
  if (haveMajor >= minMajor) {
    // The launcher script may have started this installer on the runtime it downloaded; the products must be started on it too.
    const inside = path.relative(root, execPath);
    const onRuntime = inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside);
    return { major: haveMajor, via: 'system', ...(onRuntime ? { binDir: path.dirname(execPath) } : {}) };
  }

  const key = platformKey(platform, arch);
  const expected = pin.files[archiveName(pin, key).replace(`node-v${pin.version}-`, '')];
  const pinnedMajor = Number(pin.version.split('.')[0]);
  const bin = runtimeBin(root, pin, key, platform);
  if (fs.existsSync(nodeFileIn(bin, platform))) return { major: pinnedMajor, binDir: bin, via: 'runtime' };

  if (!expected) throw new PackError(`${name} needs Node ${minMajor} or newer, and Echlon has no Node to offer for ${key}. Install Node ${minMajor} or newer from https://nodejs.org and run the installer again.`);
  if (pinnedMajor < minMajor) throw new PackError(`${name} needs Node ${minMajor} or newer, but the Node this installer carries is ${pin.version}. Get a newer installer.`);

  log(`This computer has Node ${haveMajor}; ${name} needs Node ${minMajor} or newer.`);
  log(`Echlon will download its own copy of Node ${pin.version} (about 30 MB) into ${root}. Nothing on your system is changed.`);
  if (!(await confirm())) throw new PackError(`${name} cannot run without Node ${minMajor} or newer, so it was not installed. Install Node from https://nodejs.org and run the installer again.`);

  fs.mkdirSync(root, { recursive: true });
  const work = fs.mkdtempSync(path.join(root, '.download-'));
  try {
    const file = path.join(work, archiveName(pin, key));
    const url = `${dist.replace(/\/+$/, '')}/v${pin.version}/${archiveName(pin, key)}`;
    const bar = progress.start(`Node ${pin.version}`);
    let res;
    try {
      res = await fetchFn(url);
    } catch (e) {
      throw new PackError(`Could not download Node ${pin.version} (${String(e.message).split('\n')[0]}). Check the internet connection and try again.`);
    }
    if (!res.ok) throw new PackError(`Could not download Node ${pin.version} (${res.status}). Check the internet connection and try again.`);
    await saveBody(res, file, bar.update);
    bar.finish();
    if (sha256File(file) !== expected) throw new PackError(`The Node download did not match its published checksum, so it was thrown away and nothing was installed. Try again; if it keeps happening, install Node ${minMajor} or newer from https://nodejs.org.`);

    log(`Unpacking Node ${pin.version}`);
    const into = path.join(work, 'x');
    fs.mkdirSync(into);
    if (extract) await extract(file, into);
    else if (key.startsWith('win')) extractZip(file, into);
    else execFileSync('tar', ['-xzf', file, '-C', into], { stdio: 'ignore' });
    const unpacked = path.join(into, `node-v${pin.version}-${key}`);
    if (!fs.existsSync(nodeFileIn(platform === 'win32' ? unpacked : path.join(unpacked, 'bin'), platform))) throw new PackError('The Node download did not hold the program it should, so nothing was installed.');
    // The whole folder arrives in one step, so a half-unpacked runtime is never mistaken for a finished one.
    fs.rmSync(path.join(root, `node-v${pin.version}-${key}`), { recursive: true, force: true });
    fs.renameSync(unpacked, path.join(root, `node-v${pin.version}-${key}`));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  log(`Node ${pin.version} is ready.`);
  return { major: pinnedMajor, binDir: bin, via: 'runtime' };
}
