import readline from 'node:readline';

/**
 * What a typed character does to a secret being entered: Enter ends it, Backspace removes one,
 * Ctrl-C cancels, anything printable is added. Pure, so it can be tested without a terminal.
 */
export function applyKey(buffer, ch) {
  if (ch === '\r' || ch === '\n') return { buffer, done: true };
  if (ch === '\u0003') return { buffer, cancelled: true };
  if (ch === '\u007f' || ch === '\b') return { buffer: buffer.slice(0, -1) };
  if (ch >= ' ') return { buffer: buffer + ch };
  return { buffer };
}

export function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/**
 * A secret, typed without being shown. On a terminal each key is read raw and nothing is echoed. When
 * input is piped (a script, a test) the first line is read instead; there is nothing to hide there.
 */
export function askHidden(question, { input = process.stdin, output = process.stdout } = {}) {
  output.write(question);
  if (!input.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input });
      rl.once('line', (l) => { rl.close(); output.write('\n'); resolve(l.trim()); });
      rl.once('close', () => resolve(''));
    });
  }
  return new Promise((resolve, reject) => {
    let buffer = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = (fn) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        const r = applyKey(buffer, ch);
        if (r.cancelled) return finish(() => reject(new Error('cancelled')));
        buffer = r.buffer;
        if (r.done) return finish(() => resolve(buffer.trim()));
      }
    };
    input.on('data', onData);
  });
}
