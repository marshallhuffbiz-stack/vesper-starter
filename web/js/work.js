// Work cards (11-11): a Claude job the team started, as one card in the bot's thread that changes in place.
// While it works: who started it, the job in his own words, the plan with ticks, a thin progress line and when it
// last moved. When it ends: Claude's own short result, the files, and Reply to Claude / Looks good. His reply goes
// back into the same Claude conversation (the server hands it to the service that owns the card).
import { h, icon, fmtTime, toMs } from './util.js';
import { firstName } from './store.js';
import { fileTile } from './docs.js';
import { clientOf } from './marks.js';

export const WORK_FINISHED = new Set(['done', 'needs_you', 'failed', 'stopped']);
const WORDS = { queued: 'waiting to start', working: 'working', done: 'finished', needs_you: 'needs you', failed: 'did not finish', stopped: 'stopped' };
export const workWord = (state) => WORDS[state] || state || '';
export const isWork = (m) => m?.kind === 'work' && !!m.work;

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));
export function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = minutes(ms);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`; };
const clientShort = (name) => (name ? clientOf(name)?.short || name : '');

// The chat list's line for a work card, and the live line's words.
export function workPreview(m) {
  const w = m.work;
  return `Claude: ${w.title} · ${w.acked_at ? 'looks good' : workWord(w.state)}`;
}
export function workStep(w) {
  const steps = w.steps || [];
  return steps.find((s) => !s.done)?.text || '';
}

function stepRow(s, current) {
  const mark = s.done ? h('span', { class: 'wc-tick', 'aria-hidden': 'true' }, icon('check'))
    : current ? h('span', { class: 'wc-spin', 'aria-hidden': 'true' }) : h('span', { class: 'wc-ring', 'aria-hidden': 'true' });
  return h('li', { class: `wc-step${s.done ? ' done' : current ? ' now' : ''}` }, mark, h('span', {}, s.text));
}

function header(m, w, by) {
  const bits = ['Claude'];
  if (w.state === 'done') {
    const end = w.finished_at || toMs(m.edited_at || m.at);
    bits.push(`finished ${fmtTime(end)}`);
    const took = w.started_at ? duration(end - w.started_at) : '';
    if (took) bits.push(took);
  } else if (WORK_FINISHED.has(w.state)) {
    bits.push(workWord(w.state));
    if (w.finished_at) bits.push(fmtTime(w.finished_at));
  } else {
    bits.push(`started by ${by}`);
    if (w.client) bits.push(clientShort(w.client));
  }
  return h('div', { class: 'wc-by' }, h('span', { class: 'pc-dot', 'aria-hidden': 'true' }), h('span', {}, bits.join(' · ')));
}

function earlier(m, w, open) {
  const rounds = (w.rounds || []).filter((r) => r.result || r.reply);
  if (!rounds.length) return null;
  const btn = h('button', { class: 'wc-earlier-btn', type: 'button', dataset: { workEarlier: m.id }, 'aria-expanded': String(open) },
    open ? 'Hide earlier' : `Earlier${rounds.length > 1 ? ` (${rounds.length})` : ''}`);
  if (!open) return h('div', { class: 'wc-earlier' }, btn);
  return h('div', { class: 'wc-earlier open' }, btn, ...rounds.map((r) => h('div', { class: 'wc-round' },
    r.result ? h('div', { class: 'wc-round-res' }, r.result) : null,
    r.finished_at ? h('div', { class: 'wc-round-at' }, `Finished ${fmtTime(r.finished_at)}`) : null,
    r.reply ? h('div', { class: 'wc-round-reply' }, h('span', {}, 'You replied'), r.reply) : null)));
}

// The card itself. opts: { by: bot id, open: Earlier is open, acking: Looks good is on its way }.
export function workCard(m, { open = false, acking = false } = {}) {
  const w = m.work;
  const by = firstName(m.sender);
  const finished = WORK_FINISHED.has(w.state);
  const steps = w.steps || [];
  const nowIdx = w.state === 'working' ? steps.findIndex((s) => !s.done) : -1;
  const lastReply = (w.rounds || []).at(-1)?.reply;
  const kids = [header(m, w, by), h('div', { class: 'wc-title' }, w.title)];
  if (w.ask && !finished) kids.push(h('div', { class: 'wc-ask' }, h('span', { class: 'wc-k' }, 'You asked: '), w.ask));
  if (lastReply && !finished) kids.push(h('div', { class: 'wc-ask wc-replied' }, h('span', { class: 'wc-k' }, 'You replied: '), lastReply));
  if (!finished) {
    if (steps.length) kids.push(h('ul', { class: 'wc-steps' }, steps.map((s, i) => stepRow(s, i === nowIdx))));
    if (w.state === 'working') {
      const done = steps.filter((s) => s.done).length;
      const pct = steps.length ? Math.max(10, Math.round((done / steps.length) * 100)) : 12;
      kids.push(h('div', { class: `wc-bar${steps.length ? '' : ' wc-bar-idle'}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Progress' },
        h('i', { style: { width: `${pct}%` } })));
    }
    const line = w.note || (w.state === 'queued' ? 'Waiting for a free slot. It starts on its own.'
      : w.active_at ? `Last activity ${ago(w.active_at)}` : w.started_at ? `Started ${fmtTime(w.started_at)}` : 'Starting');
    kids.push(h('div', { class: 'wc-foot' }, h('span', { class: 'wc-note' }, line),
      w.url && w.state !== 'queued' ? h('a', { class: 'wc-open', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open session') : null));
  } else {
    const text = w.result || w.note || (w.state === 'stopped' ? 'Its session stopped before it finished.' : w.state === 'failed' ? 'It did not finish.' : '');
    if (text) kids.push(h('div', { class: `wc-result${w.state === 'failed' || w.state === 'stopped' ? ' bad' : ''}` }, text));
    if (w.result && w.note) kids.push(h('div', { class: 'wc-foot' }, h('span', { class: 'wc-note' }, w.note)));
    const files = m.attachments || [];
    if (files.length) {
      const item = { id: m.id, chat_id: m.chat_id, by: m.sender, doc: m.doc || { title: w.title }, files, waiting: false };
      kids.push(h('div', { class: 'wc-files' }, ...files.map((f) => fileTile(f, { files, item }))));
    }
    kids.push(earlier(m, w, open));
    if (w.acked_at || acking) {
      kids.push(h('div', { class: 'wc-acked' },
        h('span', { class: 'wc-acked-tx' }, icon('check'), h('span', {}, `Looks good${w.acked_at ? ` · ${fmtTime(w.acked_at)}` : ''}`)),
        h('button', { class: 'wc-link', type: 'button', dataset: { workReply: m.id } }, 'Reply to Claude')));
    } else {
      const good = w.state === 'done';
      kids.push(h('div', { class: 'wc-btns' },
        h('button', { class: `wc-btn${good ? '' : ' dark'}`, type: 'button', dataset: { workReply: m.id } }, 'Reply to Claude'),
        good ? h('button', { class: 'wc-btn dark', type: 'button', dataset: { workAck: m.id } }, 'Looks good') : null));
    }
    if (w.url && w.state !== 'done') kids.push(h('div', { class: 'wc-foot' }, h('span', { class: 'wc-note' }, ''), h('a', { class: 'wc-open', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open session')));
  }
  return h('div', { class: `wc st-${w.state}`, dataset: { id: m.id, job: w.job } }, ...kids.filter(Boolean));
}
