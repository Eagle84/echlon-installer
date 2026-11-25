import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { PackError } from './errors.mjs';

/** Free space Echlon wants before it starts: the packages, what they unpack to, and a private Node if one is needed. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;

/** Refuses an install folder whose drive is nearly full, before anything is downloaded. Unknown space is not a refusal. */
export function checkDiskSpace(dir, { statfs = fs.statfsSync, min = MIN_FREE_BYTES } = {}) {
  let free;
  try {
    const s = statfs(dir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    return;
  }
  if (Number.isFinite(free) && free < min) {
    throw new PackError(`There is not enough free space where Echlon would be installed (${Math.floor(free / 1048576)} MB free, about ${Math.floor(min / 1048576)} MB needed). Choose another folder or free some space.`);
  }
}

/** Whether something is already listening on a local port. */
export const portFree = (port, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });

/** Where a command is on this computer, or undefined. */
export function whichCommand(name, platform = process.platform) {
  try {
    const out = execFileSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    return out.split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * Anthropic's own installer for Claude Code, which `echlon-op` opens a session in. It is a script downloaded from
 * Anthropic and run on this computer, so it is only ever run when the person says yes to that question by name.
 */
export const CLAUDE_INSTALL = {
  win32: { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] },
  posix: { command: 'sh', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
};

export function runClaudeInstaller(platform = process.platform) {
  const { command, args } = CLAUDE_INSTALL[platform === 'win32' ? 'win32' : 'posix'];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
