// Home by client (optional): if team.json lists clients, home groups what is going on by client instead of by
// bot. One board from what Vesper already has: the threads (waiting cards, work cards) and, when a teamops hook
// provides one, an outbox of actions (server/teamops.mjs clientActions). For each client with anything today:
//   need    your waiting cards (message ids; the app renders them from its own threads, with the slider)
//   motion  work queued or under way, approved cards under way, sends inside their Stop window
//   done    what settled today, newest first, one line each
// Clients with nothing in motion and nothing done today are left out. No clients in team.json: an empty board.
import { CLIENTS, TZ, member, botByProfile } from './team.mjs';

const NAMES = CLIENTS.map((c) => [c.key, new RegExp(c.match, 'i')]);
const BOARD = CLIENTS.map((c) => ({ key: c.key, id: c.key, short: c.short, name: c.name, bot: c.bot }));
const MOTION = { approved: 'Working', doing: 'Working', running: 'Sending', fixing: 'Being fixed' };
const SETTLED = { done: ['Done', 'ok'], unconfirmed: ['Sent', 'ok'], failed: ['Did not finish', 'bad'], rejected: ['Declined', 'off'], cancelled: ['Withdrawn', 'off'],
  stopped: ['Stopped', 'off'], changed: ['Changed', 'off'], refused: ['Held back', 'bad'], expired: ['Expired', 'off'], returned: ['Sent back', 'off'] };
const WORK_DONE = { done: ['Finished', 'ok'], needs_you: ['Needs you', 'warn'], failed: ['Did not finish', 'bad'], stopped: ['Stopped', 'off'] };

export const keyOfName = (name) => { const s = String(name || '').trim(); return s ? NAMES.find(([, re]) => re.test(s))?.[0] || null : null; };
const keyOfAction = (a) => keyOfName(a.client_name);
// An approvals service can write "[Doing: ]**Client**: what it is (#id)".
export function keyOfCard(text) {
  const head = String(text || '').split('\n')[0].replace(/^\s*(approval needed|approve\?)\s*:?\s*/i, '');
  const x = /^\s*(?:(?:Doing|Auto reply|Learn)\s*:\s*)?\*\*([^*\n]{1,80})\*\*\s*:/.exec(head);
  if (!x) return null;
  return keyOfName(x[1]);
}
// "Acme: add 12 negatives" -> "Add 12 negatives"
const plainAsk = (ask) => { const t = String(ask || '').replace(/^[^:]{1,40}:\s*/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90); return t ? t[0].toUpperCase() + t.slice(1) : 'Task'; };
const cardTitle = (text) => plainAsk(String(text || '').split('\n')[0].replace(/^\s*(?:(?:Doing|Auto reply|Learn|Approval needed|Approve\?)\s*:\s*)?(?:\*\*[^*\n]{1,80}\*\*\s*:\s*)?/i, '').replace(/\s*\(#\d+\)\s*$/, ''));
const isStop = (m) => (m.buttons || []).flat().some((b) => /^s\|\d+\|/.test(String(b.data || '')));
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
const clock = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms);
// Midnight today in the team's time zone, in ms.
export function dayStart(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const v = (t) => Number(parts.find((x) => x.type === t)?.value || 0);
  return now - ((v('hour') * 60 + v('minute')) * 60 + v('second')) * 1000 - (now % 1000);
}

export function clientBoard({ store, teamops, now = Date.now() }) {
  const today = dayStart(now);
  const actions = teamops?.clientActions ? teamops.clientActions(today / 1000 - 600) : null;
  const byKey = new Map(BOARD.map((c) => [c.key, { ...c, need: [], motion: [], done: [] }]));
  const map = {}; // waiting card message id -> client key, for the app's own grouping
  const used = new Set(); // message ids already placed
  const actByMsg = new Map();
  for (const a of actions || []) if (a.card_message_id && (a.card_where || 'holler') === 'holler') actByMsg.set(Number(a.card_message_id), a);

  // Waiting cards: Needs you, or In motion for a send inside its Stop window.
  for (const m of store.waitingCards(now - 7 * 86400000)) {
    const a = actByMsg.get(m.id);
    const key = (a && keyOfAction(a)) || keyOfCard(m.text);
    const c = key && byKey.get(key);
    if (!c) continue;
    map[m.id] = key;
    used.add(m.id);
    if (isStop(m)) c.motion.push({ kind: 'stop', message_id: m.id, chat_id: m.chat_id, bot: m.sender, title: cardTitle(m.text), word: 'Sends soon', at: m.at });
    else c.need.push(m.id);
  }
  // Claude work cards: queued or working is In motion; finished today is Done today.
  for (const m of store.workCards(today - 3 * 86400000)) {
    const w = m.work;
    const c = byKey.get(keyOfName(w.client));
    if (!c) continue;
    used.add(m.id);
    if (w.state === 'queued' || w.state === 'working') {
      const step = (w.steps || []).find((s) => !s.done)?.text || null;
      c.motion.push({ kind: 'work', message_id: m.id, chat_id: m.chat_id, bot: m.sender, title: w.title, state: w.state, step, word: w.state === 'working' ? 'Working' : 'Waiting to start', at: w.active_at || w.started_at || m.at });
    } else if (WORK_DONE[w.state]) {
      const at = w.finished_at || m.edited_at || m.at;
      if (at >= today) c.done.push({ kind: 'work', message_id: m.id, chat_id: m.chat_id, bot: m.sender, title: w.title, word: WORK_DONE[w.state][0], tone: WORK_DONE[w.state][1], at });
    }
  }
  // The outbox: approved cards under way, and everything that settled today.
  for (const a of actions || []) {
    const c = byKey.get(keyOfAction(a));
    if (!c) continue;
    const mid = a.card_message_id && (a.card_where || 'holler') === 'holler' ? Number(a.card_message_id) : null;
    if (mid && used.has(mid)) continue;
    const bot = botByProfile(a.bot)?.id || null;
    const chat = (mid && store.messageChat(mid)) || (bot ? `dm-${bot}` : null);
    const row = { kind: 'action', action: a.id, message_id: mid, chat_id: chat, bot, title: plainAsk(a.ask), app: a.kind === 'text' ? 'sms' : a.kind === 'email' ? 'gmail' : 'task', to: a.contact_name || null };
    if (MOTION[a.status]) c.motion.push({ ...row, word: MOTION[a.status], at: Math.round((a.decided_at || a.created) * 1000) });
    else if (a.status === 'grace') c.motion.push({ ...row, kind: 'stop', word: 'Sends soon', at: Math.round(a.created * 1000) });
    else if (SETTLED[a.status] && (a.decided_at || a.created) * 1000 >= today) {
      const word = (a.kind === 'text' || a.kind === 'email') && a.status === 'done' ? 'Sent' : SETTLED[a.status][0];
      c.done.push({ ...row, word, tone: SETTLED[a.status][1], auto: !!a.auto, at: Math.round((a.decided_at || a.created) * 1000) });
    }
  }

  const clients = [];
  for (const c of byKey.values()) {
    if (!c.need.length && !c.motion.length && !c.done.length) continue;
    c.motion.sort((a, b) => (a.kind === 'work' && a.state === 'working' ? -1 : 0) - (b.kind === 'work' && b.state === 'working' ? -1 : 0) || b.at - a.at);
    c.done.sort((a, b) => b.at - a.at);
    c.done = c.done.slice(0, 20);
    clients.push({ ...c, owner: c.bot, owner_name: member(c.bot)?.name || c.bot, line: motionLine(c.motion[0]), done_line: c.done.length ? `${c.done.length} done today` : null, last: Math.max(0, ...c.motion.map((x) => x.at), ...c.done.map((x) => x.at)) });
  }
  // Clients that need you first, then what is moving, then the most recent.
  clients.sort((a, b) => b.need.length - a.need.length || b.motion.length - a.motion.length || b.last - a.last);
  return { at: now, day: dayOf(now), outbox: actions != null, clients, map };
}

// The one thing moving, in a few plain words ("Claude working on the pricing page").
function motionLine(x) {
  if (!x) return null;
  if (x.kind === 'work') return x.state === 'working' ? `Claude working on ${x.title}` : `Claude starts soon: ${x.title}`;
  if (x.kind === 'stop') return `Sends unless you tap Stop: ${x.title}`;
  if (x.word === 'Sending') return `Sending: ${x.title}`;
  if (x.word === 'Being fixed') return `Claude is fixing: ${x.title}`;
  return `${x.title} \u00b7 ${member(x.bot)?.name || 'the team'} since ${clock(x.at)}`;
}
