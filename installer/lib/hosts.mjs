import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PackError } from './errors.mjs';

/**
 * Connecting the engine to the AI tools on this computer.
 *
 * The engine describes how to start itself (`--print-entry`); each tool here has its own place and format for
 * a list of MCP servers, and this writes that one entry into each tool the customer agrees to. The files
 * belong to the customer and hold their other settings, so the rules are the same everywhere: look before
 * touching, change only the `echlon` entry, copy the file aside first, and refuse a file that cannot be read
 * rather than overwrite what could not be understood.
 *
 * `tier` says how far each tool's format is known: `tested` means the format was read from a real config on a
 * real machine or written through the tool's own command; `docs` means it follows the tool's documentation and
 * has not yet been seen working.
 */
export const SERVER_NAME = 'echlon';

/** Where a command is on PATH, or undefined. */
export function whichSync(cmd, env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** Runs a program with no shell, so what is passed is exactly what it receives (a shell strips the quotes from JSON). */
export function exec(cmd, args, { env = process.env, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

export function defaultContext(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? os.homedir();
  return {
    platform,
    env,
    home,
    appdata: overrides.appdata ?? env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
    which: overrides.which ?? ((cmd) => whichSync(cmd, env, platform)),
    exec: overrides.exec ?? exec,
    now: overrides.now ?? (() => new Date()),
  };
}

const stamp = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------------------
// What each tool is given: the same server, in the shape that tool's config uses.

const stdio = (e) => ({ command: e.command, args: e.args, env: e.env });
const SHAPES = {
  plain: stdio,
  typed: (e) => ({ type: 'stdio', ...stdio(e) }),
  opencode: (e) => ({ type: 'local', command: [e.command, ...e.args], environment: e.env, enabled: true }),
  zed: (e) => ({ command: { path: e.command, args: e.args, env: e.env } }),
};

/** Equal as data: the same keys and values, whatever order a file happens to list them in. */
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ---------------------------------------------------------------------------------------------------------
// JSON config files: `{ <key>: { <name>: <server> } }`.

function indentOf(text) {
  const m = /^([ \t]+)\S/m.exec(text);
  return m ? m[1] : '  ';
}

/** The text with the echlon entry set, or why that cannot be done. Everything else in the file is kept. */
export function mergeJsonEntry(text, key, server) {
  if (text.trim() === '') return { ok: true, text: `${JSON.stringify({ [key]: { [SERVER_NAME]: server } }, null, 2)}\n`, was: 'absent' };
  let doc;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, reason: 'is not plain JSON (it may have comments, or be damaged), so it was left alone' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'is not a JSON object, so it was left alone' };
  const section = doc[key];
  if (section !== undefined && (typeof section !== 'object' || section === null || Array.isArray(section))) {
    return { ok: false, reason: `has a "${key}" that is not an object, so it was left alone` };
  }
  const was = section?.[SERVER_NAME];
  if (was !== undefined && same(was, server)) return { ok: true, text, was: 'same' };
  const next = { ...doc, [key]: { ...(section ?? {}), [SERVER_NAME]: server } };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = JSON.stringify(next, null, indentOf(text));
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return { ok: true, text: out + (/\n$/.test(text) ? eol : ''), was: was === undefined ? 'absent' : 'different' };
}

// ---------------------------------------------------------------------------------------------------------
// Codex: ~/.codex/config.toml. Edited as text, never re-written from a parse, so the rest of the file (plugins,
// projects, model settings) is kept byte for byte.

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
const tomlString = (s) => (s.includes("'") || /[\r\n]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"` : `'${s}'`);

export function codexBlock(e) {
  const lines = [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(e.command)}`, `args = [${e.args.map(tomlString).join(', ')}]`, 'startup_timeout_sec = 30', '', `[mcp_servers.${SERVER_NAME}.env]`];
  for (const [k, v] of Object.entries(e.env)) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
  return lines.join('\n');
}

const ECHLON_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*"?echlon"?\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;

/** The sections of the file that belong to the echlon server, and the file without them. */
export function splitCodexToml(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = [];
  const mine = [];
  let inMine = false;
  for (const line of lines) {
    if (ANY_HEADER.test(line)) inMine = ECHLON_HEADER.test(line);
    (inMine ? mine : kept).push(line);
  }
  return { eol, kept, mine };
}

export function mergeCodexToml(text, e) {
  const { eol, kept, mine } = splitCodexToml(text);
  const block = codexBlock(e);
  const norm = (ls) => ls.join('\n').replace(/\s+$/g, '').replace(/\r/g, '');
  if (mine.length && norm(mine) === block) return { ok: true, text, was: 'same' };
  const body = kept.join(eol).replace(/\s+$/g, '');
  const out = `${body}${body ? `${eol}${eol}` : ''}${block.split('\n').join(eol)}${eol}`;
  return { ok: true, text: out, was: mine.length ? 'different' : 'absent' };
}

// ---------------------------------------------------------------------------------------------------------
// The hosts.

const json = ({ id, name, tier, dir, file, key, shape = 'plain', hint }) => ({
  id,
  name,
  tier,
  kind: 'json',
  hint,
  dir,
  file,
  key,
  shape,
  found: (ctx) => exists(dir(ctx)),
});

export const HOSTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    tier: 'tested',
    kind: 'claude-code',
    found: (ctx) => Boolean(ctx.which('claude')),
    hint: 'restart Claude Code, or run /mcp, to see it',
  },
  json({
    id: 'claude-desktop',
    name: 'Claude Desktop',
    tier: 'tested',
    dir: (c) => path.dirname(HOSTS_FILES['claude-desktop'](c)),
    file: (c) => HOSTS_FILES['claude-desktop'](c),
    key: 'mcpServers',
    hint: 'quit Claude Desktop completely and open it again',
  }),
  {
    id: 'codex',
    name: 'Codex',
    tier: 'tested',
    kind: 'toml',
    dir: (c) => c.env.CODEX_HOME || path.join(c.home, '.codex'),
    file: (c) => path.join(c.env.CODEX_HOME || path.join(c.home, '.codex'), 'config.toml'),
    found: (c) => exists(c.env.CODEX_HOME || path.join(c.home, '.codex')) || Boolean(c.which('codex')),
    hint: 'start a new Codex session',
  },
  json({
    id: 'cursor',
    name: 'Cursor',
    tier: 'tested',
    dir: (c) => path.join(c.home, '.cursor'),
    file: (c) => path.join(c.home, '.cursor', 'mcp.json'),
    key: 'mcpServers',
    hint: 'restart Cursor',
  }),
  json({
    id: 'vscode',
    name: 'VS Code (Copilot)',
    tier: 'docs',
    dir: (c) => path.dirname(HOSTS_FILES.vscode(c)),
    file: (c) => HOSTS_FILES.vscode(c),
    key: 'servers',
    shape: 'typed',
    hint: 'reload VS Code',
  }),
  json({
    id: 'lmstudio',
    name: 'LM Studio',
    tier: 'tested',
    dir: (c) => path.join(c.home, '.lmstudio'),
    file: (c) => path.join(c.home, '.lmstudio', 'mcp.json'),
    key: 'mcpServers',
    hint: 'restart LM Studio',
  }),
  json({
    id: 'gemini',
    name: 'Gemini CLI',
    tier: 'docs',
    dir: (c) => path.join(c.home, '.gemini'),
    file: (c) => path.join(c.home, '.gemini', 'settings.json'),
    key: 'mcpServers',
    hint: 'start a new Gemini session',
  }),
  json({
    id: 'windsurf',
    name: 'Windsurf',
    tier: 'docs',
    dir: (c) => path.join(c.home, '.codeium', 'windsurf'),
    file: (c) => path.join(c.home, '.codeium', 'windsurf', 'mcp_config.json'),
    key: 'mcpServers',
    hint: 'restart Windsurf',
  }),
  json({
    id: 'opencode',
    name: 'opencode',
    tier: 'docs',
    dir: (c) => path.join(c.home, '.config', 'opencode'),
    file: (c) => path.join(c.home, '.config', 'opencode', 'opencode.json'),
    key: 'mcp',
    shape: 'opencode',
    hint: 'start a new opencode session',
  }),
  json({
    id: 'zed',
    name: 'Zed',
    tier: 'docs',
    dir: (c) => path.dirname(HOSTS_FILES.zed(c)),
    file: (c) => HOSTS_FILES.zed(c),
    key: 'context_servers',
    shape: 'zed',
    hint: 'restart Zed',
  }),
];

const HOSTS_FILES = {
  'claude-desktop': (c) =>
    c.platform === 'win32'
      ? path.win32.join(c.appdata, 'Claude', 'claude_desktop_config.json')
      : c.platform === 'darwin'
        ? path.join(c.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(c.home, '.config', 'Claude', 'claude_desktop_config.json'),
  vscode: (c) =>
    c.platform === 'win32'
      ? path.win32.join(c.appdata, 'Code', 'User', 'mcp.json')
      : c.platform === 'darwin'
        ? path.join(c.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : path.join(c.home, '.config', 'Code', 'User', 'mcp.json'),
  zed: (c) => (c.platform === 'win32' ? path.win32.join(c.appdata, 'Zed', 'settings.json') : path.join(c.home, '.config', 'zed', 'settings.json')),
};

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** What is on this computer: each known tool, whether it is here, and whether Echlon is already connected to it. */
export async function detectHosts(ctx, entry) {
  const out = [];
  for (const h of HOSTS) {
    if (!h.found(ctx)) continue;
    let state = 'new';
    let detail;
    if (h.kind === 'json') {
      const text = read(h.file(ctx));
      const r = text === undefined ? { ok: true, was: 'absent' } : mergeJsonEntry(text, h.key, SHAPES[h.shape](entry));
      if (!r.ok) {
        state = 'unreadable';
        detail = r.reason;
      } else state = r.was === 'same' ? 'connected' : r.was === 'different' ? 'differs' : 'new';
    } else if (h.kind === 'toml') {
      const text = read(h.file(ctx));
      state = text === undefined ? 'new' : { same: 'connected', different: 'differs', absent: 'new' }[mergeCodexToml(text, entry).was];
    } else {
      const got = await ctx.exec('claude', ['mcp', 'get', SERVER_NAME], { env: ctx.env });
      state = got.code !== 0 ? 'new' : got.out.includes(`Command: ${entry.command}`) ? 'connected' : 'differs';
    }
    out.push({ id: h.id, name: h.name, tier: h.tier, state, detail, hint: h.hint, where: h.kind === 'claude-code' ? 'claude mcp (user scope)' : h.file(ctx) });
  }
  return out;
}

/** Writes the entry into one tool. Returns what happened; never throws for a tool that cannot be changed. */
export async function connectHost(id, ctx, entry) {
  const h = HOSTS.find((x) => x.id === id);
  if (!h) throw new PackError(`"${id}" is not a tool this installer knows.`);

  if (h.kind === 'claude-code') {
    const json = JSON.stringify({ type: 'stdio', ...stdio(entry) });
    const got = await ctx.exec('claude', ['mcp', 'get', SERVER_NAME], { env: ctx.env });
    if (got.code === 0) {
      if (got.out.includes(`Command: ${entry.command}`)) return { status: 'unchanged' };
      // The command refuses a name that exists, so a different entry is replaced: removed, then added.
      const removed = await ctx.exec('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { env: ctx.env });
      if (removed.code !== 0) return { status: 'failed', detail: 'the existing Echlon entry could not be replaced' };
    }
    const added = await ctx.exec('claude', ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, json], { env: ctx.env });
    return added.code === 0 ? { status: got.code === 0 ? 'updated' : 'added' } : { status: 'failed', detail: 'Claude Code did not accept the entry' };
  }

  const file = h.file(ctx);
  const text = read(file);
  const r = h.kind === 'toml' ? mergeCodexToml(text ?? '', entry) : mergeJsonEntry(text ?? '', h.key, SHAPES[h.shape](entry));
  if (!r.ok) return { status: 'refused', detail: `${path.basename(file)} ${r.reason}`, manual: manualSnippet(h, entry) };
  if (r.was === 'same') return { status: 'unchanged' };

  let backup;
  if (text !== undefined) {
    backup = `${file}.echlon-backup-${stamp(ctx.now())}`;
    fs.copyFileSync(file, backup);
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.echlon-tmp`;
  fs.writeFileSync(tmp, r.text);
  fs.renameSync(tmp, file);

  // Read it back: "connected" is only said of what is actually in the file now.
  const after = read(file);
  const check = h.kind === 'toml' ? mergeCodexToml(after, entry) : mergeJsonEntry(after, h.key, SHAPES[h.shape](entry));
  if (!check.ok || check.was !== 'same') {
    if (backup) fs.copyFileSync(backup, file);
    return { status: 'failed', detail: `${path.basename(file)} did not read back as expected, so it was put back` };
  }
  return { status: r.was === 'different' ? 'updated' : 'added', backup };
}

/** What a person would paste, for a tool whose file was not touched. */
export function manualSnippet(h, entry) {
  if (h.kind === 'toml') return codexBlock(entry);
  return JSON.stringify({ [h.key]: { [SERVER_NAME]: SHAPES[h.shape](entry) } }, null, 2);
}

/** Asks the installed engine how to start itself. */
export async function readEntry(exe, run = exec) {
  const r = await run(exe, ['--print-entry'], { timeout: 30_000 });
  if (r.code !== 0) throw new PackError('This engine build could not describe how to connect it, so no AI tool was set up. Update the engine and run the installer again.');
  const line = r.out.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    throw new PackError('The engine gave an answer about how to connect it that could not be read, so no AI tool was set up.');
  }
  const strings = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => typeof v === 'string');
  if (typeof e.command !== 'string' || !e.command || !Array.isArray(e.args) || !e.args.every((a) => typeof a === 'string') || !strings(e.env)) {
    throw new PackError('The engine gave an answer about how to connect it that was not in the expected shape, so no AI tool was set up.');
  }
  return { command: e.command, args: e.args, env: e.env };
}
