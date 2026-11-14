// Thread view: header, keyed message list with minimal DOM updates, receipts, typing bubbles,
// cards, images, paging, read marking and the optimistic send flow.
import { $, h, icon, icons, toMs, fmtSeparator, fmtTime, fmtAge, fmtBytes, uuid, toast, reducedMotion, emojiCount } from './util.js';
import { state, emit, thread, upsert, member, firstName, nameWithClients, colorsOf, isMe, typers, totalUnread } from './store.js';
import { api, post } from './api.js';
import { avatar, chatAvatar, dmPartner } from './avatar.js';
import { renderMarkdown, plain, previewText } from './md.js';
import { appMark, readCard, readTask, thumbMark, subLine, clientChips, chipCards, cardIdOf, clientMark, clientByKey } from './marks.js';
import { groupCards, needsFor, stopsFor, sweepable, primaryOf, sweep, nameOf, ownerOf, clientOfBoard } from './clients.js';
import { waitingCards } from './list.js';
import { urlsIn, linkCard, amountNear, withShortUrls, warmLinks } from './links.js';
import { fileTile, docCard, cardDocs } from './docs.js';
import { workCard, isWork, workWord, WORK_FINISHED } from './work.js';

const GAP = 60 * 60 * 1000; // centered timestamp after an hour of quiet
const PAGE = 50;

let els;
let current = null;
const nodes = new Map(); // key -> {el, sig, m}
const animate = new Map(); // key -> 'in' | 'out'
const pressing = new Map(); // message id -> {data, timer}
const expanded = new Set(); // approval cards opened past their preview (by message id)
const BUBBLE_PREVIEW = 420; // a bot message longer than this (or 8+ lines) folds behind "More" too (10-28: resolved
// cards and "Doing" notices showed whole work plans as one huge bubble)
let stick = true;
let renderQueued = false;
let queuedMode = 'auto';
let hooks = { goBack() {}, onChatChange() {}, openAt() {}, reply() {}, openClient() {} };
const earlierOpen = new Set(); // work cards whose Earlier rounds are open (by message id)
const acking = new Set(); // work cards whose Looks good is on its way
let focusId = null; // message to center on the next open (from the Waiting card)
let built = null; // chat whose rows are still in #msgs after it closed (reopening reuses them)
let fromBottom = 0; // distance from the bottom, kept when the scroller resizes (keyboard)
let headSig = '';
// Approvals view (#/approvals): the thread pane shows every waiting card from every bot instead of
// one chat. `current` stays null while it is open, so nothing reads or marks a chat.
let apprMode = false;
// Natural sizes of images seen before, so a rebuilt or freshly opened row reserves its space and
// never jumps when the picture decodes.
const imgSize = new Map();

export const keyOf = (m) => (m.client_id && isMe(m.sender) ? `c:${m.client_id}` : `m:${m.id}`);

export function initThread(opts) {
  hooks = { ...hooks, ...opts };
  els = {
    pane: $('#thread-pane'),
    head: $('#thread-head'),
    back: $('#back-btn'),
    backCount: $('#back-count'),
    headAv: $('#head-av'),
    headName: $('#head-name'),
    headStatus: $('#head-status'),
    scroller: $('#scroller'),
    msgs: $('#msgs'),
    empty: $('#thread-empty'),
    composer: $('#composer'),
    sync: $('#thread-sync'),
  };
  els.sync.addEventListener('click', (e) => { if (e.target.closest('[data-retry]') && current) freshen(current); });
  els.back.addEventListener('click', () => hooks.goBack());
  els.scroller.addEventListener('scroll', onScroll, { passive: true });

  // Keep the bottom pinned while content grows (images loading, typing bubbles, composer growth),
  // and keep the same distance from the bottom when the scroller itself shrinks or grows (the
  // keyboard opening through visualViewport), so the newest message never hides behind it.
  // A field on a card (a Needs-you card's sealed box) stays in view while the keyboard opens and the pane shrinks.
  const cardField = () => { const f = document.activeElement; return f && els.msgs.contains(f) && /^(INPUT|TEXTAREA)$/.test(f.tagName) ? f : null; };
  const ro = new ResizeObserver(() => {
    syncPads();
    const f = cardField();
    if (f) { f.scrollIntoView({ block: 'center' }); return; }
    if (apprMode) return; // a top-down list: keep wherever he scrolled
    const sc = els.scroller;
    if (stick) toBottom();
    else sc.scrollTop = sc.scrollHeight - sc.clientHeight - fromBottom;
  });
  ro.observe(els.msgs);
  ro.observe(els.head);
  ro.observe(els.composer);
  ro.observe(els.scroller);

  els.msgs.addEventListener('click', onMsgsClick);
  els.msgs.addEventListener('focusin', () => setTimeout(() => cardField()?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }), 350));
  document.addEventListener('visibilitychange', () => maybeMarkRead());
  initTint();
  initSlider();
}

function syncPads() {
  const root = els.pane.style;
  root.setProperty('--head-h', `${els.head.offsetHeight}px`);
  root.setProperty('--comp-h', `${els.composer.offsetHeight}px`);
}

function toBottom() { els.scroller.scrollTop = els.scroller.scrollHeight; }

function onScroll() {
  queueTint();
  const sc = els.scroller;
  // One batched read per scroll event; everything else happens in the rAF tint pass.
  const top = sc.scrollTop;
  fromBottom = sc.scrollHeight - top - sc.clientHeight;
  stick = fromBottom < 48;
  if (top < 400) loadOlder();
  if (stick) maybeMarkRead();
}

// ── open / close ───────────────────────────────────────────────────────────

export function showThread(chatId) {
  const chat = state.chats.get(chatId);
  if (!chat) return;
  leaveApprovals();
  els.pane.classList.remove('appr-view', 'client-view');
  if (current !== chatId) {
    current = chatId;
    setSync(null);
    animate.clear();
    // Reopening the chat that was just closed keeps its rows (no rebuild, no flash); a different
    // chat starts clean.
    if (built !== chatId) { nodes.clear(); els.msgs.replaceChildren(); }
    built = chatId;
    stick = true;
    renderHeader();
  }
  els.pane.classList.add('has-chat');
  const t = thread(chatId);
  syncPads();
  if (!t.loaded) {
    els.msgs.replaceChildren(h('div', { class: 'thread-loading' }, h('span', { class: 'spinner' })));
    nodes.clear();
    loadLatest(chatId);
  } else {
    render('bottom');
    applyFocus();
  }
}

// Open a chat centered on one message (the oldest waiting approval).
export function focusOn(id) { focusId = id; if (current && thread(current).loaded) applyFocus(); }

let focusTries = 0;
function applyFocus() {
  if (focusId == null || !current) return;
  const rec = nodes.get(`m:${focusId}`);
  if (!rec) {
    // An older message (a search result, a card chip): page back until it is here, a few pages at most.
    const t = thread(current);
    const newest = t.messages.reduce((n, m) => (m.id != null && Number(m.id) > n ? Number(m.id) : n), 0);
    if (t.loaded && t.more && Number(focusId) < newest && !t.messages.some((m) => String(m.id) === String(focusId)) && focusTries < 12) {
      focusTries++;
      loadOlder().then(() => applyFocus());
    }
    return;
  }
  focusTries = 0;
  focusId = null;
  const sc = els.scroller;
  // Center the card itself: a card with pictures above it is a row taller than the screen, and
  // centering that row would leave the slider under the composer.
  const r = (rec.el.querySelector('.appr') || rec.el).getBoundingClientRect();
  const box = sc.getBoundingClientRect();
  sc.scrollTop += r.top - box.top - (box.height - r.height) / 2;
  stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
  rec.el.classList.remove('flash');
  void rec.el.offsetWidth;
  rec.el.classList.add('flash');
}

export function hideThread() {
  // Keep the DOM so the pop animation shows the thread sliding away; just stop tracking it.
  current = null;
  leaveApprovals();
}

export function clearThreadPane() {
  current = null;
  built = null;
  leaveApprovals();
  apprItems.clear();
  nodes.clear();
  els.msgs.replaceChildren();
  els.pane.classList.remove('has-chat', 'appr-view', 'client-view');
}

export const currentChat = () => current;

// Load a thread's newest page in the background (no rendering unless it is the open one).
export function prefetch(chatId) {
  return thread(chatId).loaded ? Promise.resolve() : loadLatest(chatId);
}

// Image sizes come with each picture from the server (11-06), so rows reserve their space without downloading
// anything. (Until then the app downloaded every picture in every chat at launch just to learn its shape, at full
// size, through the Tailscale relay: the "always laggy" pictures.)
function warmImages(msgs) {
  for (const m of msgs) {
    for (const a of m.attachments || []) {
      if (!String(a.type || '').startsWith('image/') || imgSize.has(a.url)) continue;
      if (a.width && a.height) imgSize.set(a.url, { w: a.width, h: a.height });
    }
  }
}

function fitImage(sz) {
  const k = Math.min(1, 240 / sz.w, 320 / sz.h);
  return { w: Math.max(60, Math.round(sz.w * k)), h: Math.max(40, Math.round(sz.h * k)) };
}

async function loadLatest(chatId) {
  const t = thread(chatId);
  if (t.loading) return;
  t.loading = true;
  try {
    const r = await api(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=${PAGE}`);
    mergePage(t, r, true);
    t.loaded = true;
    warmImages(t.messages);
    warmLinks(t.messages.slice(-20).map((m) => m.text));
    if (current === chatId) {
      els.msgs.replaceChildren();
      nodes.clear();
      render('bottom');
      applyFocus();
      fillViewport();
    }
    hooks.onChatChange(); // the list's Waiting card counts approvals in loaded threads
  } catch (e) {
    if (current === chatId && e.status !== 401) {
      els.msgs.replaceChildren(h('div', { class: 'thread-loading' },
        h('button', { class: 'retry-load', type: 'button', onclick: () => loadLatest(chatId) }, 'Couldn’t load messages. Tap to retry.')));
    }
  } finally { t.loading = false; }
}

// After a reconnect: merge the newest page, or replace when the gap is bigger than one page.
export async function refetch(chatId, { timeout } = {}) {
  const t = thread(chatId);
  if (!t.loaded) return false;
  try {
    const r = await api(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=${PAGE}`, timeout ? { timeout } : undefined);
    const overlap = r.messages.some((m) => t.messages.some((x) => x.id === m.id));
    if (!overlap && t.messages.some((x) => x.id != null)) {
      const pendings = t.messages.filter((x) => x.id == null);
      t.messages = [];
      mergePage(t, r, true);
      for (const p of pendings) t.messages.push(p);
    } else {
      mergePage(t, r, false);
    }
    if (current === chatId) render('auto');
    return true;
  } catch { return false; /* the next reconnect tries again */ }
}

// 11-06 (The owner tapped a notification and the chat did not show it): coming back to the app, the open chat was
// only refreshed after the live connection came back, so for a few seconds it showed what it had before (the
// list, refreshed first, already knew better). Now the chat is fetched again at once over plain HTTP, retried
// quickly while the phone's network wakes up, and "Updating…" shows under the header if that takes a moment, so
// an old view never passes for the current one. focus: the message the notification was about, shown and lit.
let freshSeq = 0;
let freshFocus = null; // {chatId, id}: kept when a second refresh replaces the first (the tap, then the return)
export async function freshen(chatId, { focus = null } = {}) {
  if (!chatId || !state.chats.has(chatId)) return false;
  if (focus != null) freshFocus = { chatId, id: focus };
  const seq = ++freshSeq;
  const mine = () => seq === freshSeq;
  const note = setTimeout(() => { if (mine() && current === chatId) setSync('updating'); }, 600);
  try {
    for (const wait of [0, 1500, 4000, 8000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!mine()) return false;
      const t = thread(chatId);
      const ok = t.loaded ? await refetch(chatId, { timeout: 8000 }) : (await loadLatest(chatId), thread(chatId).loaded);
      if (ok) {
        if (mine() && current === chatId) setSync(null);
        if (freshFocus?.chatId === chatId && mine() && current === chatId) { focusOn(freshFocus.id); freshFocus = null; }
        return true;
      }
    }
    if (mine() && current === chatId) setSync('failed');
    return false;
  } finally { clearTimeout(note); }
}

function setSync(kind) {
  const el = els.sync;
  if (!el) return;
  el.hidden = !kind;
  el.classList.toggle('bad', kind === 'failed');
  if (!kind) { el.replaceChildren(); return; }
  el.replaceChildren(...(kind === 'updating'
    ? [h('span', { class: 'spinner sm', 'aria-hidden': 'true' }), h('span', {}, 'Updating\u2026')]
    : [h('span', {}, 'Couldn\u2019t reach the Mac'), h('button', { type: 'button', dataset: { retry: '' } }, 'Retry')]));
}

function mergePage(t, r, setMore) {
  for (const m of r.messages || []) upsertInto(t, m);
  if (setMore) t.more = !!r.more;
  if (r.reads) {
    for (const [mid, v] of Object.entries(r.reads)) {
      if (v && typeof v === 'object') { t.reads[mid] = v.last_id; if (v.at) t.readAt[mid] = toMs(v.at); }
      else t.reads[mid] = v;
    }
  }
}

function upsertInto(t, m) {
  const was = t.loaded;
  t.loaded = true; // let store.upsert insert while we fill
  upsert(m);
  t.loaded = was;
}

async function loadOlder() {
  if (!current) return;
  const chatId = current;
  const t = thread(chatId);
  if (!t.loaded || !t.more || t.loadingOlder) return;
  const first = t.messages.find((m) => m.id != null);
  if (!first) return;
  t.loadingOlder = true;
  render('keep');
  try {
    const r = await api(`/api/chats/${encodeURIComponent(chatId)}/messages?before=${encodeURIComponent(first.id)}&limit=${PAGE}`);
    const fresh = (r.messages || []).filter((m) => !t.messages.some((x) => x.id === m.id));
    t.messages = [...fresh, ...t.messages];
    t.more = !!r.more;
  } catch { /* stays at the top; scrolling again retries */ }
  t.loadingOlder = false;
  if (current === chatId) render('prepend');
}

// Keep loading older pages until the thread can scroll (short threads with more history).
function fillViewport() {
  const t = thread(current);
  if (t.more && els.scroller.scrollHeight <= els.scroller.clientHeight + 40) loadOlder();
}

// ── rendering ─────────────────────────────────────────────────────────────

export function scheduleRender(mode = 'auto') {
  const rank = { auto: 0, keep: 0, anchor: 0, bottom: 2 };
  if ((rank[mode] || 0) >= (rank[queuedMode] || 0)) queuedMode = mode;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const m = queuedMode;
    queuedMode = 'auto';
    if (current) render(m);
    else if (apprMode) renderApprovals();
  });
}

function buildItems(t, chat) {
  const items = [];
  const msgs = t.messages;
  const room = chat.kind === 'room';
  if (t.more) items.push({ key: 'older', type: 'older', sig: t.loadingOlder ? 'l' : 'i' });
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const at = toMs(m.at);
    const sep = !prev || at - toMs(prev.at) >= GAP;
    if (sep) {
      const s = fmtSeparator(at);
      items.push({ key: `s:${keyOf(m)}`, type: 'sep', sig: `${s.day}|${s.time}`, s });
    }
    const sys = m.kind === 'system';
    const start = sep || !prev || prev.sender !== m.sender || prev.kind === 'system' || sys;
    const end = !next || toMs(next.at) - at >= GAP || next.sender !== m.sender || next.kind === 'system' || sys;
    const pr = pressing.get(m.id);
    const dl = m.delivery ? `${m.delivery.state}${member(m.delivery.bot).online === false ? 'o' : ''}` : '';
    // A reply to Claude says where it went and how the job stands now (the card it answers, in this thread).
    const card = m.to_claude && m.reply_to ? msgs.find((x) => x.id === m.reply_to.id) : null;
    const claude = m.to_claude ? `c${card?.work?.state || ''}` : '';
    const wk = isWork(m) ? `w${earlierOpen.has(m.id) ? 'e' : ''}${acking.has(m.id) ? 'a' : ''}` : '';
    const base = `${+room}${m._status || ''}${pr ? pr.data : ''}${pressErr.has(m.id) ? 'e' : ''}${expanded.has(m.id) ? 'x' : ''}${dl}${claude}${wk}`;
    items.push({ key: keyOf(m), type: 'msg', m, f: { start, end, room, cardState: card?.work?.state || null }, base, sig: `${+start}${+end}${base}` });
  }
  // Receipt under the owner's latest message, while it is the newest message in the thread.
  const last = msgs[msgs.length - 1];
  if (last && isMe(last.sender) && last.id != null && !last._status && !last.delivery && !last.to_claude) {
    const label = receiptLabel(t, chat, last);
    items.push({ key: 'receipt', type: 'receipt', sig: label, label });
  }
  for (const ty of typers(chat.id)) items.push({ key: `t:${ty.id}`, type: 'typing', sig: `${ty.id}${+room}${ty.status || ''}${stopping.has(`${chat.id}:${ty.id}`) ? 'x' : ''}`, id: ty.id, room, status: ty.status, chat: chat.id });
  return items;
}

function receiptLabel(t, chat, m) {
  let readAt = 0;
  let read = false;
  for (const id of chat.members || []) {
    if (isMe(id)) continue;
    const r = t.reads[id];
    if (r != null && Number(r) >= Number(m.id)) { read = true; readAt = Math.max(readAt, t.readAt[id] || 0); }
  }
  if (!read) {
    // A bot that is not connected right now will get it when it is back; say so instead of a bare "Delivered".
    const p = chat.kind === 'room' ? null : dmPartner(chat);
    return p && member(p).kind === 'bot' && member(p).online === false ? `Delivered. ${firstName(p)} is offline.` : 'Delivered';
  }
  return readAt ? `Read ${fmtTime(readAt)}` : 'Read';
}

// Under one of his messages that a bot never picked up, or whose turn failed (11-09): what happened, and Send again.
function deliveryNote(m) {
  const d = m.delivery;
  const who = firstName(d.bot);
  const offline = member(d.bot).online === false;
  const text = d.claude ? (d.state === 'failed' ? 'This did not reach Claude.' : 'Claude has not picked this up.')
    : d.state === 'failed' ? (d.why === 'no_answer' ? `${who} did not answer this.` : `${who} hit a problem with this.`) : offline ? `${who} is offline and has not seen this.` : `${who} has not picked this up.`;
  return h('div', { class: 'dlv-note', role: 'status' }, h('span', {}, text),
    h('button', { class: 'dlv-again', type: 'button', dataset: { resend: m.id } }, 'Send again'));
}

const resending = new Set();
async function resend(id, btn) {
  if (resending.has(id)) return;
  resending.add(id);
  if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
  try {
    const r = await post(`/api/messages/${encodeURIComponent(id)}/redeliver`);
    if (r?.message) upsert(r.message);
  } catch (e) {
    toast(e?.status === 409 ? 'It is already on its way.' : 'Couldn\u2019t send it again. Try once more.');
  }
  resending.delete(id);
  scheduleRender('auto');
}

// Stop a bot that is working (11-09): its gateway's own /stop, sent without a bubble.
const stopping = new Map(); // `${chat}:${bot}` -> timer
async function stopBot(chatId, botId, btn) {
  const key = `${chatId}:${botId}`;
  if (stopping.has(key)) return;
  stopping.set(key, setTimeout(() => stopping.delete(key), 8000));
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping\u2026'; }
  try { await post(`/api/chats/${encodeURIComponent(chatId)}/command`, { command: 'stop', bot: botId }); }
  catch { clearTimeout(stopping.get(key)); stopping.delete(key); toast(`Couldn\u2019t reach ${firstName(botId)} to stop.`); scheduleRender('auto'); }
}

function render(mode = 'auto') {
  if (!current) return;
  const chat = state.chats.get(current);
  const t = thread(current);
  if (!chat || !t.loaded) return;
  const sc = els.scroller;
  const wasStuck = stick;
  const prevH = sc.scrollHeight;
  const prevTop = sc.scrollTop;
  // A card changing in place (a work card ticking a step) keeps what he is reading where it is (11-11).
  const anchor = mode === 'anchor' && !wasStuck ? firstVisible() : null;
  reconcile(buildItems(t, chat));
  if (mode === 'bottom' || (mode !== 'prepend' && mode !== 'keep' && wasStuck)) { toBottom(); stick = true; }
  else if (mode === 'prepend') sc.scrollTop = prevTop + (sc.scrollHeight - prevH);
  else if (anchor) {
    const el = nodes.get(anchor.key)?.el;
    if (el) sc.scrollTop += el.getBoundingClientRect().top - anchor.top;
    fromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
  }
  queueTint();
  maybeMarkRead();
}

// The first message row on screen and where its top is, so a re-render can put it back in the same place.
function firstVisible() {
  const top = els.scroller.getBoundingClientRect().top;
  for (const [key, rec] of nodes) {
    if (!rec.m) continue;
    const r = rec.el.getBoundingClientRect();
    if (r.bottom > top + 1) return { key, top: r.top };
  }
  return null;
}

function reconcile(items) {
  const box = els.msgs;
  const seen = new Set();
  const empty = !box.firstChild || !nodes.size;
  if (empty) {
    box.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const it of items) {
      seen.add(it.key);
      const el = makeItem(it);
      nodes.set(it.key, { el, sig: it.sig, m: it.m, base: it.base });
      frag.append(el);
    }
    box.append(frag);
    return;
  }
  let cursor = box.firstChild;
  for (const it of items) {
    seen.add(it.key);
    let rec = nodes.get(it.key);
    // Only the run position changed (a newer message from the same sender arrived): move the tail
    // and avatar in place instead of rebuilding the row (no image reload, no layout jump).
    if (rec && rec.m === it.m && it.type === 'msg' && rec.base === it.base && rec.sig !== it.sig) {
      patchRun(rec.el, it.m, it.f);
      rec.sig = it.sig;
    }
    if (rec && (rec.sig !== it.sig || rec.m !== it.m)) {
      const el = makeItem(it, rec.el);
      if (cursor === rec.el) cursor = el;
      rec.el.replaceWith(el);
      rec.el = el; rec.sig = it.sig; rec.m = it.m; rec.base = it.base;
    }
    if (!rec) {
      rec = { el: makeItem(it), sig: it.sig, m: it.m, base: it.base };
      nodes.set(it.key, rec);
    }
    if (rec.el === cursor) cursor = cursor.nextSibling;
    else box.insertBefore(rec.el, cursor);
  }
  for (const [k, rec] of nodes) {
    if (!seen.has(k)) { rec.el.remove(); nodes.delete(k); }
  }
}

function patchRun(row, m, f) {
  if (!row.classList.contains('row')) return;
  row.classList.toggle('start', f.start);
  row.classList.toggle('end', f.end);
  const grp = f.room && !isMe(m.sender);
  if (grp) {
    const label = row.querySelector(':scope > .sender');
    if (f.start && !label) row.prepend(nameLabel(m.sender));
    else if (!f.start && label) label.remove();
    const slot = row.querySelector('.av-slot');
    if (slot) slot.replaceChildren(...(f.end ? [avatar(m.sender, 30, { dot: false })] : []));
  }
  const stack = row.querySelector('.stack');
  if (!stack) return;
  for (const t of stack.querySelectorAll(':scope > .bubble > .tl')) { tintVisible.delete(t); tintIO?.unobserve(t); t.remove(); }
  for (const b of stack.querySelectorAll(':scope > .bubble.tail')) b.classList.remove('tail');
  let lastEl = stack.lastElementChild;
  if (lastEl?.classList.contains('tb')) lastEl = lastEl.previousElementSibling;
  if (f.end && lastEl && lastEl.classList.contains('bubble') && !lastEl.classList.contains('jumbo')) {
    lastEl.classList.add('tail');
    const tl = h('span', { class: 'tl', 'aria-hidden': 'true' });
    lastEl.append(tl);
    if (lastEl.classList.contains('out')) { tintIO?.observe(tl); queueTint(); }
  }
}

function makeItem(it, old) {
  switch (it.type) {
    case 'older': return h('div', { class: 'older' }, it.sig === 'l' ? h('span', { class: 'spinner' }) : null);
    case 'sep': return h('div', { class: 'sep' }, `${it.s.day} ${it.s.time}`);
    case 'receipt': return h('div', { class: 'receipt' }, it.label);
    case 'typing': return typingRow(it.id, it.room, it.status, it.chat);
    default: {
      const el = messageRow(it.m, it.f);
      watchTint(el);
      const anim = animate.get(it.key);
      if (anim && !old && !reducedMotion()) {
        el.classList.add(anim === 'out' ? 'enter-out' : 'enter-in');
        el.addEventListener('animationend', () => el.classList.remove('enter-out', 'enter-in'), { once: true });
      }
      animate.delete(it.key);
      return el;
    }
  }
}

function nameLabel(id) {
  return h('div', { class: 'sender' }, nameWithClients(id));
}

function typingRow(id, room, status, chatId) {
  const [c1, c2] = colorsOf(id);
  const label = status ? `${firstName(id)} · ${status}` : (room ? firstName(id) : '');
  // Stop sits beside the working line once the bot says what it is doing (a turn worth stopping), never on plain dots.
  const busy = stopping.has(`${chatId}:${id}`);
  const stop = status && chatId ? h('button', { class: 'work-stop', type: 'button', disabled: busy, dataset: { stopBot: id, stopChat: chatId }, 'aria-label': `Stop ${firstName(id)}` }, busy ? 'Stopping\u2026' : 'Stop') : null;
  return h('div', { class: `row in end typing-row${room ? ' grp' : ''}`, dataset: { member: id } },
    h('div', { class: 'line' },
      room ? h('div', { class: 'av-slot' }, avatar(id, 30, { dot: false })) : null,
      h('div', { class: 'stack' },
        h('div', { class: 'bubble in typing', 'aria-label': `${firstName(id)} is typing` },
          h('i'), h('i'), h('i')))),
    label ? h('div', { class: 'work' }, h('span', { class: 'work-orb', style: { '--c1': c1, '--c2': c2 } }), h('span', { class: 'work-tx' }, label), stop) : null);
}

function pastTense(label) {
  const s = String(label || '').trim();
  const map = [[/^approve\b/i, 'Approved'], [/^deny\b/i, 'Denied'], [/^allow\b/i, 'Allowed'], [/^reject\b/i, 'Rejected'],
    [/^confirm\b/i, 'Confirmed'], [/^cancel\b/i, 'Canceled'], [/^send\b/i, 'Sent'], [/^skip\b/i, 'Skipped'], [/^accept\b/i, 'Accepted'],
    [/^decline\b/i, 'Declined'], [/^stop\b/i, 'Stopped']];
  for (const [re, word] of map) if (re.test(s)) return s.replace(re, word);
  return s;
}

function resolvedLine(r) {
  const negative = r.style === 'danger' || /^(deny|denied|reject|cancel|no\b)/i.test(r.label || '');
  const label = pastTense(r.label) || 'Done';
  const by = r.by ? (typeof r.by === 'object' ? r.by.name : member(r.by).name) : '';
  const text = by && !/\bby\b/i.test(label) ? `${label} by ${by}` : label;
  return h('div', { class: `card-resolved${negative ? ' neg' : ''}` }, icon(negative ? 'xmark' : 'check'), h('span', {}, text));
}

function messageRow(m, f) {
  if (m.kind === 'system') return h('div', { class: 'sys', dataset: { key: keyOf(m) } }, m.text);
  const mine = isMe(m.sender);
  const grp = f.room && !mine;
  const failed = m._status === 'failed';
  const row = h('div', {
    class: `row ${mine ? 'out' : 'in'}${f.start ? ' start' : ''}${f.end ? ' end' : ''}${grp ? ' grp' : ''}${m._status ? ` ${m._status}` : ''}${m.reactions?.length ? ' reacted' : ''}`,
    dataset: { key: keyOf(m) },
  });
  if (grp && f.start) row.append(nameLabel(m.sender));
  if (m.reply_to) {
    const r = m.reply_to;
    row.append(h('button', { class: 'quote', type: 'button', dataset: { jump: r.id } },
      h('span', { class: 'q-name' }, r.work ? 'Claude' : isMe(r.sender) ? 'You' : firstName(r.sender)),
      h('span', { class: 'q-text' }, (r.work ? String(r.text || '').split('\n')[0].replace(/^Claude:\s*/, '') : previewText(r.text || '').slice(0, 160)) || 'Attachment')));
  }
  const line = h('div', { class: 'line' });
  if (grp) line.append(h('div', { class: 'av-slot' }, f.end ? avatar(m.sender, 30, { dot: false }) : null));
  const stack = h('div', { class: 'stack' });

  // A Claude job the team started (11-11): one card that changes in place, its files inside it.
  if (isWork(m)) {
    row.classList.add('has-appr');
    stack.append(workCard(m, { open: earlierOpen.has(m.id), acking: acking.has(m.id) }));
    line.append(stack);
    row.append(line);
    return row;
  }
  // Something a bot handed over (a meeting prep, a proposal): one card with its name and every file in it.
  if (m.doc && (m.attachments || []).length) { row.classList.add('has-appr'); stack.append(docCard(m)); }
  for (const a of m.doc ? [] : m.attachments || []) {
    if (String(a.type || '').startsWith('image/')) {
      const known = (a.width && a.height) ? { w: a.width, h: a.height } : imgSize.get(a.url);
      const fit = known ? fitImage(known) : null;
      const img = h('img', {
        class: `att-img${fit ? ' sized' : ''}${known?.loaded ? ' ready' : ''}`, src: a.preview || a.url, alt: a.name || 'Photo', decoding: 'async', draggable: 'false',
        width: fit?.w, height: fit?.h, style: fit ? { width: `${fit.w}px`, height: `${fit.h}px` } : null,
        onload: (e) => {
          const el = e.target;
          el.classList.add('ready');
          if (!imgSize.get(a.url)?.loaded) imgSize.set(a.url, { w: el.naturalWidth, h: el.naturalHeight, loaded: true });
        },
      });
      stack.append(h('button', { class: 'att', type: 'button', dataset: { view: a.url, preview: a.preview || a.url }, 'aria-label': `Photo ${a.name || ''}` }, img));
    } else {
      // Any other file opens inside the app (11-10); a link would leave a Home Screen app with no way back.
      stack.append(fileTile(a, { mine, item: { id: m.id, chat_id: m.chat_id, by: m.sender, files: [a] } }));
    }
  }

  const hasText = !!String(m.text || '').trim();
  const waiting = !!(m.buttons && m.buttons.length) && !m.resolved;
  const isCard = !!m.resolved;
  const task = !waiting && !mine && member(m.sender)?.kind === 'bot' ? readTask(m) : null;
  if (waiting) {
    row.classList.add('has-appr');
    stack.append(approvalCard(m));
  } else if (task) {
    row.classList.add('has-appr');
    stack.append(taskCard(m, task));
  } else if (hasText || isCard || !(m.attachments || []).length) {
    // One to three emoji and nothing else: large, no bubble, no tail (like iMessage).
    const jumbo = hasText && !isCard && !m.reply_to && emojiCount(m.text);
    const bubble = h('div', { class: `bubble ${mine ? 'out' : 'in'}${isCard ? ' card' : ''}${jumbo ? ` jumbo j${jumbo}` : ''}` });
    if (jumbo) { bubble.append(h('div', { class: 'btext emj' }, String(m.text).replace(/\s+/g, ''))); stack.append(bubble); }
    else {
    const fold = hasText && !mine && (String(m.text).length > BUBBLE_PREVIEW || String(m.text).split('\n').length > 8);
    const shut = fold && !expanded.has(m.id);
    if (hasText) bubble.append(h('div', { class: `btext${shut ? ' clamped' : ''}`, html: mine ? plain(m.text) : chipCards(renderMarkdown(m.text), cardInfo) }));
    if (fold) bubble.append(h('button', { class: 'bubble-more', type: 'button', dataset: { more: m.id }, 'aria-expanded': String(!shut) }, shut ? 'More' : 'Less'));
    if (isCard) bubble.append(resolvedLine(m.resolved));
    stack.append(bubble);
    // Links get a preview card under the bubble, like Messages.
    if (hasText && !isCard) for (const u of urlsIn(m.text)) stack.append(linkCard(u, { amount: amountNear(m.text, u) }));
    }
  }
  // Tail only on the last visual element of a run, and only when that element is a bubble.
  const lastEl = stack.lastElementChild;
  if (f.end && lastEl && lastEl.classList.contains('bubble') && !lastEl.classList.contains('jumbo')) { lastEl.classList.add('tail'); lastEl.append(h('span', { class: 'tl', 'aria-hidden': 'true' })); }
  if (m.reactions?.length) stack.append(reactionBadge(m.reactions, mine));
  line.append(stack);
  line.append(h('span', { class: 'rtime', 'aria-hidden': 'true' }, fmtTime(toMs(m.at))));
  if (failed) line.append(h('button', { class: 'fail-ic', type: 'button', dataset: { retry: m.client_id }, 'aria-label': 'Not delivered. Tap to try again.', html: icons.alert }));
  row.append(line);
  if (m.edited_at && !isCard && m.kind === 'text' && !mine) row.append(h('div', { class: 'edited' }, 'Edited'));
  if (failed) row.append(h('button', { class: 'fail-note', type: 'button', dataset: { retry: m.client_id } }, 'Not Delivered'));
  if (mine && m.delivery && m.id != null && !m._status) row.append(deliveryNote(m));
  else if (mine && m.to_claude && !failed) row.append(h('div', { class: 'wc-sent', role: 'status' }, m._status === 'sending' ? 'Sending to Claude\u2026'
    : `Sent to the same session${f.cardState === 'working' || f.cardState === 'queued' ? ` \u00b7 ${workWord(f.cardState)}` : ''}`));
  return row;
}

// What a task actually says, under its title: a text as the green bubble it is, an email as its subject and
// opening lines, anything else as the bot's plain summary.
function taskBody(c) {
  if (!c) return null;
  if (c.type === 'sms') {
    const links = urlsIn(c.body, 1);
    return h('div', { class: 'tk-sms' }, h('div', { class: 'tk-bub' }, links.length ? withShortUrls(c.body) : c.body),
      ...links.map((u) => linkCard(u, { amount: amountNear(c.body, u) })));
  }
  if (c.type === 'email') return h('div', { class: 'tk-mail' }, c.subject ? h('div', { class: 'tk-subj' }, c.subject) : null, h('div', { class: 'tk-mbody' }, c.body));
  return h('div', { class: 'tk-note' }, c.body);
}

// A task that is not waiting on the owner (Doing, Auto reply, a finished or withdrawn card, a skill): same
// face as the approval card, then where it stands. The full text stays behind Details.
function taskCard(m, t) {
  const open = expanded.has(m.id);
  const s = t.status;
  const at = toMs(m.resolved?.at || m.edited_at || m.at);
  const raw = String(m.text || '').trim();
  return h('div', { class: `tk${s ? ` tone-${s.tone}` : ''}`, dataset: { id: m.id } },
    h('div', { class: 'ap-head' },
      cardMark(m, t.app, t.app2),
      h('div', { class: 'ap-tx' }, h('div', { class: 'ap-title' }, t.title), subLine(t.sub))),
    open ? null : updatedLine(t.plain?.updated),
    open ? null : plainWhy(t.plain, t.content),
    open ? null : saidLine(t.plain?.said),
    open ? null : answersLine(t.plain?.answers),
    open ? h('div', { class: 'appr-q', html: renderMarkdown(raw) }) : taskBody(t.content),
    t.heard && !open ? heardLine(t.heard) : null,
    t.receipt && !open ? receiptBox(m, t.receipt) : null,
    s || t.more ? h('div', { class: 'tk-foot' },
      s ? h('div', { class: 'tk-st' }, h('i', { class: 'tk-dot', 'aria-hidden': 'true' }), h('span', {}, s.label), at && s.tone !== 'busy' && s.tone !== 'wait' && !/\d:\d\d\s?[AP]M/.test(s.note) ? h('span', { class: 'tk-at' }, fmtTime(at)) : null) : h('span'),
      t.more ? h('button', { class: 'appr-more', type: 'button', dataset: { more: m.id }, 'aria-expanded': String(open) }, open ? 'Hide details' : 'Details') : null) : null,
    s?.note && !open && !t.receipt ? h('div', { class: 'tk-why' }, s.note) : null);
}

// The receipt on a finished plan: the proof, what changed, how long it took, and Undo when it can be put back
// (two taps: the first arms it for 4 seconds).
function receiptBox(m, r) {
  const asked = m.resolved?.undo || r.asked;
  return h('div', { class: 'rcpt' },
    r.proof ? h('div', { class: 'rcpt-proof' }, r.proof) : null,
    r.change ? h('div', { class: 'rcpt-row' }, h('span', { class: 'rcpt-k' }, 'Changed'), h('span', { class: 'rcpt-v' }, r.change)) : null,
    h('div', { class: 'rcpt-foot' },
      h('span', { class: 'rcpt-took' }, [r.who && `By ${r.who}`, r.took && `took ${r.took}`].filter(Boolean).join(' · ')),
      r.undo && !asked ? h('button', { class: 'card-quiet rcpt-undo', type: 'button', dataset: { undo: m.id }, 'aria-label': `Undo: ${r.undo}` }, 'Undo') : null,
      asked ? h('span', { class: 'rcpt-asked' }, r.asked || 'Undo asked') : null));
}

const undoArmed = new Map();
async function undoPress(b) {
  const id = Number(b.dataset.undo);
  if (!undoArmed.has(id)) {
    b.textContent = 'Tap again to undo';
    b.classList.add('armed');
    undoArmed.set(id, setTimeout(() => { undoArmed.delete(id); if (b.isConnected) { b.textContent = 'Undo'; b.classList.remove('armed'); } }, 4000));
    return;
  }
  clearTimeout(undoArmed.get(id));
  undoArmed.delete(id);
  b.disabled = true;
  b.textContent = 'Undoing…';
  try {
    const out = await post(`/api/messages/${id}/undo`, {});
    if (out.message) upsert(out.message);
    toast('Undo asked. The bot will put it back and post a receipt.');
  } catch (e) {
    b.disabled = false;
    b.textContent = 'Undo';
    b.classList.remove('armed');
    toast(e.message || 'Undo did not go through.');
  }
}

// A card's icon: its first picture when it has one (the app on the corner), otherwise the app's mark.
function cardMark(m, app, app2) {
  const img = (m.attachments || []).find((a) => String(a.type || '').startsWith('image/'));
  return img ? thumbMark(img.url, 40, app) : appMark(app, 40, app2);
}

// A card from one of the owner's recordings: what he said, then when and on which recording.
// The plain card (11-11, marks.js plainOf): Why sits above a text or email (a plan's Why is its note), the
// message a reply answers rides in a quote strip, then quiet rows for what the slide does and the money, and a
// byline when a Claude session wrote the card.
function plainWhy(pl, content) {
  return pl?.why && content?.type !== 'note' ? h('div', { class: 'tk-note pc-why' }, pl.why) : null;
}
function answersLine(a) {
  if (!a?.quote) return null;
  return h('div', { class: 'heard pc-ans' }, icon('reply', 'heard-ic'),
    h('div', { class: 'heard-tx' }, h('div', { class: 'heard-q' }, `\u201c${a.quote}\u201d`),
      h('div', { class: 'heard-w' }, [a.who, a.when].filter(Boolean).join(' · '))));
}
// One decision per outcome (11-11): his own words that were taken as the yes, the one line a card changed in place
// carries, why a said-so card still needs his slide, and the HQ contact a send adds first.
function saidLine(x) {
  if (!x?.quote) return null;
  return h('div', { class: 'heard pc-said' }, icon('check', 'heard-ic'),
    h('div', { class: 'heard-tx' }, h('div', { class: 'heard-q' }, `\u201c${x.quote}\u201d`),
      h('div', { class: 'heard-w' }, ['You said', x.when].filter(Boolean).join(' \u00b7 '))));
}
function updatedLine(x) {
  if (!x?.note) return null;
  return h('div', { class: 'pc-upd' }, h('span', { class: 'pc-upd-k' }, x.when ? `Updated ${x.when}` : 'Updated'), h('span', { class: 'pc-upd-v' }, x.note));
}
const heldLine = (why) => (why ? h('div', { class: 'pc-held' }, `Still needs your slide: ${why}.`) : null);
function plainRows(pl) {
  const rows = [['When you slide', pl?.slide], ['Cost', pl?.cost], ['Calendar', pl?.calendar], ['Also adds to HQ', pl?.contact]].filter(([, v]) => v);
  if (!rows.length) return null;
  return h('div', { class: 'pc' }, rows.map(([k, v]) => h('div', { class: 'pc-row' }, h('span', { class: 'pc-k' }, k), h('span', { class: 'pc-v' }, v))));
}
const byline = (pl) => (pl?.claude ? h('div', { class: 'pc-by' }, h('span', { class: 'pc-dot', 'aria-hidden': 'true' }), 'Prepared by Claude') : null);

function heardLine(x) {
  const where = ['From your recording', x.when, x.where].filter(Boolean).join(' · ');
  return h('div', { class: 'heard' }, icon('wave', 'heard-ic'),
    h('div', { class: 'heard-tx' }, x.quote ? h('div', { class: 'heard-q' }, `\u201c${x.quote}\u201d`) : null, h('div', { class: 'heard-w' }, where)));
}

// Approval card (Vesper): the app it touches, a plain title and one sub line (marks.js readCard), a pill
// slider whose label says the verb, the real secondary buttons as text, and Details for the full text.
// Typed sealed values live only here, in memory, until the slide sends them (never stored or logged).
const sealedDraft = new Map();
function approvalCard(m) {
  const links = m.buttons.flat().filter((b) => b.url);
  const all = m.buttons.flat().filter((b) => !b.url);
  const primary = all.find((b) => b.style === 'primary') || all[0];
  const rest = all.filter((b) => b !== primary);
  const deny = rest.filter((b) => b.style === 'danger');
  const extra = rest.filter((b) => b.style !== 'danger');
  const pr = pressing.get(m.id);
  const quiet = (b) => h('button', {
    class: `card-quiet${b.style === 'danger' ? ' danger' : ''}${extra.includes(b) ? ' extra' : ''}${pr && pr.data === b.data ? ' pending' : ''}`,
    type: 'button', disabled: !!pr, dataset: { press: b.data, id: m.id },
  }, pr && pr.data === b.data ? `${b.label}…` : b.label);
  const c = readCard(m);
  const q = String(m.text || '').replace(/^\s*approval needed:\s*/i, '');
  const text = q ? q[0].toUpperCase() + q.slice(1) : '';
  const pendingPrimary = pr && pr.data === primary.data;
  // A generic label ("Approve", "Approve once") reads as the verb of the action; a specific one stays.
  const generic = /^(approve( once)?|yes|ok|allow( once)?)$/i.test(String(primary.label || '').trim());
  const verb = generic ? c.verb : String(primary.label || 'approve').toLowerCase();
  const open = expanded.has(m.id);
  return h('div', { class: `appr${pendingPrimary ? ' pending' : ''}`, dataset: { id: m.id, primary: primary.data } },
    h('div', { class: 'ap-head' },
      cardMark(m, c.app, c.app2),
      h('div', { class: 'ap-tx' }, h('div', { class: 'ap-title' }, c.title), subLine(c.sub))),
    open ? null : updatedLine(c.plain?.updated),
    open ? null : plainWhy(c.plain, c.content),
    open ? null : saidLine(c.plain?.said),
    open ? null : heldLine(c.plain?.held),
    open ? null : answersLine(c.plain?.answers),
    open && text ? h('div', { class: 'appr-q', html: renderMarkdown(text) }) : taskBody(c.content),
    c.heard && !open ? heardLine(c.heard) : null,
    open || !c.sends ? null : h('div', { class: 'pc-held pc-sends' }, c.sends),
    open ? null : plainRows(c.plain),
    open ? null : byline(c.plain),
    links.length ? h('div', { class: 'appr-links' }, links.map((b) => h('a', { class: 'appr-link', href: b.url, target: '_blank', rel: 'noopener noreferrer' }, b.label, icon('chevron')))) : null,
    c.sealed ? h('label', { class: 'appr-sealed' }, h('span', { class: 'appr-sealed-l' }, c.sealed, h('small', {}, 'Sealed: goes to the bot, never into the chat')),
      h('input', { class: 'sealed-in', type: 'password', autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done',
        value: sealedDraft.get(m.id) || '', 'aria-label': c.sealed, dataset: { sealedFor: m.id } })) : null,
    pressErr.has(m.id) && !pr ? h('div', { class: 'appr-err', role: 'alert' }, pressErr.get(m.id)) : null,
    h('div', { class: 'appr-track' },
      h('span', { class: 'appr-hint', 'aria-hidden': 'true' }, pendingPrimary ? `${primary.label}…` : `slide to ${verb}`),
      h('span', { class: 'appr-end', 'aria-hidden': 'true' }),
      h('button', {
        class: 'appr-knob', type: 'button', disabled: !!pr, role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pendingPrimary ? '100' : '0',
        'aria-label': `Slide to ${verb}: ${c.title}`,
      }, icon('chevron'))),
    h('div', { class: 'appr-foot' },
      h('div', { class: 'appr-left' },
        text ? h('button', { class: 'appr-more', type: 'button', dataset: { more: m.id }, 'aria-expanded': String(open) }, open ? 'Hide details' : 'Details') : null,
        c.draft != null && !pr ? h('button', { class: 'appr-more appr-edit', type: 'button', dataset: { editCard: m.id } }, 'Edit') : null,
        !pr ? h('button', { class: 'appr-ask', type: 'button', dataset: { askCard: m.id } }, 'Ask') : null,
        changeable(m) && !pr ? h('button', { class: 'appr-change', type: 'button', dataset: { changeCard: m.id } }, 'Change it') : null),
      deny.length ? h('div', { class: 'appr-btns' }, deny.map(quiet)) : null),
    // A third choice ("Always: Cedar posts") gets its own line so the footer never wraps.
    extra.length ? h('div', { class: 'appr-extra' }, extra.map(quiet)) : null);
}

function reactionBadge(reactions, mine) {
  const uniq = [];
  for (const r of reactions) if (r.emoji && !uniq.includes(r.emoji)) uniq.push(r.emoji);
  const mineEmoji = reactions.find((r) => isMe(r.member_id))?.emoji;
  const names = reactions.map((r) => `${isMe(r.member_id) ? 'You' : firstName(r.member_id)} ${r.emoji}`).join(', ');
  // Front badge (nearest the bubble) is mine when I reacted; it carries the two dots.
  const order = mineEmoji ? [mineEmoji, ...uniq.filter((e) => e !== mineEmoji)] : uniq;
  const front = order[0];
  return h('div', { class: `tb${mine ? ' on-out' : ' on-in'}`, title: names, 'aria-label': names, style: { '--tbc': front === mineEmoji ? 'var(--blue)' : 'var(--tb-bg)' } },
    // The real emoji character in each badge, drawn by the system emoji font.
    order.slice(0, 3).map((e) => h('span', { class: `tbi${e === mineEmoji ? ' mine' : ''}` }, h('span', { class: 'emj' }, e))));
}

// ── screen-tied sent gradient ──────────────────────────────────────────────
// Each sent bubble's gradient is the size of the screen; one rAF pass reads the on-screen top of
// the visible ones, then writes only background-position (paint, never layout).
const tintVisible = new Set();
let tintIO = null;
let tintRaf = 0;

function initTint() {
  tintIO = new IntersectionObserver((entries) => {
    for (const e of entries) { if (e.isIntersecting) tintVisible.add(e.target); else tintVisible.delete(e.target); }
    queueTint();
  }, { root: els.scroller, rootMargin: '160px 0px' });
  window.addEventListener('resize', queueTint, { passive: true });
}

function watchTint(row) {
  if (!tintIO || !row.classList.contains('out')) return;
  for (const el of row.querySelectorAll('.bubble.out:not(.jumbo), .bubble.out > .tl')) tintIO.observe(el);
}

export function queueTint() { if (!tintRaf) tintRaf = requestAnimationFrame(tint); }

// At most once per frame: all reads first, then only the background-positions that changed.
const tintLast = new WeakMap();
function tint() {
  tintRaf = 0;
  const els2 = [];
  const tops = [];
  for (const el of tintVisible) {
    if (!el.isConnected) { tintVisible.delete(el); tintIO.unobserve(el); continue; }
    els2.push(el);
    tops.push(el.getBoundingClientRect().top);
  }
  for (let i = 0; i < els2.length; i++) {
    const y = -Math.round(tops[i] * 2) / 2;
    if (tintLast.get(els2[i]) === y) continue;
    tintLast.set(els2[i], y);
    els2[i].style.backgroundPosition = `0 ${y}px`;
  }
}

// ── approval slider ────────────────────────────────────────────────────────
function initSlider() {
  let s = null;
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (!s) return;
    s.knob.style.transform = `translate3d(${s.x}px,0,0)`;
    s.card.classList.toggle('armed', s.x >= s.max * 0.8);
  };
  els.msgs.addEventListener('pointerdown', (e) => {
    const knob = e.target.closest('.appr-knob');
    if (!knob || knob.disabled || e.button > 0) return;
    const card = knob.closest('.appr');
    const track = knob.parentElement;
    s = { knob, card, id: e.pointerId, x0: e.clientX, x: 0, max: track.clientWidth - knob.offsetWidth - 2 * knob.offsetLeft };
    knob.classList.remove('back-spring');
    card.classList.add('dragging');
    try { knob.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.stopPropagation();
  });
  els.msgs.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x0;
    // Past the end it resists instead of stopping dead.
    s.x = dx < 0 ? 0 : dx > s.max ? s.max + (dx - s.max) * 0.15 : dx;
    if (!raf) raf = requestAnimationFrame(paint);
  });
  const end = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const st = s;
    s = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    st.card.classList.remove('dragging', 'armed');
    st.knob.classList.add('back-spring');
    if (st.x >= st.max * 0.8 && e.type === 'pointerup') {
      st.knob.style.transform = `translate3d(${st.max}px,0,0)`;
      st.card.classList.add('pending');
      navigator.vibrate?.(10);
      if (st.card.dataset.group) slideGroup(st.card.dataset.group);
      else press(st.card.dataset.id, st.card.dataset.primary);
    } else {
      st.knob.style.transform = '';
    }
    suppressClicks();
  };
  els.msgs.addEventListener('input', (e) => {
    const f = e.target.closest?.('.sealed-in');
    if (f) sealedDraft.set(Number(f.dataset.sealedFor), f.value);
  });
  els.msgs.addEventListener('pointerup', end);
  els.msgs.addEventListener('pointercancel', end);
  els.msgs.addEventListener('keydown', (e) => {
    const knob = e.target.closest?.('.appr-knob');
    if (!knob || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const card = knob.closest('.appr');
    if (card.dataset.group) slideGroup(card.dataset.group);
    else press(card.dataset.id, card.dataset.primary);
  });
}

function suppressClicks() {
  document.body.classList.add('lp-suppress');
  setTimeout(() => document.body.classList.remove('lp-suppress'), 300);
}

// ── header ───────────────────────────────────────────────────────────────

export function renderHeader() {
  if (apprMode) { renderApprHeader(); return; }
  if (!current) return;
  const chat = state.chats.get(current);
  if (!chat) return;
  const n = totalUnread(current);
  const count = n ? String(n > 9999 ? '9999+' : n) : '';
  if (els.backCount.textContent !== count) els.backCount.textContent = count;
  els.back.classList.toggle('has-count', !!n);
  els.back.setAttribute('aria-label', n ? `Back, ${n} unread` : 'Back');
  // Avatar and name only change with the chat itself; live events never rebuild them.
  const partner = dmPartner(chat);
  const name = chat.title || (partner ? member(partner).name : chat.id);
  const sub = headSubtitle(chat, partner);
  const sig = `${current}|${name}|${sub}`;
  if (sig !== headSig) {
    headSig = sig;
    els.headAv.replaceChildren(chatAvatar(chat, 60));
    const pm = partner ? member(partner) : null;
    const chips = chat.kind !== 'room' && pm?.kind === 'bot' && pm.clients?.length ? clientChips(pm.clients) : null;
    els.headName.replaceChildren(...[
      h('span', { class: 'hn-name' }, h('span', { class: 'hn-text' }, name), icon('chevron')),
      chips ? h('span', { class: 'hn-sub hn-clients', 'aria-label': sub }, chips) : sub ? h('span', { class: 'hn-sub' }, sub) : null].filter(Boolean));
    els.headName.classList.toggle('two', !!sub);
  }
  renderStatus();
}

function headSubtitle(chat, partner) {
  if (chat.kind === 'room') {
    const bots = (chat.members || []).filter((id) => member(id).kind === 'bot').length;
    return bots ? `${bots} bots` : '';
  }
  const m = partner ? member(partner) : null;
  if (!m) return '';
  return m.clients?.length ? `(${m.clients.join(', ')})` : m.role || '';
}

function renderStatus() {
  const ty = current ? typers(current) : [];
  const st = els.headStatus;
  // The header mark carries the thin working ring while this bot is at it (never the room's mark).
  els.headAv.firstElementChild?.classList.toggle('working', ty.length > 0 && state.chats.get(current)?.kind !== 'room');
  if (!ty.length) { st.textContent = ''; st.classList.remove('on'); return; }
  const [c1, c2] = colorsOf(ty[0].id);
  st.style.setProperty('--c1', c1);
  st.style.setProperty('--c2', c2);
  let text;
  if (ty[0].status) text = `${firstName(ty[0].id)} · ${ty[0].status}`;
  else if (ty.length === 1) text = `${firstName(ty[0].id)} is typing`;
  else if (ty.length === 2) text = `${firstName(ty[0].id)} and ${firstName(ty[1].id)} are typing`;
  else text = `${ty.length} people are typing`;
  st.textContent = text;
  st.classList.add('on');
}

// ── live events ──────────────────────────────────────────────────────────

export function onLiveMessage(m) {
  const t = thread(m.chat_id);
  const exists = t.loaded && t.messages.some((x) => (m.id != null && x.id === m.id) || (m.client_id && x.client_id === m.client_id && x.sender === m.sender));
  if (!exists && current === m.chat_id && !isMe(m.sender)) animate.set(keyOf(m), 'in');
  const res = upsert(m);
  if (current === m.chat_id && res) scheduleRender(isMe(m.sender) ? 'bottom' : 'auto');
  else if (apprMode && res) scheduleRender('auto');
  return !exists;
}

export function onLiveUpdate(m) {
  if (pressing.has(m.id) && m.resolved) { clearTimeout(pressing.get(m.id).timer); pressing.delete(m.id); }
  const res = upsert(m);
  if (current === m.chat_id && res) scheduleRender(isWork(m) ? 'anchor' : 'auto');
  else if (apprMode && res) scheduleRender('auto');
}

export function onTypingChange(chatId) {
  if (chatId === current) { renderStatus(); scheduleRender('auto'); }
}

export function onRead({ chat_id, member_id, last_id, at }) {
  const t = thread(chat_id);
  if (t.reads[member_id] == null || Number(last_id) > Number(t.reads[member_id])) {
    t.reads[member_id] = last_id;
    t.readAt[member_id] = at ? toMs(at) : Date.now();
  }
  if (chat_id === current) scheduleRender('auto');
}

// Avatars update in place via refreshPresence; the receipt and delivery notes name a bot that is offline.
export function onPresence(memberId) {
  if (current && state.chats.get(current)?.members?.includes(memberId)) scheduleRender('auto');
}

// ── reading ──────────────────────────────────────────────────────────────

export function maybeMarkRead() {
  if (!current || document.visibilityState !== 'visible' || !stick) return;
  const chatId = current;
  const t = thread(chatId);
  if (!t.loaded) return;
  let newest = null;
  for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i].id != null) { newest = t.messages[i]; break; }
  const chat = state.chats.get(chatId);
  if (!newest || !chat) return;
  if (t.lastReadSent === newest.id) {
    if (chat.unread) { chat.unread = 0; hooks.onChatChange(); }
    return;
  }
  t.lastReadSent = newest.id;
  if (chat.unread) { chat.unread = 0; hooks.onChatChange(); }
  post(`/api/chats/${encodeURIComponent(chatId)}/read`, { last_id: newest.id }).catch(() => { t.lastReadSent = null; });
}

// ── sending ──────────────────────────────────────────────────────────────

export function send({ text, reply_to, attachments }) {
  if (!current || !state.me) return;
  const chatId = current;
  const m = {
    id: null,
    client_id: uuid(),
    chat_id: chatId,
    sender: state.me.id,
    text: text || '',
    at: Date.now(),
    edited_at: null,
    kind: 'text',
    reply_to: reply_to ? { id: reply_to.id, sender: reply_to.sender, text: reply_to.text || '', ...(isWork(reply_to) ? { work: true } : {}) } : null,
    ...(isWork(reply_to) ? { to_claude: true } : {}),
    buttons: null,
    resolved: null,
    attachments: attachments || [],
    reactions: [],
    _status: 'sending',
  };
  animate.set(keyOf(m), 'out');
  const t = thread(chatId);
  t.messages.push(m);
  stick = true;
  render('bottom');
  deliver(m);
}

async function deliver(m) {
  try {
    const r = await post(`/api/chats/${encodeURIComponent(m.chat_id)}/messages`, {
      text: m.text,
      reply_to: m.reply_to?.id ?? undefined,
      client_id: m.client_id,
      attachments: m.attachments.map((a) => a.id),
    });
    if (r?.message) {
      const server = { ...r.message, client_id: r.message.client_id || m.client_id };
      upsert(server);
      hooks.onChatChange();
    }
  } catch {
    markFailed(m.chat_id, m.client_id);
  }
  if (current === m.chat_id) scheduleRender('auto');
}

function markFailed(chatId, clientId) {
  const t = thread(chatId);
  const i = t.messages.findIndex((x) => x.client_id === clientId && x.id == null);
  if (i >= 0) t.messages[i] = { ...t.messages[i], _status: 'failed' };
}

function retry(clientId) {
  const t = thread(current);
  const i = t.messages.findIndex((x) => x.client_id === clientId && x.id == null);
  if (i < 0) return;
  const m = { ...t.messages[i], _status: 'sending' };
  t.messages[i] = m;
  render('auto');
  deliver(m);
}

// ── reactions and cards ──────────────────────────────────────────────────

export function messageForKey(key) {
  return nodes.get(key)?.m || null;
}

export async function react(m, emoji) {
  if (m.id == null) return;
  const mineNow = (m.reactions || []).find((r) => isMe(r.member_id));
  const next = mineNow && mineNow.emoji === emoji ? null : emoji;
  // Optimistic: show the change at once, then take the server's copy.
  const reactions = (m.reactions || []).filter((r) => !isMe(r.member_id));
  if (next) reactions.push({ member_id: state.me.id, emoji: next });
  upsert({ ...m, reactions });
  scheduleRender('auto');
  try {
    const r = await post(`/api/messages/${encodeURIComponent(m.id)}/react`, { emoji: next });
    if (r?.message) { upsert(r.message); scheduleRender('auto'); }
  } catch {
    upsert(m);
    scheduleRender('auto');
    toast('Couldn’t send the reaction.');
  }
}

// The card being pressed: in the open thread, or in any loaded thread from the Approvals view.
function cardById(id) {
  const same = (x) => String(x.id) === String(id);
  if (!apprMode) return thread(current).messages.find(same);
  for (const t of state.threads.values()) { const m = t.loaded && t.messages.find(same); if (m) return m; }
  return null;
}

// Returns whether the press went through. `quiet`: a group slide says how it went once, at the end, and a card
// whose press failed keeps the reason on itself (11-11).
async function press(id, data, edit = null, { quiet = false } = {}) {
  const m = cardById(id);
  if (!m || pressing.has(m.id) || m.resolved) return false;
  let sealed = null;
  if (/^a\|/.test(String(data)) && readCard(m).sealed) {
    sealed = (sealedDraft.get(m.id) || '').trim();
    if (!sealed) { toast(`Enter the ${readCard(m).sealed} first.`); scheduleRender('auto'); return false; }
  }
  pressErr.delete(m.id);
  const timer = setTimeout(() => { pressing.delete(m.id); scheduleRender('auto'); }, 20000);
  pressing.set(m.id, { data, timer });
  scheduleRender('auto');
  try {
    const r = await post(`/api/messages/${encodeURIComponent(m.id)}/press`, edit != null ? { data, edit } : sealed ? { data, sealed } : { data });
    if (sealed) sealedDraft.delete(m.id);
    if (r?.message) {
      if (r.message.resolved) { clearTimeout(timer); pressing.delete(m.id); }
      upsert(r.message);
    }
  } catch (e) {
    clearTimeout(timer);
    pressing.delete(m.id);
    pressErr.set(m.id, e.status === 409 ? 'Already answered somewhere else.' : 'This one did not go through. Slide it again.');
    if (!quiet) toast(e.status === 409 ? 'Already answered.' : 'Couldn’t send that. Try again.');
    scheduleRender('auto');
    return false;
  }
  scheduleRender('auto');
  return true;
}

// Review with edits: the draft text in a sheet; Send approves the card with the changed words (the
// approvals service sends exactly what is here). Texts only; an email goes out as its Gmail draft.
function editCard(id) {
  const m = cardById(id);
  if (!m || m.resolved || pressing.has(m.id)) return;
  const c = readCard(m);
  if (c.draft == null) return;
  const primary = (m.buttons || []).flat().find((b) => /^a\|\d+\|/.test(String(b.data || '')));
  if (!primary) return;
  const field = h('textarea', { class: 'ed-field', rows: '6', 'aria-label': 'The text that will be sent' });
  field.value = c.draft;
  const count = h('span', { class: 'ed-count num' });
  const sendBtn = h('button', { class: 'ed-send', type: 'button' }, 'Send this text');
  const close = () => { ov.classList.remove('show'); setTimeout(() => ov.remove(), 260); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const sync = () => {
    const v = field.value.trim();
    count.textContent = `${v.length} characters${v === c.draft.trim() ? '' : ' · edited'}`;
    sendBtn.disabled = !v || v.length > 4000;
  };
  field.addEventListener('input', sync);
  sendBtn.addEventListener('click', () => { const v = field.value.trim(); if (!v) return; close(); press(m.id, primary.data, v); });
  const ov = h('div', { class: 'ed-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit before sending' },
    h('div', { class: 'ed-sheet' },
      h('div', { class: 'ed-top' }, h('button', { class: 'ed-cancel', type: 'button' }, 'Cancel'), h('b', {}, 'Edit before sending'), h('span')),
      h('div', { class: 'ed-head' }, appMark(c.app, 36), h('div', { class: 'ap-tx' }, h('div', { class: 'ap-title' }, c.title), c.sub ? h('div', { class: 'ap-sub' }, c.sub) : null)),
      field, count, sendBtn,
      h('div', { class: 'ed-note' }, 'Sends exactly these words. The bot\u2019s draft is replaced.')));
  ov.querySelector('.ed-cancel').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', key);
  document.body.append(ov);
  sync();
  requestAnimationFrame(() => { ov.classList.add('show'); field.focus(); });
}

// "Change it" (11-02): The owner tells the bot what to do instead ("start a Claude session for this", "don't text
// him, he already paid", "check the website first"). Nothing on the card goes out; the card closes as Changed and
// his words go into the thread as his reply under it, so the bot redoes it his way.
const CHANGE_STARTS = [
  ['Start a Claude session for this instead', 'Start a Claude session for this instead. '],
  ['Don\u2019t send it', 'Don\u2019t send this. '],
  ['Check first', 'Check the website first, then redo this. '],
  ['Do it, but change this', 'Do it, but change this: '],
];
function changeable(m) {
  return (m.buttons || []).flat().some((b) => !b.url && (b.style === 'danger' || /^[ag]\|\d+\|/.test(String(b.data || ''))));
}
function changeCard(id) {
  const m = cardById(id);
  if (!m || m.resolved || pressing.has(m.id) || !changeable(m)) return;
  const c = readCard(m);
  const who = firstName(m.sender);
  const field = h('textarea', { class: 'ed-field ch-field', rows: '5', 'aria-label': `What ${who} should do instead`, placeholder: `Tell ${who} what to do instead` });
  const sendBtn = h('button', { class: 'ed-send', type: 'button' }, `Send to ${who}`);
  const close = () => { ov.classList.remove('show'); setTimeout(() => ov.remove(), 260); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const sync = () => { const v = field.value.trim(); sendBtn.disabled = !v || v.length > 2000; };
  const starts = h('div', { class: 'ch-starts', role: 'group', 'aria-label': 'Ways to start' },
    CHANGE_STARTS.map(([label, text]) => h('button', { class: 'ch-start', type: 'button', dataset: { text } }, label)));
  starts.addEventListener('click', (e) => {
    const b = e.target.closest('.ch-start');
    if (!b) return;
    const cur = field.value.trim();
    field.value = cur ? `${cur} ${b.dataset.text}` : b.dataset.text;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    sync();
  });
  field.addEventListener('input', sync);
  let busy = false;
  sendBtn.addEventListener('click', async () => {
    const v = field.value.trim();
    if (!v || busy) return;
    busy = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending\u2026';
    try {
      const r = await post(`/api/messages/${encodeURIComponent(m.id)}/change`, { text: v });
      if (r?.message) upsert(r.message);
      if (r?.reply) upsert(r.reply);
      close();
      if (apprMode) toast(`Sent to ${who}. Nothing on the card went out.`);
      scheduleRender('auto');
    } catch (e) {
      busy = false;
      sendBtn.textContent = `Send to ${who}`;
      sync();
      toast(e.status === 409 ? 'Already answered.' : 'Couldn\u2019t send that. Try again.');
    }
  });
  const ov = h('div', { class: 'ed-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Change it' },
    h('div', { class: 'ed-sheet' },
      h('div', { class: 'ed-top' }, h('button', { class: 'ed-cancel', type: 'button' }, 'Cancel'), h('b', {}, 'Change it'), h('span')),
      h('div', { class: 'ed-head' }, appMark(c.app, 36, c.app2), h('div', { class: 'ap-tx' }, h('div', { class: 'ap-title' }, c.title), c.sub ? h('div', { class: 'ap-sub' }, c.sub) : null)),
      starts, field, sendBtn,
      h('div', { class: 'ed-note' }, `Nothing on this card goes out. ${who} gets your words as a reply and redoes it.`)));
  ov.querySelector('.ed-cancel').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', key);
  document.body.append(ov);
  sync();
  requestAnimationFrame(() => { ov.classList.add('show'); field.focus(); });
}

// Ask (11-02, the owner: "I need to be able to ask it questions if I'm unsure about what it's talking about"): his
// question goes to the bot as a reply under the card, the card stays up for his slide, and the bot answers in the chat.
const ASK_STARTS = ['Why this?', 'Where did this come from?', 'What happens when I slide it?', 'Is this already done?'];
function askCard(id) {
  const m = cardById(id);
  if (!m || m.resolved) return;
  const c = readCard(m);
  const who = firstName(m.sender);
  const field = h('textarea', { class: 'ed-field ch-field', rows: '4', 'aria-label': `Your question for ${who}`, placeholder: `Ask ${who} about this card` });
  const sendBtn = h('button', { class: 'ed-send', type: 'button' }, `Ask ${who}`);
  const close = () => { ov.classList.remove('show'); setTimeout(() => ov.remove(), 260); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const sync = () => { const v = field.value.trim(); sendBtn.disabled = !v || v.length > 4000; };
  const starts = h('div', { class: 'ch-starts', role: 'group', 'aria-label': 'Quick questions' },
    ASK_STARTS.map((q) => h('button', { class: 'ch-start', type: 'button', dataset: { text: q } }, q)));
  starts.addEventListener('click', (e) => {
    const b = e.target.closest('.ch-start');
    if (!b) return;
    field.value = field.value.trim() ? `${field.value.trim()} ${b.dataset.text}` : b.dataset.text;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    sync();
  });
  field.addEventListener('input', sync);
  let busy = false;
  sendBtn.addEventListener('click', async () => {
    const v = field.value.trim();
    if (!v || busy) return;
    busy = true;
    if (!apprMode && current === m.chat_id) { close(); send({ text: v, reply_to: m }); return; }
    // From the Approvals screen: send it, then open the chat at his question so the answer arrives in view.
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending\u2026';
    try {
      const r = await post(`/api/chats/${encodeURIComponent(m.chat_id)}/messages`, { text: v, reply_to: m.id, client_id: uuid() });
      if (r?.message) upsert(r.message);
      close();
      hooks.openAt(m.chat_id, r?.message?.id ?? m.id);
    } catch {
      busy = false;
      sendBtn.textContent = `Ask ${who}`;
      sync();
      toast('Couldn\u2019t send that. Try again.');
    }
  });
  const ov = h('div', { class: 'ed-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Ask ${who}` },
    h('div', { class: 'ed-sheet' },
      h('div', { class: 'ed-top' }, h('button', { class: 'ed-cancel', type: 'button' }, 'Cancel'), h('b', {}, `Ask ${who}`), h('span')),
      h('div', { class: 'ed-head' }, appMark(c.app, 36, c.app2), h('div', { class: 'ap-tx' }, h('div', { class: 'ap-title' }, c.title), c.sub ? h('div', { class: 'ap-sub' }, c.sub) : null)),
      starts, field, sendBtn,
      h('div', { class: 'ed-note' }, `The card stays up. ${who} answers in the chat.`)));
  ov.querySelector('.ed-cancel').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', key);
  document.body.append(ov);
  sync();
  requestAnimationFrame(() => { ov.classList.add('show'); field.focus(); });
}

function onMsgsClick(e) {
  if (document.body.classList.contains('lp-suppress')) return;
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const id = Number(pick.dataset.pick);
    if (unpicked.has(id)) unpicked.delete(id); else unpicked.add(id);
    navigator.vibrate?.(6);
    renderApprovals();
    return;
  }
  const oc = e.target.closest('[data-open-client]');
  if (oc) { hooks.openClient(oc.dataset.openClient); return; }
  const wr = e.target.closest('[data-work-reply]');
  if (wr) { const m = cardById(wr.dataset.workReply); if (m) hooks.reply(m); return; }
  const wa = e.target.closest('[data-work-ack]');
  if (wa) { workAck(Number(wa.dataset.workAck)); return; }
  const we = e.target.closest('[data-work-earlier]');
  if (we) {
    const id = Number(we.dataset.workEarlier);
    if (earlierOpen.has(id)) earlierOpen.delete(id); else earlierOpen.add(id);
    stick = false;
    render('anchor');
    return;
  }
  const ask = e.target.closest('[data-ask-card]');
  if (ask) { askCard(Number(ask.dataset.askCard)); return; }
  const ed = e.target.closest('[data-edit-card]');
  if (ed) { editCard(Number(ed.dataset.editCard)); return; }
  const ch = e.target.closest('[data-change-card]');
  if (ch) { changeCard(Number(ch.dataset.changeCard)); return; }
  const undoBtn = e.target.closest('[data-undo]');
  if (undoBtn && !undoBtn.disabled) { undoPress(undoBtn); return; }
  const pressBtn = e.target.closest('[data-press]');
  if (pressBtn) { press(pressBtn.dataset.id, pressBtn.dataset.press); return; }
  const cref = e.target.closest('[data-card]');
  if (cref) { openCard(Number(cref.dataset.card)); return; }
  const openAt = e.target.closest('[data-open-chat]');
  if (openAt) { hooks.openAt(openAt.dataset.openChat, openAt.dataset.openMsg); return; }
  const more = e.target.closest('[data-more]');
  if (more) {
    const id = Number(more.dataset.more);
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    if (apprMode) { renderApprovals(); return; }
    stick = false;
    render('auto');
    return;
  }
  const r = e.target.closest('[data-retry]');
  if (r) { retry(r.dataset.retry); return; }
  const again = e.target.closest('[data-resend]');
  if (again) { resend(Number(again.dataset.resend), again); return; }
  const stop = e.target.closest('[data-stop-bot]');
  if (stop) { stopBot(stop.dataset.stopChat, stop.dataset.stopBot, stop); return; }
  const v = e.target.closest('[data-view]');
  if (v) { viewImage(v.dataset.view, v.querySelector('img')?.alt, v.dataset.preview); return; }
  const j = e.target.closest('[data-jump]');
  if (j) jumpTo(j.dataset.jump);
}

// "Looks good" on a finished work card: shown at once, then marked on the server (nobody is woken).
async function workAck(id) {
  const m = cardById(id);
  if (!m || !isWork(m) || acking.has(m.id) || m.work.acked_at || !WORK_FINISHED.has(m.work.state)) return;
  acking.add(m.id);
  scheduleRender('anchor');
  try {
    const r = await post(`/api/messages/${encodeURIComponent(m.id)}/work`, { ack: true });
    if (r?.message) upsert(r.message);
  } catch {
    toast('Couldn\u2019t mark it. Try once more.');
  }
  acking.delete(m.id);
  scheduleRender('anchor');
}

// ── card chips ──────────────────────────────────────────────────────────
// What a "card #91" chip shows: the card's app and plain title, from any loaded thread; a card that is not
// loaded is asked of the server once, and its chips are patched in place when it arrives.
const cardsSeen = new Map(); // card id -> message
const cardsAsked = new Set();
function findCard(id) {
  for (const t of state.threads.values()) for (const m of t.messages) if (cardIdOf(m) === id) return m;
  return cardsSeen.get(id) || null;
}
function infoOf(m) {
  const waiting = m.buttons?.length && !m.resolved;
  const r = waiting ? readCard(m) : readTask(m);
  return r ? { app: r.app, title: r.title } : null;
}
function cardInfo(id) {
  const m = findCard(id);
  if (m) return infoOf(m);
  if (!cardsAsked.has(id)) {
    cardsAsked.add(id);
    api(`/api/cards/${id}`).then((r) => {
      if (!r?.message) return;
      cardsSeen.set(id, r.message);
      const info = infoOf(r.message);
      if (!info) return;
      for (const el of document.querySelectorAll(`.cref[data-card="${id}"]`)) {
        el.replaceChildren(appMark(info.app, 18), h('span', {}, info.title.length > 34 ? `${info.title.slice(0, 33)}…` : info.title));
      }
    }).catch(() => {});
  }
  return null;
}
async function openCard(id) {
  let m = findCard(id);
  if (!m) { try { m = (await api(`/api/cards/${id}`))?.message || null; } catch { m = null; } }
  if (!m) { toast('That card is no longer here.'); return; }
  if (m.chat_id === current && nodes.get(`m:${m.id}`)) { jumpTo(m.id); return; }
  hooks.openAt(m.chat_id, m.id);
}

function jumpTo(id) {
  const rec = nodes.get(`m:${id}`) || [...nodes.values()].find((r) => r.m && String(r.m.id) === String(id));
  if (!rec) return;
  rec.el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  rec.el.classList.remove('flash');
  void rec.el.offsetWidth;
  rec.el.classList.add('flash');
}

// ── approvals and client pages ───────────────────────────────────────────
// Approvals (#/approvals): every waiting card from every bot, grouped by client (one client can have six cards at once,
// each needing its own slide). A client's page (#/client/<key>): that client's Needs you, In motion and Done today.
// Both live in the thread pane and keep the thread's own approvalCard (slide, Decline, Ask, Change it, Details), so
// the slider and clicks above work unchanged. A quiet line above each card says who asked, where, and how long ago.
// In a group of two or more plain approve sliders, one "slide to approve N" sends each checked card's own press in
// order (each keeps its own id and hash); a card that fails stays up with what went wrong, and the rest still go.
// A card that gets answered (here, in its chat, on another device) or withdrawn fades out and the ones below glide
// up; new cards from the live stream rise in.

const apprItems = new Map(); // block id -> {el, sig, m}
let apprPainted = false; // the first paint has happened (later arrivals animate in)
let apprTimer = 0;
let boardKey = null; // the client whose page is open, or null for Approvals
const unpicked = new Set(); // cards he left out of their group's slide (message ids)
const sweeping = new Map(); // group -> {i, n} while its slide sends
const swept = new Map(); // group -> {failed} after a slide where some did not go
const pressErr = new Map(); // card id -> what went wrong with its last press
const APPR_EASE = 'cubic-bezier(.32,.72,0,1)';

export const approvalsOpen = () => apprMode && !boardKey;
export const clientOpen = () => (apprMode ? boardKey : null);

function enterBoard(key) {
  if (apprMode && boardKey === key) { renderApprovals(); return; }
  apprMode = true;
  boardKey = key;
  current = null;
  built = null;
  nodes.clear();
  animate.clear();
  apprItems.clear();
  apprPainted = false;
  headSig = '';
  els.msgs.replaceChildren();
  els.pane.classList.add('has-chat', 'appr-view');
  els.pane.classList.toggle('client-view', !!key);
  syncPads();
  renderApprovals();
  els.scroller.scrollTop = 0;
  apprPainted = true;
  clearInterval(apprTimer);
  apprTimer = setInterval(patchAges, 30000);
}
export function showApprovals() { enterBoard(null); }
export function showClient(key) { enterBoard(key); }

function leaveApprovals() {
  if (!apprMode) return;
  apprMode = false;
  boardKey = null;
  els.pane.classList.remove('client-view');
  clearInterval(apprTimer);
  apprTimer = 0;
  headSig = '';
}

function renderApprHeader(n = waitingCards().length) {
  const unread = totalUnread(null);
  const count = unread ? String(unread > 9999 ? '9999+' : unread) : '';
  if (els.backCount.textContent !== count) els.backCount.textContent = count;
  els.back.classList.toggle('has-count', !!unread);
  els.back.setAttribute('aria-label', unread ? `Back, ${unread} unread` : 'Back');
  const title = boardKey ? nameOf(boardKey) : 'Approvals';
  const sub = boardKey ? (n ? `${n} need${n === 1 ? 's' : ''} you` : '') : (n ? `${n} waiting` : '');
  const sig = `appr|${title}|${sub}`;
  if (sig !== headSig) {
    headSig = sig;
    els.headAv.replaceChildren();
    els.headName.replaceChildren(...[
      h('span', { class: 'hn-name' }, h('span', { class: 'hn-text' }, title)),
      sub ? h('span', { class: 'hn-sub' }, sub) : null].filter(Boolean));
    els.headName.classList.toggle('two', !!sub);
  }
  els.headStatus.textContent = '';
  els.headStatus.classList.remove('on');
}

const apprSig = (m) => {
  const pr = pressing.get(m.id);
  return JSON.stringify([m.text, m.buttons, m.edited_at, pr ? pr.data : '', expanded.has(m.id), pressErr.get(m.id) || '']);
};
const imagesOf = (m) => (m.attachments || []).filter((a) => String(a.type || '').startsWith('image/'));
const mediaSig = (m) => (m.attachments || []).map((a) => a.id || a.url).join(',');

// A card's pictures (the creatives he is approving), sized to the column: one image full width at
// its own shape, two to four as an even grid of squares. Each opens the photo viewer.
function apprMedia(m) {
  const imgs = imagesOf(m).slice(0, 4);
  if (!imgs.length) return null;
  const one = imgs.length === 1;
  const box = h('div', { class: `ap-media${one ? ' one' : ` grid g${imgs.length}`}` });
  for (const a of imgs) {
    const known = (a.width && a.height) ? { w: a.width, h: a.height } : imgSize.get(a.url);
    const img = h('img', {
      class: `ap-img${known?.loaded ? ' ready' : ''}`, src: a.preview || a.url, alt: a.name || 'Photo', decoding: 'async', draggable: 'false',
      style: one && known ? { aspectRatio: `${known.w} / ${known.h}` } : null,
      onload: (e) => {
        const el = e.target;
        el.classList.add('ready');
        if (!imgSize.get(a.url)?.loaded) imgSize.set(a.url, { w: el.naturalWidth, h: el.naturalHeight, loaded: true });
        if (one) el.style.aspectRatio = `${el.naturalWidth} / ${el.naturalHeight}`;
      },
    });
    box.append(h('button', { class: 'att ap-att', type: 'button', dataset: { view: a.url, preview: a.preview || a.url }, 'aria-label': `Photo ${a.name || ''}`.trim() }, img));
  }
  return box;
}

function apprContext(m) {
  const chat = state.chats.get(m.chat_id);
  const room = chat?.kind === 'room';
  const at = toMs(m.at);
  return h('div', { class: 'ap-ctx' },
    // In a group with one slide: the circle says whether this card goes with it (checked unless he left it out).
    h('button', { class: 'ap-pick', type: 'button', role: 'checkbox', 'aria-checked': 'true', dataset: { pick: m.id }, 'aria-label': 'Include this card in the group slide' },
      h('span', { class: 'ap-pick-ring' }, icon('check'))),
    avatar(m.sender, 22, { dot: false }),
    // Name and age always show in full; on a narrow phone only the room name gives way.
    h('span', { class: 'ap-who' },
      h('b', {}, firstName(m.sender)),
      room ? h('span', { class: 'ap-chat' }, ` · ${chat.title || 'Team'}`) : null,
      h('span', { class: 'ap-age', dataset: { at } }, ` · ${fmtAge(at)}`)),
    h('button', {
      class: 'ap-open', type: 'button', dataset: { openChat: m.chat_id, openMsg: m.id },
      'aria-label': `Open ${room ? chat.title || 'the room' : `the chat with ${firstName(m.sender)}`} at this card`,
    }, 'Open chat'));
}

function apprItem(m) {
  return h('div', { class: 'ap-item', dataset: { key: keyOf(m), id: m.id } }, apprContext(m), apprMedia(m), cardDocs(m), approvalCard(m));
}

// Whether a card sits in a group slide, and whether it is checked for it.
function syncPick(el, m, group) {
  const left = !!group && unpicked.has(m.id);
  el.classList.toggle('in-sweep', !!group);
  el.classList.toggle('left-out', left);
  const b = el.querySelector(':scope > .ap-ctx > .ap-pick');
  if (b && b.getAttribute('aria-checked') !== String(!left)) b.setAttribute('aria-checked', String(!left));
}

function patchAges() {
  for (const el of els.msgs.querySelectorAll('.ap-age')) {
    const t = ` · ${fmtAge(Number(el.dataset.at))}`;
    if (el.textContent !== t) el.textContent = t;
  }
}

// ── the blocks of the page ──
// Each block: {id, card?, m?, group?} for a card, or {id, sig, make} for everything else (group heads, the group
// slide, section labels, the client page's rows).
const groupId = (key) => key || 'other';
function groupHead(g) {
  const cl = clientByKey(g.key);
  const n = g.cards.length;
  return h(g.key ? 'button' : 'div', { class: 'ap-block ap-ghead', ...(g.key ? { type: 'button', dataset: { openClient: g.key }, 'aria-label': `${g.name}: ${n} waiting. Open ${g.name}.` } : {}) },
    cl ? clientMark(cl, 26) : h('span', { class: 'gh-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'gh-name' }, g.name),
    h('span', { class: 'gh-count num' }, String(n)),
    g.key ? icon('chevron') : null);
}
function slideBlock(key, sw) {
  const run = sweeping.get(key) || null;
  const res = swept.get(key) || null;
  const picked = sw.filter((m) => !unpicked.has(m.id));
  return { id: `gs:${key}`, sig: JSON.stringify([sw.map((m) => m.id), picked.map((m) => m.id), run, res]), make: () => groupSlide(key, sw, picked, run, res) };
}
function groupSlide(key, sw, picked, run, res) {
  const n = picked.length;
  const what = run ? `Approving ${run.i + 1} of ${run.n}…` : n ? `slide to approve ${n}` : 'Check a card to approve';
  const line = run ? 'Each card goes as its own approval.'
    : n === sw.length ? `All ${n} cards above, each sent as its own approval.` : `${n} of the ${sw.length} cards above. ${sw.length - n === 1 ? 'The other one stays' : 'The others stay'} here.`;
  const who = clientByKey(key)?.short || null;
  return h('div', { class: 'ap-block ap-gs' },
    h('div', { class: `appr ap-gslide${run ? ' pending' : ''}${n ? '' : ' none'}`, dataset: { id: `gs:${key}`, group: key } },
      h('div', { class: 'gs-tx' }, who ? h('b', {}, `${who} · `) : null, line),
      res?.failed ? h('div', { class: 'gs-err', role: 'status' }, `${res.failed === 1 ? '1 card' : `${res.failed} cards`} did not go through. ${res.failed === 1 ? 'It is' : 'They are'} still above with what went wrong.`) : null,
      h('div', { class: 'appr-track' },
        h('span', { class: 'appr-hint', 'aria-hidden': 'true' }, what),
        h('span', { class: 'appr-end', 'aria-hidden': 'true' }),
        h('button', { class: 'appr-knob', type: 'button', disabled: !!run || !n, role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': run ? '100' : '0',
          'aria-label': `Slide to approve ${n} ${n === 1 ? 'card' : 'cards'}` }, icon('chevron')))));
}
const label = (id, text) => ({ id: `sl:${id}`, sig: text, make: () => h('div', { class: 'ap-block ap-sec' }, text) });

// One row on a client's page: what it is, where it stands, and the chat it lives in.
const TONE = { Working: 'busy', Sending: 'busy', 'Being fixed': 'busy', 'Waiting to start': 'wait', 'Sends soon': 'wait' };
function cpRow(x, done) {
  const app = x.kind === 'work' ? 'claude' : x.app || 'task';
  const who = x.bot && member(x.bot)?.name ? firstName(x.bot) : '';
  const line = done ? '' : x.kind === 'work' ? (x.state === 'working' ? x.step || `Claude, for ${who || 'the team'}` : 'Waits for a free slot')
    : x.kind === 'stop' ? 'Sends unless you tap Stop' : [who, x.at ? `since ${fmtTime(x.at)}` : ''].filter(Boolean).join(' · ');
  const tone = done ? x.tone || 'ok' : TONE[x.word] || 'busy';
  const open = x.chat_id && state.chats.has(x.chat_id) ? { openChat: x.chat_id, ...(x.message_id ? { openMsg: x.message_id } : {}) } : null;
  return h(open ? 'button' : 'div', { class: `cp-row${done ? ' done' : ''}`, ...(open ? { type: 'button', dataset: open } : {}) },
    appMark(app, done ? 28 : 36),
    h('span', { class: 'cp-tx' }, h('b', {}, x.title), line ? h('span', {}, line) : null),
    done ? h('span', { class: `cp-when ${tone}` }, h('span', {}, x.word), x.at ? ` ${fmtTime(x.at)}` : '')
      : h('span', { class: `cp-pill ${tone}` }, x.word),
    open && !done ? icon('chevron') : null);
}

function boardBlocks() {
  const all = waitingCards();
  const out = [];
  if (!boardKey) {
    for (const g of groupCards(all)) {
      const key = groupId(g.key);
      const sw = g.cards.filter(sweepable);
      const inSweep = sw.length >= 2 ? key : null;
      out.push({ id: `gh:${key}`, sig: JSON.stringify([g.name, g.cards.length]), make: () => groupHead(g) });
      for (const m of g.cards) out.push({ id: String(m.id), card: true, m, group: inSweep && sweepable(m) ? key : null });
      if (inSweep) out.push(slideBlock(key, sw));
    }
    return { out, n: all.length };
  }
  const need = needsFor(boardKey, all);
  const stops = stopsFor(boardKey, all);
  const c = clientOfBoard(boardKey);
  if (need.length) {
    out.push(label('need', 'Needs you'));
    const sw = need.filter(sweepable);
    for (const m of need) out.push({ id: String(m.id), card: true, m, group: sw.length >= 2 && sweepable(m) ? boardKey : null });
    if (sw.length >= 2) out.push(slideBlock(boardKey, sw));
  }
  const motion = (c?.motion || []).filter((x) => !(x.kind === 'stop' && stops.some((m) => m.id === x.message_id)));
  if (stops.length || motion.length) {
    out.push(label('motion', 'In motion'));
    for (const m of stops) out.push({ id: String(m.id), card: true, m, group: null });
    if (motion.length) out.push({ id: 'cp:motion', sig: JSON.stringify(motion), make: () => h('div', { class: 'ap-block cells cp-cells' }, motion.map((x) => cpRow(x, false))) });
  }
  const done = c?.done || [];
  if (done.length) {
    out.push(label('done', 'Done today'));
    out.push({ id: 'cp:done', sig: JSON.stringify(done), make: () => h('div', { class: 'ap-block cells cp-cells' }, done.map((x) => cpRow(x, true))) });
  }
  if (!need.length && !stops.length && !motion.length && !done.length) {
    const name = nameOf(boardKey);
    out.push({ id: 'cp:quiet', sig: name, make: () => h('div', { class: 'ap-block cp-quiet', role: 'status' }, icon('check'), h('b', {}, 'Nothing going on'), h('span', {}, `Nothing for ${name} needs you, is moving or got done today.`)) });
  }
  const owner = ownerOf(boardKey);
  if (owner && state.chats.has(`dm-${owner}`)) {
    out.push({ id: 'cp:open', sig: owner, make: () => h('div', { class: 'ap-block cells cp-cells cp-open' },
      h('button', { class: 'cp-row', type: 'button', dataset: { openChat: `dm-${owner}` } }, avatar(owner, 36, { dot: false }),
        h('span', { class: 'cp-tx' }, h('b', {}, `Open ${firstName(owner)}’s thread`), h('span', {}, `${firstName(owner)} looks after ${nameOf(boardKey)}`)), icon('chevron'))) });
  }
  return { out, n: need.length };
}

// The cards one group's slide would send now, in the order they show.
function sweepList(key) {
  const all = waitingCards();
  const cards = boardKey ? needsFor(boardKey, all) : (groupCards(all).find((g) => groupId(g.key) === key)?.cards || []);
  return cards.filter(sweepable);
}
async function slideGroup(key) {
  if (sweeping.has(key)) return;
  const picked = sweepList(key).filter((m) => !unpicked.has(m.id));
  if (!picked.length) { scheduleRender('auto'); return; }
  swept.delete(key);
  sweeping.set(key, { i: 0, n: picked.length });
  scheduleRender('auto');
  const res = await sweep(picked, (m) => press(m.id, primaryOf(m).data, null, { quiet: true }), (i, n) => { sweeping.set(key, { i, n }); scheduleRender('auto'); });
  sweeping.delete(key);
  if (res.failed.length) swept.set(key, { failed: res.failed.length });
  toast(res.failed.length ? `${res.done.length} approved. ${res.failed.length} did not go through.` : `${res.done.length === 1 ? '1 card' : `All ${res.done.length}`} approved.`);
  scheduleRender('auto');
}

// Blocks still on the page, in DOM order (ones on their way out are skipped).
const liveItems = () => [...els.msgs.children].filter((el) => (el.classList.contains('ap-item') || el.classList.contains('ap-block')) && !el.classList.contains('leaving'));

// Measure, change, then glide whatever moved from where it was (compositor transforms only).
function apprFlip(before) {
  if (!before) return;
  for (const [el, was] of before) {
    if (!el.isConnected) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.getAnimations().forEach((an) => { if (an.id === 'ap-flip') an.cancel(); });
    const an = el.animate([{ transform: `translate3d(0,${dy}px,0)` }, { transform: 'none' }], { duration: 480, easing: APPR_EASE });
    an.id = 'ap-flip';
  }
}

const measure = () => (apprPainted && !reducedMotion() ? new Map(liveItems().map((el) => [el, el.getBoundingClientRect().top])) : null);

// Fade the block out where it stands, then take it out and let the ones below glide up.
function apprLeave(el) {
  if (!apprPainted || reducedMotion()) { el.remove(); return; }
  el.classList.add('leaving');
  setTimeout(() => {
    const before = apprMode ? measure() : null;
    el.remove();
    apprFlip(before);
    if (apprMode && !apprItems.size) renderApprovals(); // the empty state, once the last card is gone
  }, 240);
}

function renderApprovals() {
  if (!apprMode) return;
  const { out: want, n } = boardBlocks();
  renderApprHeader(n);
  const box = els.msgs;
  const before = measure();
  const ids = new Set(want.map((b) => b.id));
  for (const [id, r] of apprItems) if (!ids.has(id)) { apprItems.delete(id); apprLeave(r.el); }
  for (const id of unpicked) if (!want.some((b) => b.card && b.m.id === id)) unpicked.delete(id);
  // Keyed in place, like the thread: a block is only moved when the order changed.
  const items = liveItems();
  const placed = new Set();
  let i = 0;
  let cursor = items[0] || null;
  for (const b of want) {
    let r = apprItems.get(b.id);
    const fresh = !r;
    if (b.card) {
      const m = b.m;
      const sig = apprSig(m);
      if (!r) {
        r = { el: apprItem(m), sig, media: mediaSig(m), m };
        apprItems.set(b.id, r);
      } else if (r.sig !== sig || r.m !== m) {
        // Only the card is rebuilt (pending, More, an edit); the context line stays put.
        if (r.sig !== sig) r.el.querySelector(':scope > .appr').replaceWith(approvalCard(m));
        const media = mediaSig(m);
        if (r.media !== media) {
          r.el.querySelector(':scope > .ap-media')?.remove();
          r.el.querySelector(':scope > .ap-docs')?.remove();
          const pics = apprMedia(m);
          if (pics) r.el.querySelector(':scope > .appr').before(pics);
          const docs = cardDocs(m);
          if (docs) r.el.querySelector(':scope > .appr').before(docs);
          r.media = media;
        }
        r.sig = sig;
        r.m = m;
      }
      syncPick(r.el, m, b.group);
    } else if (!r) {
      r = { el: b.make(), sig: b.sig };
      apprItems.set(b.id, r);
    } else if (r.sig !== b.sig) {
      const el = b.make();
      const old = r.el;
      old.replaceWith(el);
      r.el = el;
      r.sig = b.sig;
      const k = items.indexOf(old);
      if (k >= 0) items[k] = el;
      if (cursor === old) cursor = el;
    }
    if (fresh && apprPainted && !reducedMotion()) {
      r.el.classList.add('ap-in');
      r.el.addEventListener('animationend', () => r.el.classList.remove('ap-in'), { once: true });
    }
    if (r.el !== cursor) { if (cursor) box.insertBefore(r.el, cursor); else box.append(r.el); }
    placed.add(r.el);
    while (cursor && placed.has(cursor)) cursor = items[++i] || null;
  }
  const empty = box.querySelector(':scope > .ap-empty');
  const settling = box.querySelector(':scope > .ap-item.leaving');
  if (want.length || settling || boardKey) empty?.remove();
  else if (!empty) {
    box.append(h('div', { class: `ap-empty${apprPainted ? ' ap-fade' : ''}`, role: 'status' },
      icon('check'), h('b', {}, 'All caught up'), h('span', {}, 'Nothing is waiting on you.')));
  }
  apprFlip(before);
}

// ── image viewer ─────────────────────────────────────────────────────────

// Opens at once on the preview the chat already has, then sharpens to the original when it arrives.
function viewImage(src, alt, preview) {
  const close = () => { ov.classList.remove('show'); setTimeout(() => ov.remove(), 220); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const shown = h('img', { src: preview || src, alt: alt || 'Photo' });
  const ov = h('div', { class: 'viewer', role: 'dialog', 'aria-label': alt || 'Photo', onclick: close },
    shown,
    h('button', { class: 'viewer-x', type: 'button', 'aria-label': 'Close', html: icons.x }));
  if (preview && preview !== src) {
    const full = new Image();
    full.decoding = 'async';
    full.onload = () => { if (ov.isConnected) shown.src = src; };
    full.src = src;
  }
  document.body.append(ov);
  document.addEventListener('keydown', key);
  requestAnimationFrame(() => ov.classList.add('show'));
}
