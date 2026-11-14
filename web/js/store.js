// App state and a tiny event bus. Views subscribe to 'chats', 'thread', 'typing', 'presence'.
import { toMs } from './util.js';
import { setTeam } from './marks.js';

export const state = {
  me: null,
  members: new Map(),
  chats: new Map(),
  vapidPublicKey: null,
  push: { enabled: false },
  threads: new Map(),
  typing: new Map(), // chatId -> Map(memberId -> {status, timer})
  openChat: null,
  connected: true,
  later: [], // Later (11-06): his reminders and parked things, set by later.js
};

const bus = new Map();
export function on(evt, fn) {
  if (!bus.has(evt)) bus.set(evt, new Set());
  bus.get(evt).add(fn);
  return () => bus.get(evt).delete(fn);
}
export function emit(evt, arg) { for (const fn of bus.get(evt) || []) fn(arg); }

const FALLBACK = ['#8E8E93', '#636366'];
export function member(id) {
  return state.members.get(id) || { id, name: id || 'Unknown', kind: 'bot', colors: FALLBACK, initials: (id || '?')[0].toUpperCase() };
}
export const isMe = (id) => state.me && id === state.me.id;
export const firstName = (id) => String(member(id).name || '').split(/\s+/)[0];
// A bot's name with its clients, the way the team knows them: "Ben (Acme, Birch)".
export const nameWithClients = (id) => {
  const m = member(id);
  return m.kind === 'bot' && m.clients?.length ? `${m.name} (${m.clients.join(', ')})` : m.name;
};
export const colorsOf = (id) => {
  const c = member(id).colors;
  return Array.isArray(c) && c.length >= 2 ? c : FALLBACK;
};

export function thread(chatId) {
  let t = state.threads.get(chatId);
  if (!t) {
    t = { messages: [], more: false, reads: {}, readAt: {}, loaded: false, loading: false, loadingOlder: false, lastReadSent: null };
    state.threads.set(chatId, t);
  }
  return t;
}

export function applyBootstrap(b) {
  state.me = b.me;
  setTeam(b);
  // The server sends clients as "Acme, Birch, Cedar"; the app works with a list.
  const list = (c) => (Array.isArray(c) ? c : String(c || '').split(',').map((x) => x.trim()).filter(Boolean));
  state.members = new Map((b.members || []).map((m) => [m.id, { ...m, clients: list(m.clients) }]));
  state.chats = new Map((b.chats || []).map((c) => [c.id, { ...c, unread: c.unread || 0 }]));
  for (const id of state.threads.keys()) if (!state.chats.has(id)) state.threads.delete(id);
  state.vapidPublicKey = b.vapidPublicKey || null;
  state.push = b.push || { enabled: false };
  // Typing at load time.
  for (const map of state.typing.values()) for (const v of map.values()) clearTimeout(v.timer);
  state.typing = new Map();
  for (const t of b.typing || []) setTyping(t.chat_id, t.member_id, true, t.status ?? null, true);
}

// Keep a message object list sorted by time (then id) without full sorts on append.
function cmp(a, b) {
  const d = toMs(a.at) - toMs(b.at);
  if (d) return d;
  if (a.id != null && b.id != null) return Number(a.id) - Number(b.id);
  return a.id == null ? 1 : -1;
}

export function findIndex(t, m) {
  if (m.id != null) {
    for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i].id === m.id) return i;
  }
  if (m.client_id) {
    for (let i = t.messages.length - 1; i >= 0; i--) {
      const x = t.messages[i];
      if (x.client_id === m.client_id && x.sender === m.sender) return i;
    }
  }
  return -1;
}

// Insert or replace one message. Returns 'new' | 'replaced' | 'removed' | null.
export function upsert(m) {
  const t = thread(m.chat_id);
  const chat = state.chats.get(m.chat_id);
  if (m.kind === 'deleted' || m.deleted) {
    const i = findIndex(t, m);
    if (i >= 0) t.messages.splice(i, 1);
    if (chat && chat.last && chat.last.id === m.id) chat.last = t.messages.length ? t.messages[t.messages.length - 1] : null;
    return i >= 0 ? 'removed' : null;
  }
  let result = null;
  if (t.loaded) {
    const i = findIndex(t, m);
    if (i >= 0) { t.messages[i] = m; result = 'replaced'; }
    else {
      const arr = t.messages;
      let j = arr.length;
      while (j > 0 && cmp(arr[j - 1], m) > 0) j--;
      arr.splice(j, 0, m);
      result = 'new';
    }
  }
  if (chat && m.id != null && (!chat.last || chat.last.id === m.id || cmp(chat.last, m) <= 0)) chat.last = m;
  return result;
}

export function setTyping(chatId, memberId, on, status = null, silent = false) {
  if (!chatId || !memberId) return;
  let map = state.typing.get(chatId);
  if (!map) { map = new Map(); state.typing.set(chatId, map); }
  const prev = map.get(memberId);
  if (prev) clearTimeout(prev.timer);
  if (on) {
    // Clear on our own after 8 s without a refresh, in case the "off" never arrives.
    const timer = setTimeout(() => setTyping(chatId, memberId, false), 8000);
    map.set(memberId, { status: status || null, timer });
  } else {
    map.delete(memberId);
  }
  if (!silent) emit('typing', chatId);
}

export function typers(chatId) {
  const map = state.typing.get(chatId);
  if (!map) return [];
  return [...map.entries()].filter(([id]) => !isMe(id)).map(([id, v]) => ({ id, status: v.status }));
}

export function totalUnread(except) {
  let n = 0;
  for (const c of state.chats.values()) if (c.id !== except) n += c.unread || 0;
  return n;
}
