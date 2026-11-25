#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackError } from './lib/errors.mjs';
import { Feed, GITHUB_API } from './lib/feed.mjs';
import { installProduct } from './lib/product.mjs';
import { ask, askHidden } from './lib/prompt.mjs';
import { engineLauncher, newEngineToken, uiLauncher, writeLauncher, writeUiSettings } from './lib/wire.mjs';

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
    else if (['--product', '--dir', '--api', '--target', '--token-env', '--products', '--pubkey'].includes(a)) out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
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

export async function run(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), askFn = ask, askSecret = askHidden } = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) throw new PackError(`Node ${MIN_NODE} or newer is needed (this is ${process.versions.node}).`);

  const args = parseArgs(argv);
  const products = JSON.parse(fs.readFileSync(args.products ?? path.join(ROOT, 'products.json'), 'utf8'));
  const pubkey = fs.readFileSync(args.pubkey ?? path.join(ROOT, 'release-pubkey.txt'), 'utf8');
  const dir = path.resolve(args.dir ?? path.join(os.homedir(), 'Echlon'));

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

  const token = (args.tokenEnv ? env[args.tokenEnv] : undefined) || (await askSecret('Access key (not shown as you type): '));
  if (!token) throw new PackError('An access key is needed. Without it nothing can be installed.');

  const feed = new Feed({ token, apiBase: args.api ?? GITHUB_API });
  const target = args.target ?? targetOf();
  const installed = {};
  const failures = [];
  for (const id of wanted) {
    try {
      installed[id] = await installProduct({ id, def: products[id], feed, dir, target, pubkey, log: out });
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
