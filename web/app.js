// Holler web app entry: bootstrap, routing, live events, presence, push.
import { $, h, isWide } from './js/util.js';
import { state, on, applyBootstrap, setTyping, isMe, totalUnread } from './js/store.js';
import { api, post, connectEvents, CLIENT_ID } from './js/api.js';
import { initList, renderList, setConnected } from './js/list.js';
import {
  initThread, showThread, hideThread, clearThreadPane, renderHeader, onLiveMessage, onLiveUpdate,
  onTypingChange, onRead, onPresence, send, messageForKey, react, refetch, maybeMarkRead, prefetch, focusOn,
  showApprovals, approvalsOpen, scheduleRender as refreshApprovals, freshen, showClient, clientOpen,
} from './js/thread.js';
import { setBoard, loadClients } from './js/clients.js';
import { loadSystem } from './js/system.js';
import { initComposer, setComposerChat, setReply, focusComposer, closeMenu } from './js/composer.js';
import { initDetails, openDetails, closeDetails, detailsOpen } from './js/details.js';
import { initBubbleGestures, initEdgeSwipe } from './js/gestures.js';
import { registerServiceWorker, renderPushBanner } from './js/push.js';
import { refreshPresence, refreshMoods, preloadMoods } from './js/avatar.js';
import { initRuns, showRuns, hideRuns, runsOpen, loadRuns } from './js/runs.js';
import { initDocs, showDocs, hideDocs, docsOpen, loadDocs, docsChanged, viewerOpen, closeViewer } from './js/docs.js';
import { trackViewport } from './js/viewport.js';
import { setLater, onLater, openRemindSheet } from './js/later.js';
import { readCard, readTask } from './js/marks.js';
import { previewText } from './js/md.js';

let events = null;
let cameFromList = false;
let signedOut = false;

// Drag down on the messages to put the keyboard away, like Messages (no Done button needed).
function initKeyboardDismiss(scroller) {
  let start = null;
  scroller.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = document.documentElement.classList.contains('kb-open') && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!start) return;
    const t = e.touches[0];
    const dy = t.clientY - start.y;
    if (dy < -10 || Math.abs(t.clientX - start.x) > Math.abs(dy)) { start = null; return; }
    if (dy > 26) { start = null; document.activeElement?.blur?.(); }
  }, { passive: true });
  scroller.addEventListener('touchend', () => { start = null; }, { passive: true });
}

// ── routing ───────────────────────────────────────────────────────────────
function parseRoute() {
  const m = /^#\/chat\/([^?]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}
// #/chat/<id>?m=<message>: a notification that had to start the app fresh names the message it was about.
const routeMessage = () => { const m = /^#\/chat\/[^?]+\?m=(\d+)$/.exec(location.hash); return m ? Number(m[1]) : null; };
// #/approvals: every waiting card from every bot, in the thread pane.
const approvalsRoute = () => location.hash === '#/approvals';
// #/runs: every bot's routines, its own screen over the panes.
const runsRoute = () => location.hash === '#/runs';
// #/files: Deliverables, every file the bots handed him, its own screen like Runs.
const docsRoute = () => location.hash === '#/files';
// #/client/<key>: one client's page (11-11), in the thread pane like Approvals.
const clientRoute = () => { const m = /^#\/client\/([\w-]{1,24})$/.exec(location.hash); return m ? m[1] : null; };

// The sliding thread gets display-matched rounded corners only while it moves.
let navTimer = 0;
function markMoving(open) {
  if (isWide() || document.body.classList.contains('thread-open') === open) return;
  document.body.classList.add('nav-moving');
  clearTimeout(navTimer);
  navTimer = setTimeout(() => document.body.classList.remove('nav-moving'), 520);
}

function route() {
  if (!state.me) return;
  const id = parseRoute();
  const appr = !id && approvalsRoute();
  const client = !id && !appr ? clientRoute() : null;
  if (!id && runsRoute()) {
    if (detailsOpen()) closeDetails(true);
    hideDocs();
    showRuns();
    renderList();
    return;
  }
  hideRuns();
  if (!id && docsRoute()) {
    if (detailsOpen()) closeDetails(true);
    showDocs();
    renderList();
    return;
  }
  hideDocs();
  if (detailsOpen() && id !== state.openChat) closeDetails(true);
  if (id !== state.openChat) closeMenu(true);
  if (!document.body.classList.contains('edge-dragging')) markMoving(appr || !!client || !!(id && state.chats.has(id)));
  if (appr) {
    state.openChat = null;
    document.body.classList.add('thread-open');
    showApprovals();
  } else if (client) {
    state.openChat = null;
    document.body.classList.add('thread-open');
    showClient(client);
  } else if (id && state.chats.has(id)) {
    const fromPush = routeMessage();
    if (fromPush != null) { history.replaceState(null, '', `#/chat/${encodeURIComponent(id)}`); focusOn(fromPush); }
    state.openChat = id;
    document.body.classList.add('thread-open');
    setComposerChat(id);
    showThread(id);
  } else {
    // #/later: a reminder's notification lands on home, scrolled to the top where it sits in Needs you.
    const fromReminder = location.hash === '#/later';
    if (id || fromReminder) history.replaceState(null, '', '#/');
    if (fromReminder) $('#list-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    state.openChat = null;
    cameFromList = false;
    document.body.classList.remove('thread-open');
    hideThread();
    if (isWide()) clearThreadPane();
  }
  renderList();
  sendPresence();
  updateBadge();
}

// On a touch screen the route is replaced, never pushed. iOS gives Home Screen web apps its own
// left-edge swipe back whenever there is history, and it cannot be turned off: it slides a stale
// snapshot of the list, then the page replays its own close on top (the "reload" flash). With no
// history entry there is nothing for iOS to swipe to, so only the app's edge swipe runs.
const PUSH_HISTORY = !matchMedia('(pointer: coarse)').matches;

function openApprovals() {
  if (approvalsOpen()) return;
  cameFromList = !isWide() || cameFromList || !parseRoute();
  history[PUSH_HISTORY ? 'pushState' : 'replaceState'](null, '', '#/approvals');
  route();
}

function openClient(key) {
  if (clientOpen() === key) return;
  cameFromList = !isWide() || cameFromList || !parseRoute();
  history[PUSH_HISTORY ? 'pushState' : 'replaceState'](null, '', `#/client/${encodeURIComponent(key)}`);
  route();
}

function openRuns() {
  if (runsOpen()) return;
  cameFromList = !isWide() || cameFromList || !parseRoute();
  history[PUSH_HISTORY ? 'pushState' : 'replaceState'](null, '', '#/runs');
  route();
}

function openDocs() {
  if (docsOpen()) return;
  cameFromList = !isWide() || cameFromList || !parseRoute();
  history[PUSH_HISTORY ? 'pushState' : 'replaceState'](null, '', '#/files');
  route();
}

function openChat(id) {
  if (state.openChat === id && !docsOpen()) return;
  cameFromList = !isWide() || cameFromList || !parseRoute();
  // Set the route and render on this same frame instead of waiting for hashchange.
  history[PUSH_HISTORY ? 'pushState' : 'replaceState'](null, '', `#/chat/${encodeURIComponent(id)}`);
  route();
}

// A notification tap while the app was in the background: open its chat, fetch it fresh at once (never wait for
// the live connection to come back) and land on the message it was about.
function openFromNotification(chatId, messageId = null) {
  if (!state.chats.has(chatId)) return;
  openChat(chatId);
  freshen(chatId, { focus: messageId });
}

function goBack() {
  if (!document.body.classList.contains('edge-dragging')) markMoving(false);
  document.body.classList.remove('thread-open');
  if (PUSH_HISTORY && cameFromList && history.length > 1) { history.back(); return; }
  history.replaceState(null, '', '#/');
  route();
}

// ── presence and badge ────────────────────────────────────────────────────
function sendPresence() {
  if (!state.me || signedOut) return;
  const body = { visible: document.visibilityState === 'visible', chat_id: state.openChat, client_id: CLIENT_ID, build: SHELL_BUILD };
  // Going hidden is often the page unloading: a beacon survives that, a fetch gets cancelled
  // (and WebKit reports the cancelled fetch as an error).
  if (!body.visible && navigator.sendBeacon?.('/api/presence', new Blob([JSON.stringify(body)], { type: 'application/json' }))) return;
  post('/api/presence', body).catch(() => {});
}

function updateBadge() {
  const n = totalUnread(null);
  try {
    if (n && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
    else if (!n && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch { /* not supported */ }
  document.title = n ? `Vesper (${n})` : 'Vesper';
}

function chatsChanged() {
  renderList();
  if (state.openChat || approvalsOpen() || clientOpen()) renderHeader();
  if (approvalsOpen() || clientOpen()) refreshApprovals();
  updateBadge();
}

// ── live events ───────────────────────────────────────────────────────────
function onEvent(name, d) {
  switch (name) {
    case 'message': {
      const m = d.message;
      if (!m) return;
      if (!isMe(m.sender)) setTyping(m.chat_id, m.sender, false, null, true);
      const isNew = onLiveMessage(m);
      const chat = state.chats.get(m.chat_id);
      const looking = state.openChat === m.chat_id && document.visibilityState === 'visible';
      if (chat && isNew && !isMe(m.sender) && !looking) chat.unread = (chat.unread || 0) + 1;
      onTypingChange(m.chat_id);
      chatsChanged();
      maybeMarkRead();
      if (!isMe(m.sender)) docsChanged(m);
      break;
    }
    case 'update':
      if (d.message) { onLiveUpdate(d.message); chatsChanged(); docsChanged(d.message); }
      break;
    case 'files':
      docsChanged();
      break;
    // 11-11: the client board, a moment after anything in the threads changed; and a bot error kept as a system note.
    case 'clients':
      setBoard(d);
      chatsChanged();
      break;
    case 'system':
      loadSystem();
      break;
    case 'typing':
      setTyping(d.chat_id, d.member_id, !!d.on, d.status ?? null);
      break;
    case 'read':
      if (isMe(d.member_id)) {
        const chat = state.chats.get(d.chat_id);
        if (chat && chat.unread) { chat.unread = 0; chatsChanged(); } // read on another device
      } else onRead(d);
      break;
    case 'later':
      setLater(d.items);
      break;
    case 'presence': {
      const m = state.members.get(d.member_id);
      if (m) { m.online = !!d.online; refreshPresence(d.member_id); onPresence(d.member_id); }
      break;
    }
    default:
  }
}

async function resync() {
  try {
    const b = await api('/api/bootstrap');
    const open = state.openChat;
    applyBootstrap(b);
    setLater(b.later);
    loadRuns();
    loadDocs();
    loadClients();
    // Every thread may have missed messages. Refresh each in place (refetch replaces a thread
    // whose newest page no longer overlaps, so gaps never stay) instead of dropping it: the
    // Waiting card and the Approvals view count cards in every loaded thread, and a dropped
    // thread would make its cards vanish and come back.
    if (open && state.chats.has(open)) await refetch(open);
    await Promise.all([...state.chats.keys()].filter((id) => id !== open)
      .map((id) => (state.threads.get(id)?.loaded ? refetch(id) : prefetch(id)).catch(() => {})));
    chatsChanged();
    onTypingChange(open);
  } catch { /* stays as is; the next reconnect tries again */ }
}

// ── screens ───────────────────────────────────────────────────────────────
function showSignIn() {
  signedOut = true;
  events?.stop();
  events = null;
  document.body.classList.remove('booting', 'thread-open');
  document.body.classList.add('signed-out');
  const input = h('input', {
    class: 'gate-input', type: 'text', placeholder: 'Paste your sign-in code', autocomplete: 'one-time-code',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Sign-in code',
  });
  const err = h('div', { class: 'gate-err', role: 'alert' });
  const btn = h('button', { class: 'gate-submit', type: 'submit', disabled: true }, 'Sign In');
  input.addEventListener('input', () => { btn.disabled = !input.value.trim(); err.textContent = ''; });
  const form = h('form', { class: 'gate-form', novalidate: true }, input, btn, err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    btn.disabled = true;
    btn.textContent = 'Signing In…';
    err.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
      });
      if (res.ok) {
        signedOut = false;
        document.body.classList.add('booting');
        await boot();
        return;
      }
      let msg = 'That code didn\u2019t work. Try again.';
      try { const d = await res.json(); if (d?.error) msg = d.error; } catch { /* keep default */ }
      if (res.status === 403 && !msg) msg = 'That code has expired or was already used.';
      err.textContent = msg;
    } catch {
      err.textContent = 'Can\u2019t reach Vesper right now. Try again.';
    }
    btn.textContent = 'Sign In';
    btn.disabled = !input.value.trim();
  });
  $('#gate').replaceChildren(
    h('img', { class: 'gate-icon', src: 'icons/icon.svg', alt: '' }),
    h('h1', {}, 'Vesper'),
    h('p', {}, 'Open the sign-in link from the Mac, or paste its code here.'),
    form);
}

function showOffline(retry) {
  document.body.classList.remove('booting');
  document.body.classList.add('signed-out');
  $('#gate').replaceChildren(
    h('img', { class: 'gate-icon', src: 'icons/icon.svg', alt: '' }),
    h('h1', {}, 'Vesper'),
    h('p', {}, 'Can’t reach Vesper right now. It will keep trying.'),
    h('button', { class: 'gate-btn', type: 'button', onclick: retry }, 'Try Again'));
}

// ── boot ──────────────────────────────────────────────────────────────────
// The page was started from an older cached shell than the server runs (a Home Screen app opens
// from its saved copy): fetch the new release and reload once, still behind the launch screen.
const SHELL_BUILD = document.querySelector('meta[name="holler-build"]')?.content || '';
async function staleShell(build) {
  if (!build || !SHELL_BUILD || SHELL_BUILD.startsWith('__') || build === SHELL_BUILD) return false;
  try { if (sessionStorage.getItem('holler-reloaded-for') === build) return false; sessionStorage.setItem('holler-reloaded-for', build); } catch { return false; }
  const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
  if (reg) {
    const changed = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    await Promise.race([reg.update().then(() => (reg.installing || reg.waiting ? changed : null)).catch(() => null), new Promise((r) => setTimeout(r, 5000))]);
  }
  location.reload();
  return true;
}

async function boot(attempt = 0) {
  let b;
  try {
    b = await api('/api/bootstrap');
  } catch (e) {
    if (e.status === 401) return; // the unauthorized handler shows the sign-in screen
    const again = () => boot(attempt + 1);
    showOffline(again);
    setTimeout(() => { if (!state.me) again(); }, Math.min(30000, 2000 * 2 ** attempt));
    return;
  }
  if (await staleShell(b.build)) return;
  applyBootstrap(b);
  setLater(b.later);
  loadDocs();
  preloadMoods();
  // Warm every thread right away so opening one never shows a spinner, and give the warm-up a
  // short head start so the Waiting card is in place on the first paint instead of pushing the
  // list down a moment later.
  const warm = Promise.all([...state.chats.keys()].map((id) => prefetch(id).catch(() => {})));
  await Promise.race([warm, new Promise((r) => setTimeout(r, 350))]);
  document.body.classList.remove('booting', 'signed-out');
  renderList();
  route();
  requestAnimationFrame(() => document.body.classList.add('ready'));
  events = connectEvents({
    onEvent,
    onStatus: (ok) => { state.connected = ok; clearTimeout(boot.connTimer); if (ok) setConnected(true); else boot.connTimer = setTimeout(() => setConnected(state.connected), 4000); },
    onResync: resync,
  });
  registerServiceWorker(openFromNotification).then(() => renderPushBanner($('#push-banner')));
}

// The words a parked message starts with: a card's plain title, a task's title, else its first line.
function remindText(m) {
  if (m.buttons?.length && !m.resolved) return readCard(m).title || '';
  const task = !isMe(m.sender) ? readTask(m) : null;
  if (task?.title) return task.title;
  const first = previewText(m.text || '').split(/(?<=[.!?])\s/)[0] || '';
  return first.length > 140 ? `${first.slice(0, 139).trimEnd()}\u2026` : first;
}

function init() {
  trackViewport();
  initKeyboardDismiss($('#scroller'));
  window.addEventListener('holler:unauthorized', showSignIn);
  const openAt = (chatId, msgId) => { focusOn(msgId); openChat(chatId); };
  initList({ open: openChat, openApprovals, openRuns, openDocs, openAt, openClient });
  initRuns({ back: goBack });
  initDocs({ back: goBack, openAt });
  initThread({ goBack, onChatChange: chatsChanged, openAt, reply: (m) => setReply(m), openClient });
  initComposer({ send });
  initDetails({ openChat, focusOn, openRuns });
  $('#head-name').addEventListener('click', () => { if (state.openChat) { closeMenu(true); openDetails(state.openChat); } });
  $('#info-btn').addEventListener('click', () => { if (state.openChat) { closeMenu(true); openDetails(state.openChat); } });
  initBubbleGestures($('#msgs'), {
    lookup: messageForKey,
    onReply: (m) => setReply(m),
    onReact: (m, emoji) => react(m, emoji),
    onRemind: (m) => openRemindSheet({ text: remindText(m), chatId: m.chat_id, messageId: m.id }),
  });
  onLater(() => renderList());
  initEdgeSwipe($('#thread-pane'), $('#list-pane'), { onBack: goBack });
  on('typing', (chatId) => { onTypingChange(chatId); renderList(); });
  // The friends fall asleep at 9 PM and wake at 8 AM even when nothing else changes.
  setInterval(refreshMoods, 60000);
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  // iOS Safari only applies :active styles when a touch listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });
  // Back in the app after a few seconds away: the open chat is fetched again right away (11-06).
  let awayAt = 0;
  document.addEventListener('visibilitychange', () => {
    sendPresence();
    if (document.visibilityState === 'hidden') { awayAt = Date.now(); return; }
    maybeMarkRead();
    if (awayAt && Date.now() - awayAt > 5000 && state.openChat) freshen(state.openChat);
    awayAt = 0;
  });
  window.addEventListener('pagehide', () => {
    if (!state.me || signedOut) return;
    const body = JSON.stringify({ visible: false, chat_id: null, client_id: CLIENT_ID });
    navigator.sendBeacon?.('/api/presence', new Blob([body], { type: 'application/json' }));
  });
  matchMedia('(min-width: 900px)').addEventListener('change', () => { if (!state.openChat) clearThreadPane(); });
  document.addEventListener('keydown', (e) => {
    // On a Mac: Command-K (or Control-K) puts the cursor in search from anywhere.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); const s = $('#search-input'); s?.focus(); s?.select?.(); return; }
    if (e.key === 'Escape' && viewerOpen()) { closeViewer(); return; }
    if (e.key === 'Escape' && (runsOpen() || docsOpen())) goBack();
    else if (e.key === 'Escape' && (state.openChat || approvalsOpen() || clientOpen()) && !document.querySelector('.lp, .viewer, .pm') && !isWide()) goBack();
    else if (e.key === 'Escape') closeMenu();
  });
  // A tap on the composer area focuses the field (bigger target on phones).
  $('#composer').addEventListener('click', (e) => { if (e.target.id === 'composer') focusComposer(); });
  boot();
}

init();
