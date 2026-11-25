/**
 * What the customer sees while a long step runs. Plain ASCII on purpose: the same output has to read on
 * cmd.exe, Windows PowerShell, Windows Terminal and a Linux shell, and a block character that one of them
 * draws as a question mark would make the bar look broken.
 */
/** For callers that show nothing (a library use, most unit tests). */
export const quietProgress = { start: () => ({ update() {}, finish() {} }), working: (_label, work) => work };

export function formatBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** One line of the download bar, never longer than the window (a line that wraps cannot be redrawn in place). */
export function formatBar({ label, received, total, elapsedMs, columns = 80, width = 20 }) {
  const rate = elapsedMs > 0 ? `${formatBytes((received / elapsedMs) * 1000)}/s` : '';
  const known = Number.isFinite(total) && total > 0;
  const pct = known ? Math.min(100, Math.floor((received / total) * 100)) : null;
  const size = known ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received);
  const tailFor = (w, withRate) => {
    const filled = known ? Math.round((pct / 100) * w) : 0;
    const bar = known ? `${w > 0 ? `[${'#'.repeat(filled)}${'-'.repeat(w - filled)}] ` : ''}${String(pct).padStart(3)}%` : '';
    return [bar, size, withRate ? rate : ''].filter(Boolean).join('  ');
  };
  // Drop the least useful part first until at least a short name fits: a line that wraps cannot be redrawn in place.
  const MIN_NAME = 8;
  const fits = (t) => MIN_NAME + 2 + t.length <= columns - 1;
  const tail = [tailFor(width, true), tailFor(Math.min(width, 10), true), tailFor(Math.min(width, 10), false), tailFor(0, false)].find(fits) ?? tailFor(0, false);
  const room = Math.max(MIN_NAME, columns - 1 - tail.length - 2);
  const name = label.length > room ? `${label.slice(0, Math.max(0, room - 3))}...` : label;
  return `${name}  ${tail}`.slice(0, Math.max(columns - 1, 20));
}

/**
 * The customer's view of a download and of a setup step. On a terminal the bar redraws in place; anywhere else
 * (a pipe, a log) it prints a line at each tenth instead, so a file of output is not thousands of redraws.
 */
export function createProgress({ write, isTTY = false, columns = 80, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, tickMs = 1000 }) {
  return {
    start(label) {
      const began = now();
      let lastDraw = 0;
      let lastLen = 0;
      let lastTenth = -1;
      let received = 0;
      let total;
      const draw = (final) => {
        const line = formatBar({ label, received, total, elapsedMs: now() - began, columns });
        write(`\r${line}${' '.repeat(Math.max(0, lastLen - line.length))}${final ? '\n' : ''}`);
        lastLen = line.length;
      };
      return {
        update(r, t) {
          received = r;
          total = t;
          if (isTTY) {
            if (now() - lastDraw >= 100) {
              lastDraw = now();
              draw(false);
            }
          } else if (total > 0) {
            const tenth = Math.floor((received / total) * 10);
            if (tenth > lastTenth && tenth < 10) {
              lastTenth = tenth;
              write(`${label}: ${tenth * 10}% (${formatBytes(received)} / ${formatBytes(total)})\n`);
            }
          }
        },
        finish() {
          if (isTTY) draw(true);
          else write(`${label}: 100% (${formatBytes(received)})\n`);
        },
      };
    },

    /** A step with no byte count to show (installing a program's own files): the work it is on and how long it has taken. */
    async working(label, work) {
      const began = now();
      write(isTTY ? `${label} ...` : `${label} (this can take a few minutes)\n`);
      let lastLen = 0;
      const timer = setIntervalFn(() => {
        const line = `${label} ... ${formatElapsed(now() - began)}`;
        if (isTTY) {
          write(`\r${line}${' '.repeat(Math.max(0, lastLen - line.length))}`);
          lastLen = line.length;
        } else {
          write(`${line}\n`);
        }
      }, isTTY ? tickMs : 30_000);
      timer.unref?.();
      try {
        return await work;
      } finally {
        clearIntervalFn(timer);
        if (isTTY) write(`\r${label} ... ${formatElapsed(now() - began)} done${' '.repeat(10)}\n`);
      }
    },
  };
}
