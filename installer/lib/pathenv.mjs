import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Making `echlon-op` something a person can type anywhere. Asked first and never silent: it changes the person's own
 * environment. Windows adds the install folder to the user's PATH (not the machine's, so no administrator is needed);
 * elsewhere a link to the command is put in ~/.local/bin, which most shells already search. Nothing is added twice.
 * A terminal that was already open does not see the change.
 */
export const onPath = (dir, list, platform = process.platform) => {
  const norm = (p) => (platform === 'win32' ? path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase() : path.posix.normalize(p).replace(/\/+$/, ''));
  return String(list ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .some((p) => norm(p) === norm(dir));
};

const WINDOWS_SCRIPT = [
  "$dir = $env:ECHLON_ADD_DIR",
  "$cur = [Environment]::GetEnvironmentVariable('Path', 'User')",
  "$parts = @($cur -split ';' | Where-Object { $_ })",
  "if ($parts | Where-Object { $_.TrimEnd('\\') -ieq $dir.TrimEnd('\\') }) { 'present' } else { [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User'); 'added' }",
].join('; ');

/** Adds the install folder to the user's PATH, or links the command into ~/.local/bin. Returns what happened, in words. */
export function addToPath({ dir, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const said = execFileSync('powershell', ['-NoProfile', '-Command', WINDOWS_SCRIPT], { env: { ...env, ECHLON_ADD_DIR: dir }, encoding: 'utf8', timeout: 30000 }).trim();
    return said === 'present' ? `${dir} was already on your PATH.` : `${dir} is now on your PATH. Open a new terminal to use echlon-op.`;
  }
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'echlon-op');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join(dir, 'echlon-op'), link);
  return onPath(bin, env.PATH, platform) ? `echlon-op is linked into ${bin}.` : `echlon-op is linked into ${bin}, which is not on your PATH yet. Add it, or run ${path.join(dir, 'echlon-op')}.`;
}
