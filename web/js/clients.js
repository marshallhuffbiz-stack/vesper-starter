// Home by client (11-11). The owner thinks in clients; the app was sorted by bot. The server groups what is going on
// by client (GET /api/clients/home, and a 'clients' event on the live stream); the waiting cards themselves come
// from the app's own threads, so the count on a client's row, its page and the Approvals screen always agree.
// Also here, without a browser: which client a card belongs to, which cards a group slide may sweep, and the sweep.
import { state } from './store.js';
import { api } from './api.js';
import { readCard, clientOf, clientByKey } from './marks.js';
import { waitingCards } from './list.js';

let board = null; // {at, clients: [...], map: {message id: key}}
const listeners = new Set();
export const onClients = (fn) => listeners.add(fn);
export const clientBoard = () => board;
export function setBoard(d) {
  if (!d || !Array.isArray(d.clients)) return;
  board = d;
  listeners.forEach((f) => f(board));
}
let loading = null;
export function loadClients() {
  if (loading) return loading;
  // An older server answers 404: no Clients group, nothing else changes.
  loading = api('/api/clients/home', { timeout: 10000 }).then(setBoard, () => {}).finally(() => { loading = null; });
  return loading;
}

// A send with a Stop button (an auto reply, or what he told a bot to send) is In motion, not Needs you.
export const isStopCard = (m) => (m?.buttons || []).flat().some((b) => /^s\|\d+\|/.test(String(b.data || '')));

// Which client a message is about: the server's reading (it knows the outbox row behind a card), else the card's
// own "**Client**:" head, else a work card's client. Leads are one client. null when it is about no client.
export function keyOf(m) {
  if (!m) return null;
  const k = board?.map?.[m.id];
  if (k) return k;
  if (m.work) return clientOf(m.work.client)?.key || null;
  const sub = String(readCard(m).sub || '').split(' · ')[0];
  const head = /^\s*(?:(?:Doing|Auto reply|Learn)\s*:\s*)?\*\*([^*\n]{1,80})\*\*\s*:/.exec(String(m.text || '').replace(/^\s*(approval needed|approve\?)\s*:?\s*/i, ''));
  if (head) return /^lead\b/i.test(head[1].trim()) ? 'leads' : clientOf(head[1])?.key || null;
  return clientOf(sub)?.key || null;
}

// His waiting cards for one client (newest first, as Approvals), with sends in their Stop window kept apart.
export const needsFor = (key, list = waitingCards()) => list.filter((m) => keyOf(m) === key && !isStopCard(m));
export const stopsFor = (key, list = waitingCards()) => list.filter((m) => keyOf(m) === key && isStopCard(m));

// A card one group slide may sweep: an ordinary approve slider from the approvals service ("a|<id>|<hash>"),
// nothing typed into it, no link out, no Stop, not a choice list or a command Hermes wants to run.
export function sweepable(m) {
  if (!m || m.resolved || !m.buttons?.length) return false;
  const all = m.buttons.flat();
  if (all.some((b) => b.url) || isStopCard(m)) return false;
  const primary = all.find((b) => b.style === 'primary') || all[0];
  if (!primary || !/^a\|\d+\|/.test(String(primary.data || ''))) return false;
  if (/^Sealed: /m.test(String(m.text || ''))) return false;
  return true;
}
export const primaryOf = (m) => { const all = (m.buttons || []).flat().filter((b) => !b.url); return all.find((b) => b.style === 'primary') || all[0] || null; };

// The Approvals screen's groups: one per client (cards about no client last, as Other), each newest first, the
// groups in the order of their newest card.
export function groupCards(list = waitingCards()) {
  const groups = new Map();
  for (const m of list) {
    const key = keyOf(m) || '';
    if (!groups.has(key)) groups.set(key, { key, cards: [] });
    groups.get(key).cards.push(m);
  }
  const out = [...groups.values()];
  const other = out.filter((g) => !g.key);
  return [...out.filter((g) => g.key), ...other].map((g) => ({ ...g, name: nameOf(g.key) }));
}

export function nameOf(key) {
  if (!key) return 'Other';
  return board?.clients?.find((c) => c.key === key)?.name || clientByKey(key)?.name || clientByKey(key)?.short || key;
}
export const ownerOf = (key) => board?.clients?.find((c) => c.key === key)?.owner || clientByKey(key)?.bot || null;

// One group slide: each selected card's own press, in order, through the same press path a single slide uses.
// A press that fails does not stop the rest; it comes back in `failed` (the card stays up with its error).
export async function sweep(cards, pressOne, onStep = () => {}) {
  const done = [], failed = [];
  for (const [i, m] of cards.entries()) {
    onStep(i, cards.length, m);
    let ok = false;
    try { ok = await pressOne(m); } catch { ok = false; }
    (ok ? done : failed).push(m.id);
  }
  return { done, failed };
}

// The rows on home: every client the server lists, with its Needs you count from the threads, and its line.
// "2 need you · Claude working on the cheat sheet", "3 done today".
export function clientRows(list = waitingCards()) {
  if (!board?.clients?.length) return [];
  const rows = board.clients.map((c) => {
    const need = needsFor(c.key, list).length;
    const parts = [];
    if (need) parts.push(`${need} need${need === 1 ? 's' : ''} you`);
    if (c.line) parts.push(c.line);
    else if (c.done_line) parts.push(c.done_line);
    if (!parts.length) return null;
    return { key: c.key, name: c.name, short: c.short, need, line: parts.join(' · '), owner: c.owner };
  }).filter(Boolean);
  return rows.sort((a, b) => b.need - a.need);
}

// What the client page shows below Needs you.
export const clientOfBoard = (key) => board?.clients?.find((c) => c.key === key) || null;
export const hasChat = (id) => state.chats.has(id);
