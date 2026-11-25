#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackError } from './lib/errors.mjs';
import { Feed, GITHUB_API } from './lib/feed.mjs';
import { installProduct } from './lib/product.mjs';
import { ask, askHidden } from './lib/prompt.mjs';
import { checkInstallDir, engineLauncher, newEngineToken, uiLauncher, writeLauncher, writeUiSettings } from './lib/wire.mjs';

/**
 * The customer pack installer. It asks what to install, asks for the access key, and installs the
 * signed builds that key is allowed to download. It never clones source: what the customer receives
 * is a built, verified artifact.
 *
 * The access key is read without being shown, is held only in memory for this run, is sent only to
 * the feed host, and is not written to disk or printed.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIN_NODE = 20;

export function parseArgs(argv) {
  const out = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (['--product', '--dir', '--api', '--target', '--token-env', '--ui-key-env', '--engine-key-env', '--products', '--pubkey'].includes(a)) out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new PackError(`Unknown option ${a}.`);
  }
  return out;
}

const MENU = [
  ['1', 'ui', 'Echlon UI'],
  ['2', 'engine', 'Echlon Engine'],
  ['3', 'both', 'Both (the full ecosystem)'],
];

export const targetOf = () => `${process.platform}-${process.arch}`;

/** A typed folder as an absolute path; `~` means the home folder. */
export const folderOf = (typed, home = os.homedir()) => path.resolve(/^~(?=$|[\\/])/.test(typed) ? path.join(home, typed.slice(1)) : typed);

export async function run(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), askFn = ask, askSecret = askHidden, nodeMajor, runCommand } = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) throw new PackError(`Node ${MIN_NODE} or newer is needed (this is ${process.versions.node}).`);

  const args = parseArgs(argv);
  const products = JSON.parse(fs.readFileSync(args.products ?? path.join(ROOT, 'products.json'), 'utf8'));
  const pubkey = fs.readFileSync(args.pubkey ?? path.join(ROOT, 'release-pubkey.txt'), 'utf8');

  out('');
  out('Echlon customer pack');
  out('--------------------');
  let choice = args.product;
  if (!choice) {
    for (const [n, , label] of MENU) out(`  ${n}) ${label}`);
    out('  4) Quit');
    const n = await askFn('Choose 1-4: ');
    if (n === '4' || n === '') return 0;
    choice = MENU.find(([k]) => k === n)?.[1];
    if (!choice) throw new PackError('Please choose 1, 2, 3 or 4.');
  }
  if (!['ui', 'engine', 'both'].includes(choice)) throw new PackError('The product must be ui, engine or both.');
  const wanted = choice === 'both' ? ['ui', 'engine'] : [choice];

  // Where to install comes before the key: nothing is asked of GitHub until the customer has said where it goes.
  let dir = args.dir;
  if (!dir) {
    const fallback = path.join(os.homedir(), 'Echlon');
    const typed = await askFn(`Install folder (Enter for ${fallback}): `);
    dir = typed || fallback;
  }
  dir = folderOf(dir);
  checkInstallDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  out(`Installing into ${dir}`);

  // One key may cover both products, or each product may have its own. A key named on the command line
  // (by environment variable) wins; otherwise it is typed, hidden.
  const fromEnv = (name) => (name ? env[name] : undefined) || undefined;
  const keys = {
    ui: fromEnv(args.uiKeyEnv) ?? fromEnv(args.tokenEnv),
    engine: fromEnv(args.engineKeyEnv) ?? fromEnv(args.tokenEnv),
  };
  const missing = wanted.filter((id) => !keys[id]);
  if (missing.length === 2) {
    const same = ((await askFn('One access key for both? (Y/n): ')) || 'y').toLowerCase().startsWith('y');
    if (same) keys.ui = keys.engine = await askSecret('Access key (not shown as you type): ');
  }
  for (const id of wanted) {
    if (!keys[id]) keys[id] = await askSecret(`${products[id].name} access key (not shown as you type): `);
    if (!keys[id]) throw new PackError(`An access key is needed for ${products[id].name}. Without it nothing can be installed.`);
  }

  if (wanted.some((id) => keys[id].startsWith('ech_lic_'))) {
    throw new PackError(
      'That is an Echlon licence key. It licenses the software once it is installed, but it cannot download it: the installer needs the download key sent with it (a read-only GitHub token starting ghp_ or github_pat_). Nothing was installed.',
    );
  }

  const target = args.target ?? targetOf();
  const installed = {};
  const failures = [];
  const feeds = Object.fromEntries(wanted.map((id) => [id, new Feed({ token: keys[id], apiBase: args.api ?? GITHUB_API })]));
  for (const id of wanted) {
    try {
      installed[id] = await installProduct({ id, def: products[id], feed: feeds[id], dir, target, pubkey, log: out, nodeMajor, runCommand });
    } catch (e) {
      if (!(e instanceof PackError)) throw e;
      failures.push(`${products[id].name}: ${e.message}`);
    }
  }

  // The two halves are joined here, so the customer never sees or types the engine's token.
  const engineToken = installed.engine ? newEngineToken() : undefined;
  const platform = process.platform;
  if (installed.engine) {
    const e = installed.engine;
    const launcher = writeLauncher(dir, engineLauncher({ platform, installDir: dir, exeRelative: path.join('engine', e.version, e.file), token: engineToken }));
    out(`Start the engine with: ${launcher}`);
  }
  if (installed.ui) {
    const u = installed.ui;
    const dataDir = path.join(dir, 'ui', 'data');
    if (engineToken) writeUiSettings(dataDir, engineToken);
    const start = u.pack?.start?.[platform === 'win32' ? 'win32' : 'posix'];
    if (start) {
      const launcher = writeLauncher(dir, uiLauncher({ platform, versionDir: u.dest, startRelative: start, dataDir }));
      out(`Start the UI with: ${launcher}`);
    } else {
      out(`The UI is in ${u.dest}.`);
    }
    if (engineToken) out('The UI is set up to use the engine.');
  }
  for (const f of failures) out(`Not installed - ${f}`);
  if (failures.length === wanted.length) out('Nothing was installed.');
  else if (!failures.length) out('Done.');
  return failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof PackError ? e.message : `Something went wrong: ${e.message}`);
      process.exit(1);
    });
}
