// System (11-09): one honest list of what Vesper depends on, behind the quiet line at the bottom of home.
// GET /api/system: each check is ok, warn or bad, in plain words. Home shows only the headline; the sheet shows all.
import { h } from './util.js';
import { api } from './api.js';
import { sheet, sheetTop } from './sheet.js';
import { avatar } from './avatar.js';

let status = null;
const listeners = new Set();
export const onSystem = (fn) => listeners.add(fn);
export const systemStatus = () => status;

let loading = null;
export function loadSystem() {
  if (loading) return loading;
  loading = api('/api/system', { timeout: 10000 }).then((d) => { status = d; }, (e) => {
    // No answer at all is itself the news (a 404 is an older server: stay silent).
    if (e?.status === 0) status = { level: 'bad', headline: 'Can’t reach the Mac', checks: [], unreachable: true };
  }).finally(() => { loading = null; listeners.forEach((f) => f(status)); });
  return loading;
}

const WORD = { ok: 'OK', warn: 'Check', bad: 'Problem' };
function checkRow(c) {
  const bot = /^bot:(\w+)$/.exec(c.key)?.[1];
  return h('div', { class: `sys-row ${c.level}` },
    bot ? avatar(bot, 30, { dot: false }) : h('span', { class: `sys-dot ${c.level}`, 'aria-hidden': 'true' }),
    h('span', { class: 'sys-tx' }, h('b', {}, c.label), h('span', {}, c.detail)),
    h('span', { class: `sys-st ${c.level}` }, WORD[c.level] || ''));
}

// A bot error (11-11): what Hermes wrote into a thread as if the bot said it. A plain line, who and when, and the
// raw words behind a disclosure, so the thread stays clean and nothing is lost.
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// The same error from the same bot again (a routine failing every run) is one row that says how many times.
function sameErrors(items) {
  const out = [];
  for (const e of items) {
    const prev = out.find((x) => x.bot === e.bot && x.plain === e.plain);
    if (prev) prev.times++; else out.push({ ...e, times: 1 });
  }
  return out;
}
function errorRow(e) {
  return h('div', { class: `sys-row sys-err ${e.plan ? 'bad' : 'warn'}` },
    avatar(e.bot, 30, { dot: false }),
    h('span', { class: 'sys-tx' }, h('b', {}, e.plain), h('span', { class: 'num' }, `${e.name} \u00b7 ${e.times > 1 ? `${e.times} times, last at ` : ''}${clock(e.at)}`),
      h('details', { class: 'sys-raw' }, h('summary', {}, 'What Hermes wrote'), h('pre', {}, e.raw))));
}

export function openSystem() {
  const head = h('div', { class: 'sys-head' });
  const body = h('div', { class: 'sys-body' });
  const again = h('button', { class: 'lt-link', type: 'button' }, 'Check again');
  sheet('System', 'sys-sheet', sheetTop('System'), head, body, h('div', { class: 'lt-links' }, again));
  const paint = () => {
    const s = status;
    if (!s) { head.replaceChildren(h('div', { class: 'sys-big' }, 'Checking…')); body.replaceChildren(); return; }
    head.replaceChildren(
      h('div', { class: `sys-big ${s.level}` }, s.level === 'ok' ? 'Everything is running' : s.level === 'warn' ? 'Running, with something to check' : 'Something needs attention'),
      s.level !== 'ok' ? h('div', { class: 'sys-why' }, s.headline) : null);
    const bots = (s.checks || []).filter((c) => c.key.startsWith('bot:'));
    const errs = (s.checks || []).find((c) => c.key === 'bot-errors');
    const rest = (s.checks || []).filter((c) => !c.key.startsWith('bot:') && c !== errs);
    body.replaceChildren(...[
      bots.length ? h('div', { class: 'sec-label' }, 'The team') : null, bots.length ? h('div', { class: 'cells sys-cells' }, bots.map(checkRow)) : null,
      errs?.items?.length ? h('div', { class: 'sec-label' }, errs.items.length === 1 ? '1 bot error today' : `${errs.items.length} bot errors today`) : null,
      errs?.items?.length ? h('div', { class: 'cells sys-cells' }, sameErrors(errs.items).map(errorRow)) : null,
      rest.length ? h('div', { class: 'sec-label' }, 'The Mac') : null, rest.length ? h('div', { class: 'cells sys-cells' }, rest.map(checkRow)) : null,
      s.build ? h('div', { class: 'sys-build num' }, `Version ${String(s.build).slice(0, 7)}`) : null].filter(Boolean));
  };
  const off = (s) => { if (document.body.contains(body)) paint(); else listeners.delete(off); };
  listeners.add(off);
  again.addEventListener('click', async () => { again.disabled = true; again.textContent = 'Checking…'; await loadSystem(); again.disabled = false; again.textContent = 'Check again'; });
  paint();
  loadSystem();
}
