import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { saveBody } from '../installer/lib/download.mjs';
import { PassThrough } from 'node:stream';
import { applyKey, askHidden } from '../installer/lib/prompt.mjs';
import { createProgress, formatBar, formatBytes, formatElapsed } from '../installer/lib/progress.mjs';
import { tmpDir } from './helpers.mjs';

describe('the download bar', () => {
  it('shows a bar, a percentage, the sizes and the speed', () => {
    const line = formatBar({ label: 'Echlon UI 1.0.0', received: 50e6, total: 100e6, elapsedMs: 5000 });
    assert.match(line, /^Echlon UI 1\.0\.0 {2}\[#{10}-{10}\] {2}50% {2}50\.0 MB \/ 100\.0 MB {2}10\.0 MB\/s$/);
  });

  it('is empty at the start and full at the end, and never past 100', () => {
    assert.match(formatBar({ label: 'x', received: 0, total: 100, elapsedMs: 0 }), /\[-{20}\] {3}0%/);
    assert.match(formatBar({ label: 'x', received: 100, total: 100, elapsedMs: 1 }), /\[#{20}\] 100%/);
    assert.match(formatBar({ label: 'x', received: 500, total: 100, elapsedMs: 1 }), /\[#{20}\] 100%/);
  });

  it('shows just the size when the total is not known', () => {
    const line = formatBar({ label: 'x', received: 2e6, total: undefined, elapsedMs: 1000 });
    assert.ok(!line.includes('[') && !line.includes('%'));
    assert.match(line, /2\.0 MB/);
  });

  it('is plain ASCII and fits the window, shortening the name before anything else', () => {
    for (const columns of [60, 80, 120]) {
      const line = formatBar({ label: 'Echlon Engine with a name that is far too long to fit', received: 5e6, total: 9e6, elapsedMs: 800, columns });
      assert.ok(line.length <= columns - 1, `${line.length} > ${columns - 1}`);
      assert.match(line, /^[\x20-\x7e]+$/);
      assert.match(line, /\d+%/, 'the numbers are kept');
      assert.match(line, /\d+(\.\d+)? [KMG]?B( \/ \d+(\.\d+)? [KMG]?B)?( {2}\d+(\.\d+)? [KMG]?B\/s)?$/, 'it ends on a whole figure, not cut through one');
      if (columns <= 80) assert.ok(line.includes('...'), 'it is the name that was shortened');
    }
  });

  it('formats sizes and times', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(385e6), '385.0 MB');
    assert.equal(formatBytes(2.5e9), '2.50 GB');
    assert.equal(formatElapsed(45_000), '45s');
    assert.equal(formatElapsed(125_000), '2m 05s');
  });
});

describe('showing progress', () => {
  it('on a terminal, redraws one line in place and ends it with a newline at the end', () => {
    const out = [];
    let t = 0;
    const p = createProgress({ write: (s) => out.push(s), isTTY: true, now: () => t });
    const bar = p.start('Echlon UI 1.0.0');
    for (const received of [10, 20, 30, 40]) {
      t += 200;
      bar.update(received, 40);
    }
    bar.finish();
    assert.ok(out.length >= 5);
    assert.ok(out.every((s) => s.startsWith('\r')), 'each draw returns to the start of the line');
    assert.ok(out.slice(0, -1).every((s) => !s.includes('\n')), 'and does not add a line');
    assert.ok(out.at(-1).endsWith('\n'));
    assert.match(out.at(-1), /100%/);
  });

  it('does not redraw faster than it can be read', () => {
    const out = [];
    let t = 0;
    const bar = createProgress({ write: (s) => out.push(s), isTTY: true, now: () => t }).start('x');
    for (let i = 1; i <= 1000; i++) {
      t += 1;
      bar.update(i, 1000);
    }
    assert.ok(out.length < 30, `${out.length} draws for 1000 updates over 1s`);
  });

  it('clears what a longer earlier line left behind', () => {
    const out = [];
    let t = 0;
    const bar = createProgress({ write: (s) => out.push(s), isTTY: true, now: () => t }).start('x');
    t += 500;
    bar.update(1e9, 2e9);
    t += 500;
    bar.update(5, 2e9);
    assert.ok(out[1].length > out[0].replace('\r', '').length - 1 || /\s$/.test(out[1]), 'the shorter line is padded');
  });

  it('with no terminal, prints a line per tenth and a last line, not a redraw per chunk', () => {
    const out = [];
    const bar = createProgress({ write: (s) => out.push(s), isTTY: false }).start('Echlon UI 1.0.0');
    for (let i = 1; i <= 1000; i++) bar.update(i, 1000);
    bar.finish();
    assert.equal(out.length, 11, out.join(''));
    assert.ok(out.every((s) => s.endsWith('\n') && !s.includes('\r')));
    assert.match(out[0], /Echlon UI 1\.0\.0: 0% /);
    assert.match(out.at(-1), /100%/);
  });

  it('counts a setup step in seconds while it runs, and says so when it is done', async () => {
    const out = [];
    let t = 0;
    let tick;
    const p = createProgress({
      write: (s) => out.push(s),
      isTTY: true,
      now: () => t,
      setIntervalFn: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    let finish;
    const work = new Promise((r) => (finish = r));
    const done = p.working('Setting up Echlon UI', work);
    t += 3000;
    tick();
    t += 62_000;
    tick();
    finish('result');
    assert.equal(await done, 'result');
    const text = out.join('');
    assert.match(text, /Setting up Echlon UI \.\.\. 3s/);
    assert.match(text, /1m 05s/);
    assert.match(text, /done/);
  });

  it('stops counting when the step fails, and passes the failure on', async () => {
    let cleared = false;
    const p = createProgress({ write: () => {}, isTTY: true, setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => (cleared = true) });
    await assert.rejects(() => p.working('x', Promise.reject(new Error('npm failed'))), /npm failed/);
    assert.equal(cleared, true);
  });
});

describe('saving a download', () => {
  const body = (chunks) => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }), { headers: { 'content-length': String(chunks.reduce((n, c) => n + c.length, 0)) } });

  it('writes every byte and reports the running count against the declared length', async () => {
    const file = path.join(tmpDir(), 'f.bin');
    const chunks = [Buffer.alloc(1000, 1), Buffer.alloc(2000, 2), Buffer.alloc(500, 3)];
    const seen = [];
    const total = await saveBody(body(chunks), file, (r, t) => seen.push([r, t]), undefined);
    assert.equal(total, 3500);
    assert.equal(fs.statSync(file).size, 3500);
    assert.deepEqual(seen.map(([r]) => r), [1000, 3000, 3500]);
    assert.ok(seen.every(([, t]) => t === 3500));
  });

  it('falls back to the size the release listed when the server declares none', async () => {
    const file = path.join(tmpDir(), 'f.bin');
    const res = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(10)); c.close(); } }));
    const seen = [];
    await saveBody(res, file, (r, t) => seen.push(t), 4242);
    assert.deepEqual(seen, [4242]);
  });
});

describe('typing the key', () => {
  it('shows an asterisk for each character and takes one back on backspace', () => {
    assert.equal(applyKey('', 'e').echo, '*');
    assert.equal(applyKey('e', 'c').echo, '*');
    assert.equal(applyKey('ec', '\u007f').echo, '\b \b');
    assert.equal(applyKey('ec', '\b').echo, '\b \b');
  });

  it('draws nothing for a backspace with nothing to remove, or for Enter, Ctrl-C and control keys', () => {
    assert.equal(applyKey('', '\u007f').echo, '');
    assert.equal(applyKey('ab', '\r').echo, '');
    assert.equal(applyKey('ab', '\u0003').echo, '');
    assert.equal(applyKey('ab', '\u001b').echo, '');
  });

  it('never puts the character itself in what is drawn', () => {
    for (const ch of 'ech_lic_SECRET0123') assert.ok(!applyKey('', ch).echo.includes(ch) || ch === '*');
  });
});

describe('the masked prompt on a terminal', () => {
  function terminal() {
    const input = new PassThrough();
    input.isTTY = true;
    input.rawModes = [];
    input.setRawMode = (on) => input.rawModes.push(on);
    const output = new PassThrough();
    let drawn = '';
    output.on('data', (c) => (drawn += c));
    return { input, output, drawn: () => drawn };
  }

  it('draws an asterisk per character, takes one back on backspace, and returns what was typed', async () => {
    const t = terminal();
    const p = askHidden('Access key: ', t);
    t.input.write('abc');
    t.input.write('\u007f');
    t.input.write('d\r');
    assert.equal(await p, 'abd');
    const drawn = t.drawn();
    assert.ok(drawn.startsWith('Access key: '));
    assert.equal(drawn.replace('Access key: ', ''), '***\b \b*\n');
    assert.ok(!/[abcd]/.test(drawn.replace('Access key: ', '')), 'no typed character is ever drawn');
  });

  it('handles a pasted key arriving in one piece, and puts the terminal back as it was', async () => {
    const t = terminal();
    const p = askHidden('Access key: ', t);
    t.input.write('ech_lic_0123456789\r');
    assert.equal(await p, 'ech_lic_0123456789');
    assert.equal(t.drawn().replace('Access key: ', ''), `${'*'.repeat(18)}\n`);
    assert.deepEqual(t.input.rawModes, [true, false]);
  });

  it('puts the terminal back and fails when the customer cancels with Ctrl-C', async () => {
    const t = terminal();
    const p = askHidden('Access key: ', t);
    t.input.write('ab\u0003');
    await assert.rejects(p, /cancelled/);
    assert.deepEqual(t.input.rawModes, [true, false]);
  });
});
