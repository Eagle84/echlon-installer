#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackError } from './lib/errors.mjs';
import { Feed, GITHUB_API } from './lib/feed.mjs';
import { offerConnections, parseConnect } from './lib/connect.mjs';
import { HOSTS, defaultContext } from './lib/hosts.mjs';
import { ServiceFeed, isLicenceKey } from './lib/service.mjs';
import { installProduct } from './lib/product.mjs';
import { createProgress } from './lib/progress.mjs';
import { ask, askHidden } from './lib/prompt.mjs';
import { addToPath } from './lib/pathenv.mjs';
import { checkDiskSpace, portFree, runClaudeInstaller, whichCommand } from './lib/preflight.mjs';
import { ensureNode, parseRuntime } from './lib/runtime.mjs';
import { checkInstallDir, engineLauncher, newEngineToken, uiLauncher, writeLauncher, writeLicenceKey, writeUiSettings } from './lib/wire.mjs';

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
  const out = { yes: false, installClaude: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--install-claude') out.installClaude = true;
    else if (['--product', '--dir', '--api', '--target', '--token-env', '--ui-key-env', '--engine-key-env', '--products', '--pubkey', '--service', '--connect', '--runtime'].includes(a)) out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new PackError(`Unknown option ${a}.`);
  }
  return out;
}

const MENU = [
  ['1', 'ui', 'Echlon UI'],
  ['2', 'engine', 'Echlon Engine'],
  ['3', 'both', 'Both (the full ecosystem)'],
];

/** What is worth saying once the products are in: a busy port, and Claude Code for echlon-op. Nothing here stops an install. */
async function finalChecks({ installed, args, askFn, out, prereq }) {
  const free = prereq.portFree ?? portFree;
  if (installed.engine && !(await free(3737))) out('Something else is already using port 3737, so the engine cannot start until it is stopped.');
  if (installed.ui && !(await free(4180))) out('Something else is already using port 4180, so the UI cannot start until it is stopped.');
  if (!installed.engine || (prereq.which ?? whichCommand)('claude')) return;
  out('Claude Code is not installed. echlon-op opens a Claude Code session, so it needs it (the engine works without it, for your AI tools and the UI).');
  const yes = args.installClaude || (!args.yes && ((await askFn("Install Claude Code now with Anthropic's official installer? (y/N): ")) || 'n').toLowerCase().startsWith('y'));
  if (!yes) return;
  out((await (prereq.installClaude ?? runClaudeInstaller)()) ? 'Claude Code is installed. Open a new terminal before using it.' : 'Claude Code could not be installed. Install it from https://claude.com/claude-code and echlon-op will work.');
}

export const targetOf = () => `${process.platform}-${process.arch}`;

/** A typed folder as an absolute path; `~` means the home folder. */
export const folderOf = (typed, home = os.homedir()) => path.resolve(/^~(?=$|[\\/])/.test(typed) ? path.join(home, typed.slice(1)) : typed);

/** Everything Echlon installs lives in one folder of this name, inside whatever place the customer picks. */
export const PLATFORMS_DIR = 'Echlon_Platforms';
export const inPlatformsFolder = (typed, home = os.homedir()) => {
  const dir = folderOf(typed, home);
  return path.basename(dir).toLowerCase() === PLATFORMS_DIR.toLowerCase() ? dir : path.join(dir, PLATFORMS_DIR);
};

export async function run(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), askFn = ask, askSecret = askHidden, nodeMajor, runCommand, stream, hostCtx, entryOf, pathAdder = addToPath, prereq = {} } = {}) {
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
  const connect = parseConnect(args.connect, HOSTS.map((h) => h.id));

  // Where to install comes before the key: nothing is asked of GitHub until the customer has said where it goes.
  // A place typed at the prompt gets the Echlon_Platforms folder inside it; --dir names the folder itself, exactly.
  let dir = args.dir;
  if (!dir) {
    const fallback = path.join(os.homedir(), PLATFORMS_DIR);
    const typed = await askFn(`Install folder (Enter for ${fallback}; Echlon goes in a folder named ${PLATFORMS_DIR} inside the one you give): `);
    dir = typed ? inPlatformsFolder(typed) : fallback;
  }
  dir = folderOf(dir);
  checkInstallDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  out(`Installing into ${dir}`);
  checkDiskSpace(dir, { statfs: prereq.statfs });

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
    if (same) keys.ui = keys.engine = await askSecret('Access key: ');
  }
  for (const id of wanted) {
    if (!keys[id]) keys[id] = await askSecret(`${products[id].name} access key: `);
    if (!keys[id]) throw new PackError(`An access key is needed for ${products[id].name}. Without it nothing can be installed.`);
  }

  // On a terminal the download bar redraws in place; with no terminal stream (a test, a pipe) it prints lines.
  const progress = createProgress(
    stream
      ? { write: (s) => stream.write(s), isTTY: Boolean(stream.isTTY), columns: stream.columns ?? 80 }
      : { write: (s) => out(s.replace(/\r?\n$/, '')), isTTY: false },
  );
  const target = args.target ?? targetOf();
  const installed = {};
  const failures = [];
  // A licence key (what a customer is given) goes to the Echlon download service. Anything else is read as a
  // GitHub token for the private release repositories, which is how an operator installs without the service.
  const shipped = fs.readFileSync(path.join(ROOT, 'service.txt'), 'utf8').trim();
  const feeds = Object.fromEntries(
    wanted.map((id) => [id, isLicenceKey(keys[id]) ? new ServiceFeed({ key: keys[id], url: args.service ?? shipped, shipped }) : new Feed({ token: keys[id], apiBase: args.api ?? GITHUB_API })]),
  );
  // A product that needs a newer Node than this computer has is given a copy of its own, once, in the person's profile.
  const pin = parseRuntime(fs.readFileSync(args.runtime ?? path.join(ROOT, 'runtime.txt'), 'utf8'));
  const yesNo = async (q) => args.yes || ((await askFn(q)) || 'y').toLowerCase().startsWith('y');
  const uiNode = {};
  for (const id of wanted) {
    try {
      let have = nodeMajor;
      if (products[id].requiresNode) {
        const n = await (prereq.ensureNode ?? ensureNode)({ minMajor: Number(products[id].requiresNode), haveMajor: nodeMajor, pin, progress, log: out, name: products[id].name, confirm: () => yesNo('Download it now? (Y/n): '), ...prereq.runtime });
        have = n.major;
        uiNode[id] = n.binDir;
      }
      installed[id] = await installProduct({ id, def: products[id], feed: feeds[id], dir, target, pubkey, log: out, nodeMajor: have, nodeBin: uiNode[id], runCommand, progress });
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
    const launcher = writeLauncher(dir, engineLauncher({ platform, installDir: dir, exeRelative: path.join('engine', e.version, e.exe ?? e.file), token: engineToken }));
    out(`Start the engine with: ${launcher}`);
    out(platform === 'win32' ? 'It runs in the background, with no window; stop-engine.cmd stops it and engine.log records what it did.' : 'Stop it with Ctrl+C.');
    out(`Open an operator session (Claude Code with only the Echlon tools) with: ${path.join(dir, platform === 'win32' ? 'echlon-op.cmd' : 'echlon-op')}`);
    const wantPath = args.yes ? true : ((await askFn('Make echlon-op available from any terminal? (Y/n): ')) || 'y').toLowerCase().startsWith('y');
    if (wantPath) {
      try {
        out(pathAdder({ dir }));
      } catch (err) {
        out(`Could not change your PATH (${String(err.message).split('\n')[0]}). Run echlon-op from ${dir}.`);
      }
    }
    // A licensed engine renews its licence with the customer's key and stops serving when it ends; it looks for the key
    // beside its program. Same rule as the UI: only a licensed package, only a licence key, owner-only, never printed.
    if (e.pack?.licensed && isLicenceKey(keys.engine)) {
      writeLicenceKey(e.dest, keys.engine);
      out('Your licence key is kept for the engine so it can renew its licence (readable only by you).');
    }
  }
  if (installed.ui) {
    const u = installed.ui;
    const dataDir = path.join(dir, 'ui', 'data');
    if (engineToken) writeUiSettings(dataDir, engineToken);
    // A licensed UI renews its licence with the customer's key and locks itself when the licence ends, so it has
    // to hold the key. Only a licensed package, and only a licence key (never a GitHub token), is ever written.
    if (u.pack?.licensed && isLicenceKey(keys.ui)) {
      writeLicenceKey(dataDir, keys.ui);
      out('Your licence key is kept for the UI so it can renew its licence (readable only by you).');
    }
    const start = u.pack?.start?.[platform === 'win32' ? 'win32' : 'posix'];
    if (start) {
      const launcher = writeLauncher(dir, uiLauncher({ platform, versionDir: u.dest, startRelative: start, dataDir, binDir: uiNode.ui }));
      out(`Start the UI with: ${launcher}`);
    } else {
      out(`The UI is in ${u.dest}.`);
    }
    if (engineToken) out('The UI is set up to use the engine.');
  }
  if (installed.engine && connect !== 'none') {
    const e = installed.engine;
    await offerConnections({ exe: path.join(dir, 'engine', e.version, e.exe ?? e.file), choice: connect, yes: args.yes, ctx: hostCtx ?? defaultContext(), out, askFn, entryOf });
  }
  await finalChecks({ installed, args, askFn, out, prereq });
  for (const f of failures) out(`Not installed - ${f}`);
  if (failures.length === wanted.length) out('Nothing was installed.');
  else if (!failures.length) out('Done.');
  return failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), { stream: process.stdout })
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof PackError ? e.message : `Something went wrong: ${e.message}`);
      process.exit(1);
    });
}
