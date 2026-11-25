import { spawnSync } from 'node:child_process';
import { PackError } from './errors.mjs';

/**
 * What a downloaded package may ask this installer to run after it is unpacked. The package is signed,
 * but a signature says who made it, not what it is allowed to do here, so the list is closed: one
 * command, `npm ci`, with a few flags. Anything else is refused rather than run.
 */
const ALLOWED_FLAGS = new Set(['--omit=dev', '--no-audit', '--no-fund']);

export function checkPostInstall(steps) {
  for (const step of steps ?? []) {
    const [cmd, sub, ...flags] = Array.isArray(step) ? step : [];
    if (cmd !== 'npm' || sub !== 'ci' || flags.some((f) => !ALLOWED_FLAGS.has(f))) {
      throw new PackError(`This package asks for a setup step this installer does not run (${Array.isArray(step) ? step.join(' ') : String(step)}), so nothing was installed.`);
    }
  }
  return steps ?? [];
}

/** The Node version a package needs, from its manifest (a major number), against the one running here. */
export function checkNode(requires, have = Number(process.versions.node.split('.')[0]), name = 'This package') {
  const need = Number(requires?.node);
  if (Number.isFinite(need) && need > have) {
    throw new PackError(`${name} needs Node ${need} or newer, and this computer has Node ${have}. Install a newer Node from https://nodejs.org and run the installer again. Nothing was installed.`);
  }
}

/** Runs one allowed step in a folder. The arguments are fixed by the allow-list above, never typed by anyone. */
export function runStep(step, cwd) {
  checkPostInstall([step]);
  const win = process.platform === 'win32';
  const r = win ? spawnSync(`npm ${step.slice(1).join(' ')}`, { cwd, stdio: 'ignore', shell: true }) : spawnSync('npm', step.slice(1), { cwd, stdio: 'ignore' });
  if (r.status !== 0) throw new PackError(`Setting up the program's own files failed (${step.join(' ')}). Check the internet connection and try again. Nothing was installed.`);
}
