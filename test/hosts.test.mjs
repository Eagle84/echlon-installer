import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../installer/install.mjs';
import { PackError } from '../installer/lib/errors.mjs';
import { chooseHosts, offerConnections, parseConnect } from '../installer/lib/connect.mjs';
import { HOSTS, codexBlock, connectHost, detectHosts, mergeCodexToml, mergeJsonEntry, readEntry, splitCodexToml } from '../installer/lib/hosts.mjs';
import { buildFeeds, newKeys, calm, noPath, sandboxHosts, startService, tmpDir, writeConfig } from './helpers.mjs';

const ENTRY = {
  command: 'C:\\Echlon\\engine\\2.0.0\\echlon-engine-win32-x64.exe',
  args: [],
  env: { AGENTIC_FLOW_VENDOR: 'claude', AGENTIC_FLOW_TIMEOUT_MS: '120000', AGENTIC_FLOW_CREDENTIAL_ENV: '{}', AGENTIC_FLOW_GRANT: '{"tools":["perform_intent"]}' },
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const cursorFile = (ctx) => path.join(ctx.home, '.cursor', 'mcp.json');
const backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.echlon-backup-`));

describe('writing the entry into a JSON settings file', () => {
  it('adds the echlon server and keeps every other server and setting as it was', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { GitHub: { command: 'gh', env: { A: '1' } } } }, null, 2);
    const r = mergeJsonEntry(before, 'mcpServers', ENTRY);
    assert.equal(r.ok, true);
    const after = JSON.parse(r.text);
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.mcpServers.GitHub, { command: 'gh', env: { A: '1' } });
    assert.deepEqual(after.mcpServers.echlon, ENTRY);
    assert.equal(r.was, 'absent');
  });

  it('keeps the file indent, its line endings and its final newline', () => {
    for (const [indent, eol] of [['\t', '\n'], ['    ', '\n'], ['  ', '\r\n']]) {
      const before = `${JSON.stringify({ mcpServers: {} }, null, indent).replace(/\n/g, eol)}${eol}`;
      const r = mergeJsonEntry(before, 'mcpServers', ENTRY);
      assert.ok(r.text.endsWith(eol), 'final newline');
      assert.ok(r.text.includes(`${eol}${indent}"mcpServers"`), `indent ${JSON.stringify(indent)}`);
      assert.equal(r.text.includes('\r\n'), eol === '\r\n');
    }
  });

  it('says it is already connected, and changes nothing, when the entry is the same whatever the key order', () => {
    const reordered = { env: ENTRY.env, args: ENTRY.args, command: ENTRY.command };
    const r = mergeJsonEntry(JSON.stringify({ mcpServers: { echlon: reordered } }), 'mcpServers', ENTRY);
    assert.equal(r.was, 'same');
  });

  it('replaces a different echlon entry and says so', () => {
    const r = mergeJsonEntry(JSON.stringify({ mcpServers: { echlon: { command: 'old.exe' } } }), 'mcpServers', ENTRY);
    assert.equal(r.was, 'different');
    assert.equal(JSON.parse(r.text).mcpServers.echlon.command, ENTRY.command);
  });

  it('refuses a file it cannot read as plain JSON, including the real half-written one, rather than overwrite it', () => {
    for (const bad of ['{ ', '{\n  // my servers\n  "mcpServers": {}\n}', '[]', 'not json', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      const r = mergeJsonEntry(bad, 'mcpServers', ENTRY);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.reason, /left alone/);
    }
  });

  it('starts a new file when there is none', () => {
    const r = mergeJsonEntry('', 'mcpServers', ENTRY);
    assert.deepEqual(JSON.parse(r.text), { mcpServers: { echlon: ENTRY } });
  });
});

describe('connecting a JSON tool', () => {
  it('writes the file, keeps the old one as a backup, and reads it back before saying so', async () => {
    const ctx = sandboxHosts();
    const original = `${JSON.stringify({ mcpServers: { n8n: { command: 'npx' } } }, null, 2)}\n`;
    write(cursorFile(ctx), original);
    const r = await connectHost('cursor', ctx, ENTRY);
    assert.equal(r.status, 'added');
    assert.equal(fs.readFileSync(r.backup, 'utf8'), original, 'the backup is the file as it was');
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile(ctx), 'utf8')).mcpServers.echlon, ENTRY);
    assert.ok(!fs.existsSync(`${cursorFile(ctx)}.echlon-tmp`), 'no temporary file is left');
  });

  it('creates the settings file when the tool is installed but has none, with no backup to make', async () => {
    const ctx = sandboxHosts();
    fs.mkdirSync(path.join(ctx.home, '.cursor'));
    const r = await connectHost('cursor', ctx, ENTRY);
    assert.equal(r.status, 'added');
    assert.equal(r.backup, undefined);
  });

  it('does nothing, and makes no backup, when it is already connected', async () => {
    const ctx = sandboxHosts();
    await (async () => {
      fs.mkdirSync(path.join(ctx.home, '.cursor'));
      await connectHost('cursor', ctx, ENTRY);
    })();
    const before = fs.readFileSync(cursorFile(ctx), 'utf8');
    const r = await connectHost('cursor', ctx, ENTRY);
    assert.equal(r.status, 'unchanged');
    assert.equal(fs.readFileSync(cursorFile(ctx), 'utf8'), before);
    assert.equal(backups(cursorFile(ctx)).length, 0);
  });

  it('leaves an unreadable file byte for byte as it was, makes no backup, and gives the customer the entry to add by hand', async () => {
    const ctx = sandboxHosts();
    write(cursorFile(ctx), '{\n  // comment\n  "mcpServers": {}\n}\n');
    const before = fs.readFileSync(cursorFile(ctx));
    const r = await connectHost('cursor', ctx, ENTRY);
    assert.equal(r.status, 'refused');
    assert.deepEqual(fs.readFileSync(cursorFile(ctx)), before);
    assert.equal(backups(cursorFile(ctx)).length, 0);
    assert.deepEqual(JSON.parse(r.manual).mcpServers.echlon, ENTRY);
  });

  it('gives each tool the shape its own config uses', async () => {
    const cases = [
      ['vscode', (ctx) => HOSTS.find((h) => h.id === 'vscode').file(ctx), (j) => j.servers.echlon, (s) => assert.deepEqual(s, { type: 'stdio', ...ENTRY })],
      ['opencode', (ctx) => path.join(ctx.home, '.config', 'opencode', 'opencode.json'), (j) => j.mcp.echlon, (s) => assert.deepEqual(s, { type: 'local', command: [ENTRY.command], environment: ENTRY.env, enabled: true })],
      ['zed', (ctx) => HOSTS.find((h) => h.id === 'zed').file(ctx), (j) => j.context_servers.echlon, (s) => assert.deepEqual(s, { command: { path: ENTRY.command, args: [], env: ENTRY.env } })],
      ['gemini', (ctx) => path.join(ctx.home, '.gemini', 'settings.json'), (j) => j.mcpServers.echlon, (s) => assert.deepEqual(s, ENTRY)],
      ['windsurf', (ctx) => path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'), (j) => j.mcpServers.echlon, (s) => assert.deepEqual(s, ENTRY)],
      ['lmstudio', (ctx) => path.join(ctx.home, '.lmstudio', 'mcp.json'), (j) => j.mcpServers.echlon, (s) => assert.deepEqual(s, ENTRY)],
    ];
    for (const [id, file, pick, check] of cases) {
      const ctx = sandboxHosts();
      fs.mkdirSync(path.dirname(file(ctx)), { recursive: true });
      const r = await connectHost(id, ctx, ENTRY);
      assert.equal(r.status, 'added', `${id}: ${r.detail}`);
      check(pick(JSON.parse(fs.readFileSync(file(ctx), 'utf8'))));
    }
  });
});

// A config.toml shaped like the one Codex writes: plugins, projects, a server of its own.
const CODEX = [
  'model = "gpt-5"',
  '',
  '[windows]',
  'sandbox = "elevated"',
  '',
  '[plugins."github@openai-curated"]',
  'enabled = true',
  '',
  "[projects.'d:\\projects\\ai projects\\echlon platform']",
  'trust_level = "trusted"',
  '',
  '[mcp_servers.node_repl]',
  "command = 'C:\\Program Files\\nodejs\\node.exe'",
  'args = ["--version"]',
  'startup_timeout_sec = 60',
  '',
  '[mcp_servers.node_repl.env]',
  'CODEX_HOME = "C:\\Users\\x\\.codex"',
  '',
].join('\n');

describe('connecting Codex', () => {
  it('adds the server at the end and leaves every other line of the file exactly as it was', () => {
    const r = mergeCodexToml(CODEX, ENTRY);
    assert.equal(r.was, 'absent');
    assert.ok(r.text.startsWith(CODEX.trimEnd()), 'the original file is a prefix, untouched');
    assert.ok(r.text.endsWith(`${codexBlock(ENTRY)}\n`));
  });

  it('writes a Windows path as it is and handles a quote in a value', () => {
    assert.match(codexBlock(ENTRY), /^command = 'C:\\Echlon\\engine\\2\.0\.0\\echlon-engine-win32-x64\.exe'$/m);
    const quoted = codexBlock({ ...ENTRY, env: { A: "it's" } });
    assert.match(quoted, /^A = "it's"$/m);
    assert.match(codexBlock(ENTRY), /^AGENTIC_FLOW_GRANT = '\{"tools":\["perform_intent"\]\}'$/m);
  });

  it('allows the server time to start, and names no credential', () => {
    assert.match(codexBlock(ENTRY), /^startup_timeout_sec = 30$/m);
    assert.ok(!/token|secret|password/i.test(codexBlock(ENTRY)));
  });

  it('replaces an earlier echlon block, wherever it is, and nothing else; a second run changes nothing', () => {
    const stale = `${CODEX}\n[mcp_servers.echlon]\ncommand = 'old.exe'\nargs = []\n\n[mcp_servers.echlon.env]\nX = 'y'\n\n[mcp_servers.after]\ncommand = 'keep.exe'\n`;
    const once = mergeCodexToml(stale, ENTRY);
    assert.equal(once.was, 'different');
    assert.ok(!once.text.includes('old.exe'));
    assert.ok(once.text.includes("[mcp_servers.after]\ncommand = 'keep.exe'"), 'a server after it is kept');
    assert.ok(once.text.includes('[mcp_servers.node_repl.env]'), 'a server before it is kept');
    assert.equal((once.text.match(/\[mcp_servers\.echlon\]/g) ?? []).length, 1);
    const twice = mergeCodexToml(once.text, ENTRY);
    assert.equal(twice.was, 'same');
    assert.equal(twice.text, once.text);
  });

  it('does not mistake another server that starts with the same letters for its own', () => {
    const text = `${CODEX}\n[mcp_servers.echlon_other]\ncommand = 'x'\n`;
    const { mine, kept } = splitCodexToml(text);
    assert.equal(mine.length, 0);
    assert.ok(kept.join('\n').includes('echlon_other'));
    assert.ok(mergeCodexToml(text, ENTRY).text.includes("[mcp_servers.echlon_other]\ncommand = 'x'"));
  });

  it('recognises a quoted name, and keeps CRLF line endings', () => {
    const crlf = `${CODEX.replace(/\n/g, '\r\n')}\r\n[mcp_servers."echlon"]\r\ncommand = 'old'\r\n`;
    const r = mergeCodexToml(crlf, ENTRY);
    assert.ok(!r.text.includes('old'));
    assert.ok(!/[^\r]\n/.test(r.text), 'every line ending is still CRLF');
  });

  it('connects through the file with a backup, and creates the file when only the folder exists', async () => {
    const ctx = sandboxHosts();
    const file = path.join(ctx.home, '.codex', 'config.toml');
    write(file, CODEX);
    const r = await connectHost('codex', ctx, ENTRY);
    assert.equal(r.status, 'added');
    assert.equal(fs.readFileSync(r.backup, 'utf8'), CODEX);
    const ctx2 = sandboxHosts();
    fs.mkdirSync(path.join(ctx2.home, '.codex'));
    assert.equal((await connectHost('codex', ctx2, ENTRY)).status, 'added');
  });

  it('honours CODEX_HOME', async () => {
    const home = tmpDir('codex-home-');
    const ctx = sandboxHosts({ env: { PATH: '', CODEX_HOME: home } });
    const found = await detectHosts(ctx, ENTRY);
    assert.ok(found.some((h) => h.id === 'codex'));
    await connectHost('codex', ctx, ENTRY);
    assert.ok(fs.existsSync(path.join(home, 'config.toml')));
  });
});

describe('connecting Claude Code', () => {
  const calls = [];
  const fake = (answers) =>
    sandboxHosts({
      which: (c) => (c === 'claude' ? 'C:\\bin\\claude.exe' : undefined),
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        const key = args.slice(0, 2).join(' ');
        return answers[key] ?? { code: 0, out: '' };
      },
    });

  it('is found only when the claude command is on PATH', async () => {
    assert.ok(!(await detectHosts(sandboxHosts(), ENTRY)).some((h) => h.id === 'claude-code'));
    assert.ok((await detectHosts(fake({ 'mcp get': { code: 1, out: '' } }), ENTRY)).some((h) => h.id === 'claude-code'));
  });

  it('adds through its own command, as user-level JSON, never by editing its settings file', async () => {
    calls.length = 0;
    const r = await connectHost('claude-code', fake({ 'mcp get': { code: 1, out: 'No MCP server named "echlon".' } }), ENTRY);
    assert.equal(r.status, 'added');
    const add = calls.find((c) => c[2] === 'add-json');
    assert.deepEqual(add.slice(0, 6), ['claude', 'mcp', 'add-json', '--scope', 'user', 'echlon']);
    assert.deepEqual(JSON.parse(add[6]), { type: 'stdio', ...ENTRY });
  });

  it('does nothing when it is already connected to this engine', async () => {
    calls.length = 0;
    const r = await connectHost('claude-code', fake({ 'mcp get': { code: 0, out: `echlon:\n  Command: ${ENTRY.command}\n` } }), ENTRY);
    assert.equal(r.status, 'unchanged');
    assert.ok(!calls.some((c) => c[2] === 'add-json' || c[2] === 'remove'));
  });

  it('removes then adds when it points at another copy, because the command refuses a name that exists', async () => {
    calls.length = 0;
    const r = await connectHost('claude-code', fake({ 'mcp get': { code: 0, out: 'echlon:\n  Command: D:\\old\\echlon.exe\n' } }), ENTRY);
    assert.equal(r.status, 'updated');
    const order = calls.filter((c) => c[1] === 'mcp').map((c) => c[2]);
    assert.deepEqual(order, ['get', 'remove', 'add-json']);
  });

  it('reports a failure, and does not add, when the old entry cannot be removed', async () => {
    calls.length = 0;
    const r = await connectHost('claude-code', fake({ 'mcp get': { code: 0, out: 'Command: D:\\old.exe' }, 'mcp remove': { code: 1, out: 'x' } }), ENTRY);
    assert.equal(r.status, 'failed');
    assert.ok(!calls.some((c) => c[2] === 'add-json'));
  });
});

describe('finding the tools on this computer', () => {
  it('finds a tool by its folder, says which are connected already, and reports none for an empty computer', async () => {
    const ctx = sandboxHosts();
    assert.deepEqual(await detectHosts(ctx, ENTRY), []);
    fs.mkdirSync(path.join(ctx.home, '.cursor'));
    fs.mkdirSync(path.join(ctx.home, '.gemini'));
    write(path.join(ctx.home, '.lmstudio', 'mcp.json'), JSON.stringify({ mcpServers: { echlon: ENTRY } }));
    write(path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'), '{ ');
    const found = Object.fromEntries((await detectHosts(ctx, ENTRY)).map((h) => [h.id, h.state]));
    assert.deepEqual(found, { cursor: 'new', lmstudio: 'connected', gemini: 'new', windsurf: 'unreadable' });
  });

  it('knows where Claude Desktop keeps its file on each system', async () => {
    for (const [platform, expect] of [
      ['win32', (c) => path.win32.join(c.appdata, 'Claude', 'claude_desktop_config.json')],
      ['darwin', (c) => path.join(c.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
      ['linux', (c) => path.join(c.home, '.config', 'Claude', 'claude_desktop_config.json')],
    ]) {
      const ctx = sandboxHosts({ platform });
      const file = expect(ctx);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const h = (await detectHosts(ctx, ENTRY)).find((x) => x.id === 'claude-desktop');
      assert.equal(h?.where, file, platform);
    }
  });

  it('lists every tool once, with a plain name and how far its format is known', () => {
    const ids = HOSTS.map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const h of HOSTS) assert.ok(['tested', 'docs'].includes(h.tier) && h.name && h.hint, h.id);
  });
});

describe('asking the engine how to connect it', () => {
  const answer = (code, out) => async () => ({ code, out });
  it('takes the entry from the one JSON line the engine prints', async () => {
    assert.deepEqual(await readEntry('x.exe', answer(0, `noise\n${JSON.stringify(ENTRY)}\n`)), ENTRY);
  });
  it('refuses an engine that cannot say, or says something that is not an entry', async () => {
    for (const bad of [answer(1, ''), answer(0, 'hello'), answer(0, '{"command":5,"args":[],"env":{}}'), answer(0, '{"command":"x","args":"no","env":{}}'), answer(0, '{"command":"x","args":[1],"env":{}}'), answer(0, '{"command":"x","args":[],"env":{"A":1}}'), answer(0, '{"command":"","args":[],"env":{}}')]) {
      await assert.rejects(() => readEntry('x.exe', bad), PackError);
    }
  });
});

describe('choosing which tools to connect', () => {
  const found = [
    { id: 'a', state: 'new' },
    { id: 'b', state: 'connected' },
    { id: 'c', state: 'differs' },
    { id: 'd', state: 'unreadable' },
  ];
  it('takes everything that needs it for Enter, y or all, and nothing for n', () => {
    for (const a of ['', 'y', 'YES', 'all']) assert.deepEqual(chooseHosts(found, a).map((h) => h.id), ['a', 'c']);
    for (const a of ['n', 'no', 'None']) assert.deepEqual(chooseHosts(found, a), []);
  });
  it('takes the numbers typed, and never a tool that is already connected or cannot be read', () => {
    assert.deepEqual(chooseHosts(found, '1,3').map((h) => h.id), ['a', 'c']);
    assert.deepEqual(chooseHosts(found, '2 4'), []);
  });
  it('refuses a number that is not on the list', () => {
    assert.throws(() => chooseHosts(found, '9'), PackError);
    assert.throws(() => chooseHosts(found, 'one'), PackError);
  });
  it('reads --connect as all, none or a list of known tools', () => {
    const known = HOSTS.map((h) => h.id);
    assert.equal(parseConnect(undefined, known), undefined);
    assert.equal(parseConnect('ALL', known), 'all');
    assert.deepEqual(parseConnect('cursor, codex', known), ['cursor', 'codex']);
    assert.throws(() => parseConnect('cursor,nonsense', known), /--connect takes/);
    assert.throws(() => parseConnect('', known), PackError);
  });
});

describe('offering the connections after the engine is installed', () => {
  const setup = () => {
    const ctx = sandboxHosts();
    fs.mkdirSync(path.join(ctx.home, '.cursor'));
    fs.mkdirSync(path.join(ctx.home, '.codex'));
    write(path.join(ctx.home, '.gemini', 'settings.json'), '{ // hand written\n}');
    const lines = [];
    const questions = [];
    return { ctx, lines, questions, out: (l) => lines.push(l), askFn: async (q) => (questions.push(q), 'all'), entryOf: async () => ENTRY };
  };

  it('lists what it found with its state, asks once, and connects what was agreed', async () => {
    const s = setup();
    const r = await offerConnections({ exe: 'e.exe', ctx: s.ctx, out: s.out, askFn: s.askFn, entryOf: s.entryOf });
    assert.equal(s.questions.length, 1);
    const text = s.lines.join('\n');
    assert.match(text, /Cursor +not connected yet/);
    assert.match(text, /Gemini CLI +its settings file cannot be read/);
    assert.deepEqual(r.connected.sort(), ['codex', 'cursor']);
    assert.ok(fs.existsSync(cursorFile(s.ctx)));
    assert.match(text, /Connected Cursor\. To see Echlon there: restart Cursor/);
  });

  it('changes nothing for --connect none and does not ask', async () => {
    const s = setup();
    const r = await offerConnections({ exe: 'e.exe', choice: 'none', ctx: s.ctx, out: s.out, askFn: s.askFn, entryOf: s.entryOf });
    assert.equal(s.questions.length, 0);
    assert.deepEqual(r.connected, []);
    assert.ok(!fs.existsSync(cursorFile(s.ctx)));
    assert.match(s.lines.join('\n'), /No AI tool was changed/);
  });

  it('connects only the tools named, and connects all without asking when told to say yes', async () => {
    const s = setup();
    assert.deepEqual((await offerConnections({ exe: 'e', choice: ['cursor'], ctx: s.ctx, out: s.out, askFn: s.askFn, entryOf: s.entryOf })).connected, ['cursor']);
    assert.ok(!fs.existsSync(path.join(s.ctx.home, '.codex', 'config.toml')));
    const t = setup();
    await offerConnections({ exe: 'e', yes: true, ctx: t.ctx, out: t.out, askFn: t.askFn, entryOf: t.entryOf });
    assert.equal(t.questions.length, 0);
  });

  it('shows what to add by hand for a tool it would not touch, and leaves that file alone', async () => {
    const s = setup();
    const file = path.join(s.ctx.home, '.gemini', 'settings.json');
    const before = fs.readFileSync(file);
    const r = await offerConnections({ exe: 'e', choice: ['gemini'], ctx: s.ctx, out: s.out, askFn: s.askFn, entryOf: s.entryOf });
    assert.deepEqual(r.connected, []);
    assert.deepEqual(fs.readFileSync(file), before);
    const text = s.lines.join('\n');
    assert.match(text, /Could not connect Gemini CLI: settings\.json is not plain JSON/);
    assert.match(text, /To connect it by hand, add this:/);
    assert.match(text, /^ {6}"mcpServers": \{$/m, 'the entry is shown, indented, ready to copy');
    assert.ok(text.includes(ENTRY.command.replace(/\\/g, '\\\\')), 'and it names this engine');
  });

  it('says so and carries on when the engine cannot describe itself, or when nothing is found', async () => {
    const s = setup();
    const r = await offerConnections({ exe: 'e', ctx: s.ctx, out: s.out, askFn: s.askFn, entryOf: async () => { throw new PackError('This engine build could not describe how to connect it.'); } });
    assert.deepEqual(r, { connected: [], skipped: [], failed: [] });
    assert.match(s.lines.join('\n'), /could not describe how to connect it/);
    const empty = [];
    await offerConnections({ exe: 'e', ctx: sandboxHosts(), out: (l) => empty.push(l), askFn: async () => 'all', entryOf: async () => ENTRY });
    assert.match(empty.join('\n'), /No AI tool that Echlon connects to was found/);
  });
});

describe('the whole install, with the engine', () => {
  const keys = newKeys();
  const LIC = 'ech_lic_bothproducts0000000000000000';
  const go = async (extra, { hostCtx, entryOf = async () => ENTRY, answers = [] } = {}) => {
    const dir = tmpDir();
    const cfg = writeConfig(tmpDir(), keys.pubB64);
    const service = await startService({ licences: { [LIC]: { products: ['ui', 'engine'] } }, repos: buildFeeds({ privateKey: keys.privateKey, target: 'linux-x64' }) });
    const lines = [];
    const asked = [...answers];
    try {
      const code = await run(['--dir', dir, '--service', service.base, '--target', 'linux-x64', '--products', cfg.products, '--pubkey', cfg.pubkey, '--token-env', 'K', '--product', 'engine', ...extra], {
        env: { K: LIC },
        out: (l) => lines.push(l),
        askFn: async (q) => (lines.push(q), asked.shift() ?? ''),
        hostCtx,
        pathAdder: noPath,
    prereq: calm,
        entryOf,
      });
      return { code, text: lines.join('\n'), dir };
    } finally {
      await service.close();
    }
  };

  it('connects the tools it found after installing the engine, naming the installed engine in the entry it was given', async () => {
    const ctx = sandboxHosts();
    fs.mkdirSync(path.join(ctx.home, '.cursor'));
    const seen = [];
    const r = await go(['--yes'], { hostCtx: ctx, entryOf: async (exe) => (seen.push(exe), ENTRY) });
    assert.equal(r.code, 0, r.text);
    assert.ok(seen[0].startsWith(r.dir) && seen[0].endsWith('echlon-engine-linux-x64'), seen[0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile(ctx), 'utf8')).mcpServers.echlon, ENTRY);
    assert.match(r.text, /Connected Cursor/);
  });

  it('leaves the tools alone with --connect none, and refuses an option that is not a tool', async () => {
    const ctx = sandboxHosts();
    fs.mkdirSync(path.join(ctx.home, '.cursor'));
    const r = await go(['--connect', 'none'], { hostCtx: ctx });
    assert.equal(r.code, 0, r.text);
    assert.ok(!fs.existsSync(cursorFile(ctx)));
    await assert.rejects(() => go(['--connect', 'nonsense'], { hostCtx: ctx }), /--connect takes/);
  });

  it('does not offer anything when the engine was not installed', async () => {
    const ctx = sandboxHosts();
    fs.mkdirSync(path.join(ctx.home, '.cursor'));
    const r = await go(['--product', 'ui', '--yes'], { hostCtx: ctx });
    assert.ok(!/AI tools found/.test(r.text));
    assert.ok(!fs.existsSync(cursorFile(ctx)));
  });
});
