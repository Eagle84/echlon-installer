import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../installer/install.mjs';
import { PackError } from '../installer/lib/errors.mjs';
import { buildFeeds, calm, newKeys, noPath, sandboxHosts, startMock, tmpDir, writeConfig } from './helpers.mjs';

const GOOD = 'ghp_goodkey_00000000000000000000';
const TARGET = 'linux-x64';
const keys = newKeys();
let mock;
let cfg;
let needsNode;

before(() => {
  cfg = writeConfig(tmpDir(), keys.pubB64);
  // The same products, with the UI declaring that it needs Node 26, as the shipped products.json does.
  const p = JSON.parse(fs.readFileSync(cfg.products, 'utf8'));
  p.ui.requiresNode = 26;
  needsNode = path.join(tmpDir(), 'products.json');
  fs.writeFileSync(needsNode, JSON.stringify(p));
});
after(() => mock?.close());

async function go(extra = [], { prereq = {}, answers = [], products = needsNode, nodeMajor = 22 } = {}) {
  const dir = tmpDir();
  await mock?.close();
  mock = await startMock({ tokens: { [GOOD]: ['example/ui', 'example/engine'] }, repos: buildFeeds({ privateKey: keys.privateKey, target: TARGET }) });
  const lines = [];
  const queue = [...answers];
  const asked = [];
  const code = await run(['--dir', dir, '--api', mock.base, '--target', TARGET, '--products', products, '--pubkey', cfg.pubkey, '--token-env', 'PACK_KEY', ...extra], {
    env: { PACK_KEY: GOOD },
    out: (l) => lines.push(l),
    askFn: async (q) => (asked.push(q), queue.shift() ?? ''),
    runCommand: () => {},
    hostCtx: sandboxHosts(),
    pathAdder: noPath,
    nodeMajor,
    prereq: { ...calm, ...prereq },
  }).catch((e) => {
    if (e instanceof PackError) {
      lines.push(e.message);
      return 1;
    }
    throw e;
  });
  return { dir, lines, text: lines.join('\n'), code, asked };
}

describe('a product that needs a newer Node than this computer has', () => {
  it('is given a Node of its own: asked for the right version, and the UI start script puts it first', async () => {
    const seen = [];
    const ensure = async (o) => (seen.push({ min: o.minMajor, have: o.haveMajor, name: o.name }), { major: 26, binDir: path.join(tmpDir(), 'node-bin'), via: 'runtime' });
    const r = await go(['--product', 'ui'], { prereq: { ensureNode: ensure } });
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(seen, [{ min: 26, have: 22, name: 'Echlon UI' }]);
    const launcher = fs.readFileSync(path.join(r.dir, process.platform === 'win32' ? 'start-ui.cmd' : 'start-ui.sh'), 'utf8');
    assert.match(launcher, process.platform === 'win32' ? /set "PATH=.*node-bin;%PATH%"/ : /PATH='.*node-bin':"\$PATH"/);
  });

  it('leaves the start script alone when this computer\'s own Node is new enough', async () => {
    const r = await go(['--product', 'ui'], { nodeMajor: 26, prereq: { ensureNode: async () => ({ major: 26, via: 'system' }) } });
    assert.equal(r.code, 0, r.text);
    const launcher = fs.readFileSync(path.join(r.dir, process.platform === 'win32' ? 'start-ui.cmd' : 'start-ui.sh'), 'utf8');
    assert.ok(!/PATH/.test(launcher.replace(/%PATH%/g, '')), 'no PATH line');
  });

  it('is told "no" cleanly: the UI is not installed, the engine still is, and the exit code says so', async () => {
    const refuse = async () => {
      throw new PackError('Echlon UI cannot run without Node 26 or newer, so it was not installed.');
    };
    const r = await go(['--product', 'both'], { prereq: { ensureNode: refuse } });
    assert.equal(r.code, 1);
    assert.match(r.text, /Not installed - Echlon UI: Echlon UI cannot run without Node 26/);
    assert.ok(fs.existsSync(path.join(r.dir, 'engine', '2.0.0')), 'the engine does not need that Node');
    assert.ok(!fs.existsSync(path.join(r.dir, 'ui')));
  });

  it('is never asked about for the engine, which needs no Node at all', async () => {
    let called = 0;
    const r = await go(['--product', 'engine'], { prereq: { ensureNode: async () => (called++, { major: 26, via: 'system' }) } });
    assert.equal(r.code, 0, r.text);
    assert.equal(called, 0);
  });

  it('asks before downloading, and --yes answers it', async () => {
    const asks = [];
    const ensure = async (o) => (asks.push(await o.confirm()), { major: 26, binDir: tmpDir(), via: 'runtime' });
    const typed = await go(['--product', 'ui'], { prereq: { ensureNode: ensure }, answers: ['n'] });
    assert.equal(typed.code, 0, typed.text);
    assert.deepEqual(asks, [false]);
    assert.ok(typed.asked.some((q) => /Download it now\?/.test(q)));
    asks.length = 0;
    const unattended = await go(['--product', 'ui', '--yes'], { prereq: { ensureNode: ensure } });
    assert.deepEqual(asks, [true]);
    assert.ok(!unattended.asked.some((q) => /Download it now\?/.test(q)));
  });
});

describe('what is checked about this computer', () => {
  it('refuses a drive that is nearly full before anything is downloaded', async () => {
    const r = await go(['--product', 'engine'], { prereq: { statfs: () => ({ bavail: 1000, bsize: 4096 }) } });
    assert.equal(r.code, 1);
    assert.match(r.text, /not enough free space/);
    assert.equal(mock.log.api.length, 0, 'GitHub was never asked for anything');
  });

  it('does not refuse when it cannot tell how much space there is', async () => {
    const r = await go(['--product', 'engine'], { prereq: { statfs: () => { throw new Error('unsupported'); } } });
    assert.equal(r.code, 0, r.text);
  });

  it('says so when a port the products use is already taken, and carries on', async () => {
    const r = await go(['--product', 'both'], { prereq: { ensureNode: async () => ({ major: 26, via: 'system' }), portFree: async (p) => p === 4180 } });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /port 3737/);
    assert.ok(!/port 4180/.test(r.text));
    const ui = await go(['--product', 'ui'], { prereq: { ensureNode: async () => ({ major: 26, via: 'system' }), portFree: async (p) => p !== 4180 } });
    assert.match(ui.text, /port 4180/);
  });
});

describe('Claude Code, which only echlon-op needs', () => {
  const missing = { which: () => undefined };

  it('is not mentioned when it is already there, or when no engine was installed', async () => {
    const there = await go(['--product', 'engine']);
    assert.ok(!/Claude Code is not installed/.test(there.text));
    const noEngine = await go(['--product', 'ui'], { prereq: { ...missing, ensureNode: async () => ({ major: 26, via: 'system' }) } });
    assert.ok(!/Claude Code/.test(noEngine.text));
  });

  it('is offered when it is missing, and left alone by default: it is a script from the internet', async () => {
    let ran = 0;
    const r = await go(['--product', 'engine'], { prereq: { ...missing, installClaude: async () => (ran++, true) } });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /Claude Code is not installed/);
    assert.ok(r.asked.some((q) => /Install Claude Code now/.test(q) && /\(y\/N\)/.test(q)), 'the default is no');
    assert.equal(ran, 0);
  });

  it('is installed when the answer is yes, and a failure is reported without failing the install', async () => {
    let ran = 0;
    const yes = await go(['--product', 'engine'], { prereq: { ...missing, installClaude: async () => (ran++, true) }, answers: ['', 'y'] });
    assert.equal(ran, 1);
    assert.match(yes.text, /Claude Code is installed\. Open a new terminal/);
    const bad = await go(['--product', 'engine'], { prereq: { ...missing, installClaude: async () => false }, answers: ['', 'y'] });
    assert.equal(bad.code, 0, bad.text);
    assert.match(bad.text, /could not be installed/);
  });

  it('is installed without asking only when --install-claude says so; --yes alone never runs it', async () => {
    let ran = 0;
    const spy = { ...missing, installClaude: async () => (ran++, true) };
    const flagged = await go(['--product', 'engine', '--install-claude'], { prereq: spy });
    assert.equal(ran, 1);
    assert.ok(!flagged.asked.some((q) => /Install Claude Code now/.test(q)));
    ran = 0;
    const yesOnly = await go(['--product', 'engine', '--yes'], { prereq: spy });
    assert.equal(ran, 0);
    assert.ok(!yesOnly.asked.some((q) => /Install Claude Code now/.test(q)));
  });
});
