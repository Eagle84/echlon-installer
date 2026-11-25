import { PackError } from './errors.mjs';
import { connectHost, detectHosts, readEntry } from './hosts.mjs';

const STATE_TEXT = {
  new: 'not connected yet',
  connected: 'already connected',
  differs: 'connected to another copy (will be updated)',
  unreadable: 'its settings file cannot be read (will not be touched)',
};

/** Which of the listed tools to connect, from what the customer typed. Pure, so every answer can be tested. */
export function chooseHosts(found, answer) {
  const wanted = found.filter((h) => h.state === 'new' || h.state === 'differs');
  const text = String(answer ?? '').trim().toLowerCase();
  if (text === '' || text === 'y' || text === 'yes' || text === 'a' || text === 'all') return wanted;
  if (text === 'n' || text === 'no' || text === 'none') return [];
  const picked = new Set();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > found.length) throw new PackError(`"${part}" is not one of the numbers on the list.`);
    picked.add(n - 1);
  }
  return found.filter((_, i) => picked.has(i) && (found[i].state === 'new' || found[i].state === 'differs'));
}

/** The ids named with `--connect`: `all`, `none`, or a list. */
export function parseConnect(value, known) {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'all' || v === 'none') return v;
  const ids = v.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = ids.filter((x) => !known.includes(x));
  if (!ids.length || bad.length) throw new PackError(`--connect takes all, none, or a list of: ${known.join(', ')}.`);
  return ids;
}

/**
 * After the engine is installed: find the AI tools on this computer, say what was found, and connect the ones
 * the customer agrees to. Nothing is changed without that agreement, and a tool whose settings cannot be read
 * is left alone and the customer is shown what to add by hand.
 */
export async function offerConnections({ exe, choice, yes = false, ctx, out, askFn, entryOf = readEntry }) {
  let entry;
  try {
    entry = await entryOf(exe);
  } catch (e) {
    if (!(e instanceof PackError)) throw e;
    out(e.message);
    return { connected: [], skipped: [], failed: [] };
  }

  const found = await detectHosts(ctx, entry);
  if (!found.length) {
    out('No AI tool that Echlon connects to was found on this computer. When you install one, run this installer again to connect it.');
    return { connected: [], skipped: [], failed: [] };
  }

  out('');
  out('AI tools found on this computer:');
  found.forEach((h, i) => out(`  ${i + 1}) ${h.name.padEnd(20)} ${STATE_TEXT[h.state]}${h.tier === 'docs' && h.state !== 'unreadable' ? '  [not yet tested with this tool]' : ''}`));

  let chosen;
  if (choice === 'none') chosen = [];
  else if (choice === 'all') chosen = chooseHosts(found, 'all');
  else if (Array.isArray(choice)) chosen = found.filter((h) => choice.includes(h.id) && h.state !== 'connected');
  else if (yes) chosen = chooseHosts(found, 'all');
  else chosen = chooseHosts(found, await askFn('Connect Echlon Engine to these? (Enter = all that need it, n = none, or numbers such as 1,3): '));

  // A tool whose settings cannot be read is still tried when the customer is connecting anything: trying it
  // changes nothing (it is refused), and the refusal is what shows them what to add by hand.
  if (chosen.length && !Array.isArray(choice)) chosen = [...chosen, ...found.filter((h) => h.state === 'unreadable')];

  const result = { connected: [], skipped: found.filter((h) => !chosen.includes(h)).map((h) => h.id), failed: [] };
  for (const h of chosen) {
    const r = await connectHost(h.id, ctx, entry);
    if (r.status === 'added' || r.status === 'updated') {
      result.connected.push(h.id);
      out(`Connected ${h.name}${r.status === 'updated' ? ' (updated)' : ''}. To see Echlon there: ${h.hint}.`);
      if (r.backup) out(`  Its previous settings were kept as ${r.backup}`);
    } else if (r.status === 'unchanged') {
      out(`${h.name} was already connected.`);
    } else {
      result.failed.push(h.id);
      out(`Could not connect ${h.name}: ${r.detail}.`);
      if (r.manual) {
        out('  To connect it by hand, add this:');
        for (const line of r.manual.split('\n')) out(`    ${line}`);
      }
    }
  }
  if (!chosen.length) out('No AI tool was changed. You can run this installer again later to connect them.');
  return result;
}
