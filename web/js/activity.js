// Activity (11-09): everything the team did or asked, as rows, behind "Catch me up" on home. The paragraph that
// used to sit there ran to six lines on a busy day; home now shows the counts and this sheet holds the record.
// Each row: the app it touched, what it was, who and which client, when, and how it ended. Tap one to open its card.
import { h, toast } from './util.js';
import { api } from './api.js';
import { sheet, sheetTop } from './sheet.js';
import { appMark, appFor, pairOf, clientMark } from './marks.js';

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayLabel(t, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const TONE = { failed: 'bad', posted: 'wait', refused: 'bad' };

function row(x) {
  const title = cap(x.what) || 'Action';
  const app = x.kind === 'text' ? 'sms' : x.kind === 'email' ? 'gmail' : appFor(title);
  const sub = [x.who, x.client, clock(x.at)].filter(Boolean).join(' · ');
  const word = x.auto && (x.status === 'done' || x.status === 'unconfirmed') ? `${x.word} on its own` : x.word;
  return h('button', { class: 'act-row', type: 'button', dataset: { card: x.id }, 'aria-label': `${title}. ${sub}. ${word}. Open the card.` },
    appMark(app, 36, pairOf(app, title)),
    h('span', { class: 'act-tx' }, h('b', {}, title), h('span', { class: 'act-sub' }, x.client ? clientMark(x.client, 14) : null, h('span', {}, sub))),
    h('span', { class: `act-st ${TONE[x.status] || ''}` }, word));
}

const RANGES = [['left', 'Since you left'], ['today', 'Today'], ['week', '7 days']];

export function openActivity({ since = null, openAt = () => {} } = {}) {
  let range = since ? 'left' : 'today';
  const seg = h('div', { class: 'rt-seg act-seg', role: 'group', 'aria-label': 'Period' },
    RANGES.filter(([k]) => k !== 'left' || since).map(([k, label]) => h('button', { type: 'button', class: k === range ? 'on' : '', dataset: { range: k }, 'aria-pressed': String(k === range) }, label)));
  const sum = h('div', { class: 'act-sum' }, ' ');
  const body = h('div', { class: 'act-body' }, h('div', { class: 'act-empty' }, 'Loading…'));
  const { ov, close } = sheet('Activity', 'act-sheet', sheetTop('Activity'), seg, sum, body);
  let seq = 0;

  async function load() {
    const my = ++seq;
    const from = range === 'left' ? since : range === 'today' ? startOfDay(Date.now()) : Date.now() - 7 * DAY;
    let d;
    try { d = await api(`/api/activity?since=${Math.round(from)}`); } catch { d = null; }
    if (my !== seq) return;
    if (!d || d.ok === false) { sum.textContent = ' '; body.replaceChildren(h('div', { class: 'act-empty' }, 'The team’s record is not readable right now.')); return; }
    const items = (d.items || []).filter((x) => x.at >= from || x.status === 'posted');
    const c = d.counts || {};
    sum.textContent = [c.done ? `${c.done} done` : null, c.auto ? `${c.auto} on ${c.auto === 1 ? 'its' : 'their'} own` : null, c.waiting ? `${c.waiting} waiting on you` : null, c.failed ? `${c.failed} failed` : null]
      .filter(Boolean).join(' · ') || 'Nothing yet';
    if (!items.length) { body.replaceChildren(h('div', { class: 'act-empty' }, range === 'left' ? 'Nothing happened while you were away.' : 'Nothing in this period.')); return; }
    const kids = [];
    const look = items.filter((x) => x.look);
    if (look.length) kids.push(h('div', { class: 'sec-label' }, 'Worth a look'), h('div', { class: 'cells act-cells' }, look.map(row)));
    const rest = items.filter((x) => !x.look);
    let group = null;
    for (const x of rest) {
      const label = dayLabel(x.at);
      if (!group || group.label !== label) { group = { label, rows: [] }; kids.push(h('div', { class: 'sec-label' }, label), (group.box = h('div', { class: 'cells act-cells' }))); }
      group.box.append(row(x));
    }
    body.replaceChildren(...kids);
  }

  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b || b.dataset.range === range) return;
    range = b.dataset.range;
    for (const x of seg.querySelectorAll('button')) { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }
    load();
  });
  ov.addEventListener('click', async (e) => {
    const r = e.target.closest('.act-row');
    if (!r || r.disabled) return;
    r.disabled = true;
    let m = null;
    try { m = (await api(`/api/cards/${r.dataset.card}`))?.message; } catch { m = null; }
    r.disabled = false;
    if (!m) { toast('That card is not in the chats any more.'); return; }
    close();
    openAt(m.chat_id, m.id);
  });
  load();
}
