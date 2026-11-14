// Conversation list (Vesper): the wordmark, one line saying who is working, "Needs you" rows (the app
// each card touches, a plain title, the age), the chats as a grouped list, and the floating search.
import { $, h, icon, fmtListTime, toMs, reducedMotion, isWide } from './util.js';
import { state, member, firstName, nameWithClients, typers, isMe } from './store.js';
import { chatAvatar, dmPartner, avatar, refreshMoods } from './avatar.js';
import { appMark, readCard, readTask, GLYPHS, clientStack, clientMark, clientOf, CLIENT_LIST, appFor, thumbMark, clientByKey, TEAM } from './marks.js';
import { api } from './api.js';
import { shortUrl } from './links.js';
import { runsSummary, onRuns, loadRuns, claudeWorking } from './runs.js';
import { docsSummary, onDocs, DOC_GLYPH } from './docs.js';
import { openActivity } from './activity.js';
import { onSystem, loadSystem, systemStatus, openSystem } from './system.js';
import { draftFor } from './composer.js';
import { previewText } from './md.js';
import { laterDue, laterUpcoming, finish, openLaterItem, whenLabel } from './later.js';
import { isWork, workPreview, workStep } from './work.js';
import { clientRows, onClients, loadClients } from './clients.js';

let els;
let query = '';
let onOpen = () => {};
let onOpenApprovals = () => {};
let onOpenRuns = () => {};
let onOpenAt = () => {};
let onOpenClient = () => {};

export function initList({ open, openApprovals, openRuns, openDocs, openAt, openClient }) {
  onOpenClient = openClient || (() => {});
  onOpen = open;
  onOpenAt = openAt || ((chatId) => open(chatId));
  onOpenApprovals = openApprovals || (() => {});
  onOpenRuns = openRuns || (() => {});
  els = {
    pane: $('#list-pane'),
    bar: $('#list-bar'),
    scroll: $('#list-scroll'),
    pins: $('#pins'),
    rows: $('#rows'),
    search: $('#search-input'),
    conn: $('#conn'),
    waiting: $('#waiting'),
    waitingWrap: $('#waiting-wrap'),
    later: $('#later'),
    laterWrap: $('#later-wrap'),
    clients: $('#clients'),
    clientsWrap: $('#clients-wrap'),
    live: $('#live'),
    liveWrap: $('#live-wrap'),
    runsWrap: $('#runs-row-wrap'),
    runsRow: $('#runs-row'),
    docsRow: $('#docs-row'),
    chips: $('#search-chips'),
    results: $('#search-results'),
    chatsLabel: $('.chats-label'),
    catchup: $('#catchup'),
    sys: $('#system-line'),
  };
  // System (11-09): one quiet line under the chats; it only changes color and words when something is wrong.
  els.sys?.addEventListener('click', () => openSystem());
  onSystem(() => renderSystemLine());
  loadSystem();
  setInterval(() => { if (document.visibilityState === 'visible') loadSystem(); }, 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadSystem(); });
  initCatchup();
  // Clients (11-11): one row per client with something going on; a row opens that client's page.
  els.clients.addEventListener('click', (e) => { const r = e.target.closest('[data-client]'); if (r) onOpenClient(r.dataset.client); });
  onClients(() => renderList());
  loadClients();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadClients(); });
  els.runsRow.addEventListener('click', () => onOpenRuns());
  els.docsRow.addEventListener('click', () => openDocs?.());
  onDocs(() => renderDocsRow());
  onRuns(() => renderList());
  loadRuns();
  els.live.addEventListener('click', () => { if (liveChat === '#runs') onOpenRuns(); else if (liveChat && liveMsg) onOpenAt(liveChat, liveMsg); else if (liveChat) onOpen(liveChat); });
  // Needs you rows open the Approvals view: every waiting card from every bot in one place.
  els.waiting.addEventListener('click', (e) => { if (e.target.closest('.need:not(.lt)') && waitingCards().length) onOpenApprovals(); });
  // Later rows (11-06): the circle finishes it (with Undo), the rest of the row opens it.
  const onLaterClick = (e) => {
    if (e.target.closest('.lt-more')) { laterAll = !laterAll; renderList(); return; }
    const row = e.target.closest('.need.lt');
    const it = row && (state.later || []).find((x) => x.id === Number(row.dataset.lt));
    if (!it) return;
    if (e.target.closest('.lt-check')) {
      if (row.classList.contains('done')) return;
      row.classList.add('done');
      navigator.vibrate?.(8);
      setTimeout(() => finish(it), reducedMotion() ? 0 : 420);
      return;
    }
    if (e.target.closest('.lt-open')) openLaterItem(it, { openAt: (chatId, msgId) => onOpenAt(chatId, msgId) });
  };
  els.waiting.addEventListener('click', onLaterClick);
  els.later.addEventListener('click', onLaterClick);
  els.scroll.addEventListener('scroll', () => {
    els.bar.classList.toggle('scrolled', els.scroll.scrollTop > 38);
  }, { passive: true });
  els.search.addEventListener('input', () => { query = els.search.value.trim().toLowerCase(); renderList(); });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { els.search.value = ''; query = ''; filter = { client: null, app: null }; renderList(); els.search.blur(); }
  });
  // The filter chips show while the field has focus; leaving it waits a beat so a tap on a chip lands.
  els.search.addEventListener('focus', () => { clearTimeout(blurTimer); searching = true; renderList(); });
  els.search.addEventListener('blur', () => { clearTimeout(blurTimer); blurTimer = setTimeout(() => { searching = false; renderList(); }, 220); });
  els.chips.addEventListener('click', (e) => {
    const c = e.target.closest('[data-fclient]');
    const a = e.target.closest('[data-fapp]');
    if (c) filter.client = filter.client === c.dataset.fclient ? null : c.dataset.fclient;
    else if (a) filter.app = filter.app === a.dataset.fapp ? null : a.dataset.fapp;
    else return;
    renderList();
  });
  els.results.addEventListener('click', (e) => {
    const r = e.target.closest('[data-open-chat]');
    if (!r) return;
    if (r.dataset.openMsg) onOpenAt(r.dataset.openChat, r.dataset.openMsg);
    else onOpen(r.dataset.openChat);
  });
  // Press feel like a table view: the highlight waits ~70 ms so a scroll never flashes a row,
  // shows at once on a tap, and the chat opens on pointerup without waiting for a click.
  let press = null;
  const clear = () => { if (press) { clearTimeout(press.timer); press.el.classList.remove('pressed'); press = null; } };
  const down = (e) => {
    const b = e.target.closest('[data-chat]');
    if (!b || e.button > 0) return;
    clear();
    press = { el: b, x: e.clientX, y: e.clientY, id: e.pointerId, timer: setTimeout(() => b.classList.add('pressed'), 70) };
  };
  const move = (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) clear();
  };
  const up = (e) => {
    if (!press || e.pointerId !== press.id) return;
    const el = press.el;
    clearTimeout(press.timer);
    press = null;
    el.classList.add('pressed');
    onOpen(el.dataset.chat);
    setTimeout(() => el.classList.remove('pressed'), 60);
  };
  for (const c of [els.pins, els.rows]) {
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move, { passive: true });
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', clear);
    // Keyboard and accessibility activation still open the chat.
    c.addEventListener('click', (e) => { if (e.detail === 0) { const b = e.target.closest('[data-chat]'); if (b) onOpen(b.dataset.chat); } });
  }
  els.scroll.addEventListener('scroll', clear, { passive: true });
  // Ages on the Needs you rows tick over once a minute without a re-render.
  setInterval(() => {
    for (const el of els.waiting.querySelectorAll('.need-age')) {
      const t = shortAge(Number(el.dataset.at));
      if (el.textContent !== t) el.textContent = t;
    }
  }, 60000);
}

function lastPreview(chat) {
  const m = chat.last;
  if (!m) return '';
  // A Claude job's card reads as the job and where it stands, never its raw data (11-11).
  if (isWork(m)) return workPreview(m);
  // A card still waiting previews as its plain title, never as "Approval needed: run `...`".
  const task = !(m.buttons?.length && !m.resolved) && !isMe(m.sender) ? readTask(m) : null;
  let text = m.buttons?.length && !m.resolved ? readCard(m).title : task ? [task.status?.label, task.title].filter(Boolean).join(': ') : previewText(m.text);
  if (!text && m.attachments?.length) {
    const img = m.attachments.every((a) => String(a.type).startsWith('image/'));
    text = img ? (m.attachments.length > 1 ? `${m.attachments.length} Photos` : 'Photo') : `Attachment: ${m.attachments[0].name}`;
  }
  if (m.resolved) text = text || 'Card';
  if (chat.kind === 'room' && m.sender) text = `${isMe(m.sender) ? 'You' : firstName(m.sender)}: ${text}`;
  return text;
}

function matches(chat) {
  if (filter.app && !query && !filter.client) return false;
  if (filter.client) {
    const c = CLIENT_LIST.find((x) => x.key === filter.client);
    const partner = dmPartner(chat);
    const theirs = partner && (member(partner).clients || []).some((n) => clientOf(n)?.key === c?.key);
    if (!theirs) return false;
  }
  if (!query) return true;
  return String(chat.title || '').toLowerCase().includes(query) || lastPreview(chat).toLowerCase().includes(query);
}

export function sortedChats() {
  const chats = [...state.chats.values()];
  const room = chats.filter((c) => c.kind === 'room');
  const dms = chats.filter((c) => c.kind !== 'room')
    .sort((a, b) => toMs(b.last?.at) - toMs(a.last?.at));
  return [...room, ...dms];
}

function typingDots(cls = '') {
  return h('span', { class: `tdots ${cls}` }, h('i'), h('i'), h('i'));
}

// Rows are patched in place, keyed by chat. A row is only rebuilt inside when what it
// shows changed, and the button element itself is never swapped, so a tap that is in progress
// while a typing or presence update lands still opens the chat on the first try.
const rowCache = new Map();

function reconcile(container, cache, items) {
  const keep = new Set();
  let prev = null;
  for (const it of items) {
    keep.add(it.key);
    let c = cache.get(it.key);
    if (!c) { c = { el: it.create(), sig: null }; cache.set(it.key, c); }
    if (c.sig !== it.sig) { it.update(c.el); c.sig = it.sig; }
    const want = prev ? prev.nextElementSibling : container.firstElementChild;
    if (want !== c.el) container.insertBefore(c.el, want);
    prev = c.el;
  }
  for (const [k, c] of cache) if (!keep.has(k)) { c.el.remove(); cache.delete(k); }
  for (const el of [...container.children]) if (!el.dataset.chat) el.remove();
}

// Approval cards still waiting (bot message with buttons, not resolved), newest first (The owner, 11-11: "sorted
// from new to old"), from every loaded thread (all threads are prefetched right after launch).
export function waitingCards() {
  const out = [];
  for (const [id, t] of state.threads) {
    if (!t.loaded || !state.chats.has(id)) continue;
    for (const m of t.messages) if (m.id != null && m.buttons?.length && !m.resolved && !isMe(m.sender)) out.push(m);
  }
  return out.sort((a, b) => toMs(b.at) - toMs(a.at) || Number(b.id) - Number(a.id));
}

const NEEDS_SHOWN = 3;
let waitingSig = null;
function renderWaiting() {
  const list = searchActive() ? [] : waitingCards();
  // Reminders that came due sit first: he asked for that moment himself.
  const due = searchActive() ? [] : laterDue();
  const shown = list.slice(0, NEEDS_SHOWN);
  const sig = JSON.stringify([list.length, shown.map((m) => [m.id, m.text, m.at]), due.map(laterKey)]);
  if (sig === waitingSig) return;
  waitingSig = sig;
  const el = els.waiting;
  // The section opens and closes by easing its slot (never a jump of the whole list).
  reveal(els.waitingWrap, el, list.length + due.length > 0);
  if (!list.length && !due.length) return;
  const n = list.length;
  const rows = [...due.map((it) => laterRow(it, true)), ...shown.map((m) => {
    const c = readCard(m);
    const at = toMs(m.at);
    const sub = [c.sub, firstName(m.sender)].filter(Boolean).join(' · ');
    return h('button', { class: 'need', type: 'button', 'aria-label': `${c.title}. ${sub}. Waiting ${shortAge(at)}. Review.` },
      appMark(c.app, 40),
      h('span', { class: 'need-tx' }, h('b', {}, c.title), h('span', {}, sub)),
      h('span', { class: 'need-age num', dataset: { at } }, shortAge(at)),
      icon('chevron'));
  })];
  if (n > NEEDS_SHOWN) rows.push(h('button', { class: 'need more', type: 'button' }, h('span', { class: 'need-tx' }, h('b', {}, `See all ${n}`)), icon('chevron')));
  el.replaceChildren(h('div', { class: 'sec-label' }, 'Needs you'), h('div', { class: 'cells' }, rows));
}

// ── Clients (11-11) ──────────────────────────────────────────────────────────
// The owner thinks in clients. Under Needs you (which stays the short list of single cards), one row per client
// with anything going on: its logo, its name, one line ("2 need you · Claude working on the cheat sheet") and a
// count when something needs him. Quiet clients do not show. The row opens the client's page (#/client/<key>).
let clientsSig = null;
function renderClients() {
  const rows = searchActive() ? [] : clientRows();
  const sig = JSON.stringify(rows);
  if (sig === clientsSig) return;
  clientsSig = sig;
  reveal(els.clientsWrap, els.clients, rows.length > 0);
  if (!rows.length) return;
  els.clients.replaceChildren(h('div', { class: 'sec-label' }, 'Clients'), h('div', { class: 'cells' }, rows.map((r) =>
    h('button', { class: 'need cl-row', type: 'button', dataset: { client: r.key }, 'aria-label': `${r.name}. ${r.line}. Open.` },
      clientMark(clientByKey(r.key), 40),
      h('span', { class: 'need-tx' }, h('b', {}, r.name), h('span', {}, r.line)),
      r.need ? h('span', { class: 'cl-count num', 'aria-hidden': 'true' }, String(r.need)) : null,
      icon('chevron')))));
}

// ── Later (11-06) ───────────────────────────────────────────────────────────
// His reminders and parked things (later.js). Coming up and undated ones live in their own section right under
// Needs you; due ones move up into Needs you. Each row: a circle to finish it, the words, when and who filed it.
const laterKey = (it) => [it.id, it.text, it.due_at, it.by, it.client];
function laterRow(it, due) {
  const who = it.by && member(it.by).kind === 'bot' ? firstName(it.by) : null;
  const sub = [due ? 'Reminder' : whenLabel(it.due_at), who ? `from ${who}` : null].filter(Boolean).join(' \u00b7 ');
  return h('div', { class: `need lt${due ? ' due' : ''}${it.due_at == null ? ' undated' : ''}`, dataset: { lt: it.id } },
    h('button', { class: 'lt-check', type: 'button', 'aria-label': `Mark done: ${it.text}` }, h('span', { class: 'lt-ring' }, icon('check'))),
    h('button', { class: 'lt-open', type: 'button', 'aria-label': `${it.text}. ${sub}.${due ? ` Due ${shortAge(it.due_at)} ago.` : ''} Open.` },
      h('span', { class: 'need-tx' }, h('b', {}, it.text), h('span', {}, sub)),
      due ? h('span', { class: 'need-age num', dataset: { at: it.due_at } }, shortAge(it.due_at)) : null,
      icon('chevron')));
}

const LATER_SHOWN = 4;
let laterAll = false;
let laterSig = null;
function renderLater() {
  const list = searchActive() ? [] : laterUpcoming();
  if (list.length <= LATER_SHOWN) laterAll = false;
  const shown = laterAll ? list : list.slice(0, LATER_SHOWN);
  // The time words change at midnight ("Tomorrow" becomes "Today"), so the day is part of the signature.
  const sig = JSON.stringify([list.length, laterAll, new Date().toDateString(), shown.map(laterKey)]);
  if (sig === laterSig) return;
  laterSig = sig;
  reveal(els.laterWrap, els.later, list.length > 0);
  if (!list.length) return;
  const rows = shown.map((it) => laterRow(it, false));
  if (list.length > LATER_SHOWN) {
    rows.push(h('button', { class: 'need more lt-more', type: 'button', 'aria-expanded': String(laterAll) },
      h('span', { class: 'need-tx' }, h('b', {}, laterAll ? 'Show fewer' : `See all ${list.length}`)), icon('chevron')));
  }
  els.later.replaceChildren(h('div', { class: 'sec-label' }, 'Later'), h('div', { class: 'cells' }, rows));
}

// ── Catch me up (Vesper 10-31) ──────────────────────────────────────────────
// The lead bot's few lines at the top of home: what finished, what went out on its own, what came from his
// recordings and what needs a look, since he last had the app open (GET /api/catchup). The "last open" mark is
// a per-device convenience in localStorage, set when the app goes to the background; 12 hours without one.
const SEEN_KEY = 'vesper.seenAt';
let catchupSince = null;
let catchupTimer = 0;
function seenAt() {
  try { const v = Number(localStorage.getItem(SEEN_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}
function initCatchup() {
  catchupSince = seenAt();
  els.catchup.addEventListener('click', () => openActivity({ since: catchupSince, openAt: (chatId, msgId) => onOpenAt(chatId, msgId) }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* private window: fall back to 12 hours */ }
    } else {
      catchupSince = seenAt();
      loadCatchup();
    }
  });
  loadCatchup();
}
async function loadCatchup() {
  clearTimeout(catchupTimer);
  catchupTimer = setTimeout(loadCatchup, 5 * 60 * 1000);
  let out;
  try { out = await api(`/api/catchup${catchupSince ? `?since=${catchupSince}` : ''}`); } catch { return; }
  renderCatchup(out);
}
let catchupSig = '';
// Two short lines at most (11-09: the sentences ran to six lines on a busy day): the counts, and the one thing
// worth a look when there is one. The whole record is a tap away in the Activity sheet.
function renderCatchup(out) {
  const lines = (out?.lines || []).filter(Boolean);
  const summary = out?.summary || (lines.length ? lines[0] : '');
  const note = out?.summary ? (out.note || '') : '';
  const sig = JSON.stringify([summary, note, out?.when]);
  if (sig === catchupSig) return;
  catchupSig = sig;
  els.catchup.hidden = !summary;
  if (!summary) return;
  const head = out?.when ? `Catch me up \u00b7 since ${out.when}` : 'Catch me up';
  els.catchup.setAttribute('aria-label', `${head}. ${summary}.${note ? ` ${note}.` : ''} Open the activity list.`);
  els.catchup.replaceChildren(
    avatar(TEAM.lead, 30, { dot: false }),
    h('span', { class: 'cu-tx' }, h('b', { class: 'cu-h' }, head), h('span', { class: 'cu-l' }, summary), note ? h('span', { class: `cu-n${out?.failed ? ' bad' : ''}` }, note) : null),
    icon('chevron'));
}

// Waiting age in the shortest form: 4m, 2h, 3d.
function shortAge(at) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Open a slot at once (what is below glides down via flip); close it by fading the card first,
// then collapsing the slot so what is below glides up.
function reveal(wrap, btn, on) {
  clearTimeout(wrap._leave);
  wrap.classList.remove('leaving');
  if (wrap.classList.contains('on') === on) return;
  wrap.setAttribute('aria-hidden', String(!on));
  btn.tabIndex = on ? 0 : -1;
  if (on || !document.body.classList.contains('ready') || reducedMotion()) { wrap.classList.toggle('on', on); return; }
  wrap.classList.add('leaving');
  wrap._leave = setTimeout(() => flip(() => { wrap.classList.remove('on', 'leaving'); }), 200);
}

// Who is working, as one quiet line under the wordmark (always there, so the list never moves for it).
// One agent: its name and status; several: their names; none: All quiet. Tapping opens the chat of
// the one shown first. Patched in place.
let liveChat = null;
let liveMsg = null; // the work card the live line opens on, when it names one Claude job
// Work cards still working, newest message per chat (the chat list's last message; the runs data may lag a minute).
function workingCards() {
  const out = [];
  for (const chat of state.chats.values()) {
    const m = chat.last;
    if (isWork(m) && m.work.state === 'working') out.push({ job: m.work.job, bot: m.sender, title: m.work.title, step: workStep(m.work), card: m.id, chat: chat.id });
  }
  return out;
}
function renderLive() {
  liveMsg = null;
  const work = [];
  if (!query) {
    for (const chat of sortedChats()) {
      for (const t of typers(chat.id)) if (!work.some((w) => w.t.id === t.id)) work.push({ chat, t });
    }
  }
  // No bot is typing, but a Claude session one of them started is still at it: say that instead of "All quiet".
  const cards = work.length || query ? [] : workingCards();
  const cj = work.length || query ? [] : [...cards, ...claudeWorking().filter((j) => !cards.some((c) => c.job === j.job))];
  if (cj.length) {
    const one = cj[0];
    const text = cj.length === 1 ? `Claude is working for ${one.bot ? firstName(one.bot) : one.who} \u00b7 ${one.step || one.title}` : `${cj.length} Claude sessions are working for the team`;
    liveChat = cj.length === 1 && one.bot && state.chats.has(`dm-${one.bot}`) ? `dm-${one.bot}` : '#runs';
    if (cj.length === 1 && one.card && liveChat !== '#runs') liveMsg = one.card;
    els.live.classList.add('on');
    if (els.live.textContent !== text) els.live.textContent = text;
    els.live.setAttribute('aria-label', `${text}. Open.`);
    return;
  }
  els.live.classList.toggle('on', work.length > 0);
  if (!work.length) {
    liveChat = null;
    if (els.live.textContent !== 'All quiet') els.live.textContent = 'All quiet';
    els.live.setAttribute('aria-label', 'All quiet. No agent is working right now.');
    return;
  }
  const pick = work.find((w) => w.t.status) || work[0];
  liveChat = pick.chat.id;
  const names = work.map((w) => firstName(w.t.id));
  const text = work.length === 1
    ? `${names[0]} is working${pick.t.status ? ` · ${pick.t.status}` : ''}`
    : `${names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`} are working`;
  if (els.live.textContent !== text) els.live.textContent = text;
  els.live.setAttribute('aria-label', `${text}. Open the chat.`);
}

// Pinned bots are gone in Vesper (the chats carry the same marks); the grid stays empty.
function renderPins() { els.pins.hidden = true; }

// The preview line: the last message, or who is working. Same bot and same kind of line: only the
// words change, so the dots keep running.
function patchPreview(box, chat, ty) {
  const t = ty[0];
  const room = chat.kind === 'room';
  // Words he left unsent in a chat he is not in right now show as "Draft:", like Messages.
  const draft = !t && state.openChat !== chat.id ? draftFor(chat.id) : '';
  const mode = !t ? (draft ? 'draft' : 'text') : `${t.id}|${t.status ? 's' : 'd'}`;
  const words = draft ? `Draft: ${draft.replace(/\s+/g, ' ').slice(0, 120)}` : !t ? lastPreview(chat) : t.status ? (room ? `${firstName(t.id)}: ${t.status}` : t.status) : (room ? `${firstName(t.id)} is typing` : '');
  if (box._mode === mode) {
    const target = mode === 'text' || mode === 'draft' ? box : box.querySelector('em');
    if (target && target.textContent !== words) target.textContent = words;
    return;
  }
  box._mode = mode;
  box.className = `rc-prev${t ? ' typing' : ''}${draft ? ' draft' : ''}`;
  if (!t) { box.textContent = words; return; }
  box.replaceChildren(...[words ? h('em', {}, words) : null, t.status ? null : typingDots('inline')].filter(Boolean));
}

function renderRows() {
  const items = [];
  for (const chat of sortedChats()) {
    if (!matches(chat)) continue;
    const ty = typers(chat.id);
    const selected = state.openChat === chat.id;
    const partner = dmPartner(chat);
    const time = fmtListTime(toMs(chat.last?.at));
    items.push({
      key: chat.id,
      sig: JSON.stringify([chat.unread, selected, chat.title, chat.last?.id, chat.last?.text, chat.last?.edited_at, time,
        ty.map((t) => `${t.id}:${t.status || ''}`), selected ? '' : draftFor(chat.id).slice(0, 120)]),
      create: () => h('button', { class: 'chat-row', type: 'button', dataset: { chat: chat.id } },
        h('span', { class: 'udot' }), h('div', { class: 'av-slot-row' }),
        h('div', { class: 'rc-main' },
          h('div', { class: 'rc-top' }, h('span', { class: 'rc-name' }), h('span', { class: 'rc-time' }, h('span', {}), icon('chevron'))),
          h('div', { class: 'rc-prev' }))),
      // Patched in place: only the parts that changed are touched, so a bot's status line updates
      // without restarting its typing dots, and the mark is built once (its ring is a class).
      update: (el) => {
        el.className = `chat-row${chat.unread ? ' unread' : ''}${selected ? ' selected' : ''}`;
        el.querySelector('.udot').setAttribute('aria-label', chat.unread ? `${chat.unread} unread` : '');
        if (!el._av) {
          el._av = chatAvatar(chat, 44);
          el._av.classList.add('av-slot-row');
          el.querySelector('.av-slot-row').replaceWith(el._av);
        }
        el._av.classList.toggle('working', chat.kind !== 'room' && ty.length > 0);
        // The bot's name, then its clients as their own small marks (Vesper 10-30, in place of "(Acme, Birch)").
        const nm = el.querySelector('.rc-name');
        const who = partner ? member(partner) : null;
        const nameKey = `${who ? who.name : chat.title || chat.id}|${who?.clients?.join(',') || ''}`;
        if (nm._k !== nameKey) {
          nm._k = nameKey;
          const stack = who?.kind === 'bot' ? clientStack(who.clients, 18) : null;
          nm.replaceChildren(...[h('span', { class: 'rc-nm' }, who ? who.name : (chat.title || chat.id)), stack].filter(Boolean));
          nm.setAttribute('aria-label', partner ? nameWithClients(partner) : (chat.title || chat.id));
        }
        el.querySelector('.rc-time > span').textContent = time;
        patchPreview(el.querySelector('.rc-prev'), chat, ty);
      },
    });
  }
  reconcile(els.rows, rowCache, items);
}

// Runs today: one row with how the day's routines went and what is next; opens the Runs screen.
let runsSig = null;
function renderRunsRow() {
  const s = searchActive() ? null : runsSummary();
  els.runsRow.hidden = !s;
  els.runsWrap.hidden = !s && els.docsRow.hidden;
  if (!s) { runsSig = null; return; }
  const sig = JSON.stringify(s);
  if (sig === runsSig) return;
  runsSig = sig;
  const mark = h('span', { class: 'appmark g-task', style: { '--s': '40px' }, 'aria-hidden': 'true' });
  mark.innerHTML = GLYPHS.clock;
  els.runsRow.setAttribute('aria-label', `Runs today: ${s.text}. Open Runs.`);
  // Only the failed count is red; the rest of the line stays quiet.
  const line = h('span', {}, ...s.parts.flatMap((part, i) => [i ? ' · ' : '', part === s.failedWord ? h('em', { class: 'bad' }, part) : part]));
  els.runsRow.replaceChildren(mark, h('span', { class: 'need-tx' }, h('b', {}, 'Runs today'), line), icon('chevron'));
}

// Deliverables: one row above Runs with what is new or coming up; opens the files the bots handed him.
let docsSig = null;
function renderDocsRow() {
  if (!els?.docsRow) return;
  const s = searchActive() ? null : docsSummary();
  els.docsRow.hidden = !s;
  els.runsWrap.hidden = !s && els.runsRow.hidden;
  if (!s) { docsSig = null; return; }
  const sig = JSON.stringify(s);
  if (sig === docsSig) return;
  docsSig = sig;
  const mark = h('span', { class: 'appmark g-doc', style: { '--s': '40px' }, 'aria-hidden': 'true' });
  mark.innerHTML = DOC_GLYPH;
  els.docsRow.setAttribute('aria-label', `Deliverables: ${s.text}. Open Deliverables.`);
  // Only the new count carries color; the rest of the line stays quiet.
  const line = h('span', {}, ...s.parts.flatMap((part, i) => [i ? ' \u00b7 ' : '', part === s.newWord ? h('em', { class: 'new' }, part) : part]));
  els.docsRow.replaceChildren(mark, h('span', { class: 'need-tx' }, h('b', {}, 'Deliverables'), line), icon('chevron'));
}

let sysSig = null;
function renderSystemLine() {
  if (!els?.sys) return;
  const s = systemStatus();
  const hide = !s || searchActive();
  const text = !s ? '' : s.level === 'ok' ? 'Everything is running' : s.headline;
  const sig = JSON.stringify([hide, s?.level, text]);
  if (sig === sysSig) return;
  sysSig = sig;
  els.sys.hidden = hide;
  if (hide) return;
  els.sys.className = `sys-line ${s.level}`;
  els.sys.setAttribute('aria-label', `System: ${text}. Open the system list.`);
  els.sys.replaceChildren(h('span', { class: `sys-dot ${s.level}`, 'aria-hidden': 'true' }), h('span', { class: 'sys-line-tx' }, text));
}

export function renderList() {
  if (!els || !state.me) return;
  flip(() => {
    renderLive();
    renderWaiting();
    renderClients();
    renderLater();
    renderDocsRow();
    renderRunsRow();
    renderPins();
    renderRows();
    renderSearch();
    renderSystemLine();
  });
  refreshMoods();
}

// Anything that moves because the list changed (a row moving to the top, the Waiting card opening
// or closing) glides from where it was instead of jumping: measure, change, then animate the
// difference with a compositor transform. Skipped while the list is off screen or still loading.
const FLIP_EASE = 'cubic-bezier(.32,.72,0,1)';
let flipping = false;
function flip(mutate) {
  const live = document.body.classList.contains('ready') && !flipping && !reducedMotion()
    && (isWide() || !document.body.classList.contains('thread-open'));
  if (!live) { mutate(); return; }
  const tracked = () => [els.waitingWrap, els.clientsWrap, els.laterWrap, els.pins, ...els.rows.children];
  const before = new Map(tracked().map((el) => [el, el.getBoundingClientRect().top]));
  flipping = true;
  try { mutate(); } finally { flipping = false; }
  const view = els.scroll.getBoundingClientRect();
  for (const el of tracked()) {
    const was = before.get(el);
    if (was == null) continue;
    const now = el.getBoundingClientRect().top;
    const dy = was - now;
    if (Math.abs(dy) < 1 || (now > view.bottom && was > view.bottom) || (now + el.offsetHeight < view.top && was + el.offsetHeight < view.top)) continue;
    el.getAnimations().forEach((an) => { if (an.id === 'flip') an.cancel(); });
    // A row rising to the top passes over the rows it overtakes, like a table view reorder.
    el.style.zIndex = dy > 0 ? '3' : '2';
    const an = el.animate([{ transform: `translate3d(0,${dy}px,0)` }, { transform: 'none' }], { duration: 480, easing: FLIP_EASE });
    an.id = 'flip';
    an.onfinish = an.oncancel = () => { if (!el.getAnimations().some((x) => x.id === 'flip' && x !== an)) el.style.zIndex = ''; };
  }
}

export function setConnected(on) {
  if (!els) return;
  els.conn.hidden = on;
}

// ── search everything ───────────────────────────────────────────────────────────────────────────
// The search field looks through every message, card, photo and bot memory (GET /api/search), with
// filter chips for a client (its logo) or an app. Results open the chat at that message.
const FILTER_APPS = [['sms', 'Texts'], ['gmail', 'Email'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['meta', 'Meta ads'], ['gads', 'Google Ads'], ['pay', 'Stripe'], ['web', 'Website'], ['photo', 'Photos']];
let filter = { client: null, app: null };
let searching = false;
let blurTimer = 0;
let found = null; // {key, messages, memory}
let fetchTimer = 0;
let fetchSeq = 0;
const searchKey = () => JSON.stringify([query, filter.client, filter.app]);
const serverKey = () => JSON.stringify([query, filter.client, !query && !filter.client]);
function searchActive() { return !!(query || filter.client || filter.app); }

function requestSearch() {
  const key = serverKey();
  if (found?.skey === key || requestSearch.pending === key) return;
  requestSearch.pending = key;
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(async () => {
    const seq = ++fetchSeq;
    const p = new URLSearchParams();
    if (query) p.set('q', query);
    if (filter.client) { const c = clientByKey(filter.client); if (c) p.set('any', [...new Set([c.short, c.name])].join('|')); }
    if (!query && !filter.client) p.set('recent', '1');
    let d;
    try { d = await api(`/api/search?${p}`); } catch { d = { messages: [], memory: [] }; }
    if (seq !== fetchSeq) return;
    requestSearch.pending = null;
    found = { skey: key, messages: d.messages || [], memory: d.memory || [] };
    renderList();
  }, query ? 180 : 0);
}

const imagesOf = (m) => (m.attachments || []).filter((a) => String(a.type || '').startsWith('image/'));
function readHit(m) {
  const waiting = m.buttons?.length && !m.resolved;
  const bot = member(m.sender)?.kind === 'bot';
  if (isWork(m)) return { kind: 'card', app: 'claude', title: m.work.title, status: workPreview(m).split(' \u00b7 ').pop(), client: m.work.client || '' };
  if (waiting) { const c = readCard(m); return { kind: 'card', app: c.app, app2: c.app2, title: c.title, status: 'Waiting on you', client: c.sub }; }
  const t = bot ? readTask(m) : null;
  if (t) return { kind: 'card', app: t.app, app2: t.app2, title: t.title, status: t.status?.label || '', client: t.sub };
  const app = appFor(m.text);
  return { kind: 'msg', app: app === 'task' ? null : app };
}

function passes(m, hit) {
  if (filter.client) {
    const c = CLIENT_LIST.find((x) => x.key === filter.client);
    if (c && !c.re.test(`${m.text || ''} ${hit.client || ''}`)) return false;
  }
  if (filter.app === 'photo') return imagesOf(m).length > 0;
  if (filter.app) return hit.app === filter.app || hit.app2 === filter.app;
  return true;
}

// The words around the first match, the match itself marked.
function snippet(text, q) {
  const t = String(text || '').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1').replace(/\*\*|__|`/g, '')
    .replace(/https?:\/\/[^\s)]+/g, (u) => shortUrl(u)).replace(/\s+/g, ' ').trim();
  if (!q) return [t.slice(0, 140)];
  const i = t.toLowerCase().indexOf(q);
  if (i < 0) return [t.slice(0, 140)];
  const from = Math.max(0, i - 48);
  return [`${from ? '…' : ''}${t.slice(from, i)}`, h('mark', {}, t.slice(i, i + q.length)), t.slice(i + q.length, i + q.length + 110)];
}

let chipsSig = null;
function renderChips() {
  const sig = JSON.stringify(filter);
  if (sig === chipsSig) return;
  chipsSig = sig;
  const chip = (on, data, mark, label) => h('button', { class: `sr-chip${on ? ' on' : ''}`, type: 'button', dataset: data, 'aria-pressed': String(on) }, mark, h('span', {}, label));
  els.chips.replaceChildren(h('div', { class: 'sr-chiprow' },
    ...CLIENT_LIST.map((c) => chip(filter.client === c.key, { fclient: c.key }, clientMark(c, 20), c.short)),
    h('span', { class: 'sr-sep', 'aria-hidden': 'true' }),
    ...FILTER_APPS.map(([a, label]) => chip(filter.app === a, { fapp: a }, appMark(a, 20), label))));
}

let searchSig = null;
function renderSearch() {
  const active = searchActive();
  const showChips = searching || active;
  els.chips.hidden = !showChips;
  if (showChips) renderChips();
  els.results.hidden = !active;
  const anyChat = !!els.rows.querySelector('.chat-row');
  els.chatsLabel.hidden = active && !anyChat;
  if (!active) { searchSig = null; els.results.replaceChildren(); return; }
  requestSearch();
  const sig = JSON.stringify([searchKey(), found?.skey, found?.messages.length, found?.memory.length, anyChat]);
  if (sig === searchSig) return;
  searchSig = sig;
  if (!found) { els.results.replaceChildren(h('div', { class: 'sr-wait' }, 'Searching…')); return; }
  const cards = [], msgs = [], photos = [];
  for (const m of found.messages) {
    if (!state.chats.has(m.chat_id)) continue;
    const hit = readHit(m);
    if (!passes(m, hit)) continue;
    for (const a of imagesOf(m)) photos.push({ m, a });
    if (filter.app === 'photo') continue;
    if (hit.kind === 'card') cards.push({ m, hit });
    else if (String(m.text || '').trim()) msgs.push({ m, hit });
  }
  const mem = filter.app ? [] : found.memory;
  const kids = [];
  const sec = (label, n, rows) => { kids.push(h('div', { class: 'sec-label' }, n > rows.length ? `${label} · ${n}` : label), h('div', { class: 'cells sr-cells' }, rows)); };
  if (cards.length) sec('Cards', cards.length, cards.slice(0, 10).map(({ m, hit }) => {
    const imgs = imagesOf(m);
    return h('button', { class: 'sr-row', type: 'button', dataset: { openChat: m.chat_id, openMsg: m.id } },
      imgs.length ? thumbMark(imgs[0].preview || imgs[0].url, 36, hit.app) : appMark(hit.app, 36, hit.app2),
      h('span', { class: 'sr-tx' }, h('b', {}, hit.title), h('span', {}, [firstName(m.sender), hit.status, shortDate(m.at)].filter(Boolean).join(' · '))));
  }));
  if (photos.length) kids.push(h('div', { class: 'sec-label' }, photos.length > 12 ? `Photos · ${photos.length}` : 'Photos'),
    h('div', { class: 'sr-photos' }, photos.slice(0, 12).map(({ m, a }) => h('button', { class: 'sr-ph', type: 'button', dataset: { openChat: m.chat_id, openMsg: m.id }, 'aria-label': `Photo from ${firstName(m.sender)}` },
      h('img', { src: a.preview || a.url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' })))));
  if (msgs.length) sec('Messages', msgs.length, msgs.slice(0, 14).map(({ m }) => h('button', { class: 'sr-row sr-msg', type: 'button', dataset: { openChat: m.chat_id, openMsg: m.id } },
    avatar(m.sender, 36),
    h('span', { class: 'sr-tx' }, h('span', { class: 'sr-top' }, h('b', {}, isMe(m.sender) ? 'You' : firstName(m.sender)), h('span', { class: 'sr-when num' }, shortDate(m.at))),
      h('span', { class: 'sr-snip' }, ...snippet(m.text, query))))));
  if (mem.length) sec('Memory', mem.length, mem.slice(0, 6).map((x) => h('button', { class: 'sr-row sr-msg', type: 'button', dataset: { openChat: `dm-${x.bot}` } },
    avatar(x.bot, 36),
    h('span', { class: 'sr-tx' }, h('span', { class: 'sr-top' }, h('b', {}, firstName(x.bot)), h('span', { class: 'sr-when' }, 'Memory')), h('span', { class: 'sr-snip' }, ...snippet(x.note, query))))));
  if (!kids.length && !anyChat) kids.push(h('div', { class: 'no-results' }, 'No Results'));
  els.results.replaceChildren(...kids);
}

function shortDate(at) {
  const ms = toMs(at);
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
