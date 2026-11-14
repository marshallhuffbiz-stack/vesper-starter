// HTTP layer: the web app's API and live stream, the bot API and event streams, static files, and
// push fan-out. createApp() returns a request handler so tests can mount it on a random port.

import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HUMAN, MEMBERS, BOTS, member, TZ, QUIET_HOURS, TEAM_VIEW, DEFAULT_RESPONDER } from './team.mjs';
import { HttpError, sha256, WORK_RINGS } from './store.mjs';
import { sendPush } from './push.mjs';
import { createHermes } from './hermes.mjs';
import { createUnfurl, publicPreview } from './unfurl.mjs';
import { createTeamOps } from './teamops.mjs';
import { createMedia, imageSize } from './media.mjs';
import { createDocs, typeFromName } from './docs.mjs';
import { clientBoard, dayStart } from './clienthome.mjs';

const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;
const TYPING_TTL_MS = 8000;
const PRESENCE_TTL_MS = 2 * 60 * 1000;
// A card still waiting after this long gets one reminder push.
const REMIND_AFTER_MS = 2 * 60 * 60 * 1000;
const REMIND_GAP_MS = 2 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 15000;
const COOKIE = 'vesper_sid';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const INLINE_FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'application/pdf']);
// Types kept as they are; anything else is stored as plain bytes and only ever downloads (never shown inline).
const SAFE_FILE_TYPES = new Set([...INLINE_FILE_TYPES, 'text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/rtf', 'application/json', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/ogg',
  'video/mp4', 'video/quicktime', 'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/msword', 'application/vnd.ms-excel']);
const IMAGE_FILE_TYPES = new Set([...INLINE_FILE_TYPES].filter((t) => t.startsWith('image/')));
const MAX_SERVICE_FILES = 10;
// A document shown inside the app's viewer frame: no scripts, its own origin, but its own styles, pictures and fonts.
const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data: blob: https:; font-src data: https://fonts.gstatic.com; media-src data: blob:; sandbox";

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(data);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'bad json'); }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Quiet hours for reminders (team.json quietHours, default 9 PM to 8 AM in the team's time zone).
export function quietHour(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const [from, to] = QUIET_HOURS;
  return from > to ? h >= from || h < to : h >= from && h < to;
}

// What a card is about in one line for a notification: its headline without markup, the "(#id)" or "Approval
// needed:", plus the "Text to Pat" line when there is one.
export function cardLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const first = plain(String(lines[0] || '').replace(/\s*\(#\d+\)\s*$/, ''));
  const head = first.replace(/^(approval needed|approve\?)\s*:?\s*/i, '') || first;
  const to = lines.slice(1).find((l) => /^(Text|Email) to /.test(l));
  const who = to ? plain(to).replace(/\s*\(ends \d+\)/, '').replace(/:.*$/, '') : '';
  return { head, to: who };
}

// "for today 2:30 PM", "for Wed 2:30 PM": the meeting or deadline a document is for, in the team's time zone.
export function forWords(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return null;
  const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(t);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms);
  const d = day(ms) === day(now) ? 'today' : day(ms) === day(now + 86400000) ? 'tomorrow'
    : new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', ...(Math.abs(ms - now) > 6 * 86400000 ? { month: 'short', day: 'numeric' } : {}) }).format(ms);
  return `for ${d} ${time}`;
}

function plain(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, '[code]').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

export function createApp({ store, config, filesDir, staticDir, log = () => {}, pushImpl = sendPush, hermes = createHermes(), unfurl = createUnfurl({ dir: filesDir ? join(filesDir, '..') : null }), teamops = createTeamOps(), remindEvery = 0, laterEvery = 0, sweepEvery = 0, media = null, system = null, docs = null }) {
  media ||= filesDir ? createMedia({ filesDir, previewDir: join(filesDir, '..', 'previews'), log }) : null;
  docs ||= filesDir ? createDocs({ filesDir, previewDir: join(filesDir, '..', 'previews'), log }) : null;
  const humans = new Set(); // SSE responses of the web app
  const bots = new Map(BOTS.map((b) => [b.id, new Set()])); // bot id -> Set of {res, last}
  const typing = new Map(); // `${chat}:${member}` -> timeout
  const views = new Map(); // web client id -> {visible, chat_id, at}
  const svcWaiters = new Map(); // svc:<id> -> Set of wake functions for long polls
  const offlineTimers = new Map();
  const started = Date.now();
  // When each bot's connection last came up or went down (kept across restarts), for the System sheet.
  const linkSince = new Map(Object.entries(store.metaGet('bot_links', {}) || {}));
  function markLink(botId, up) {
    const prev = linkSince.get(botId);
    if (prev && prev.up === up) return;
    linkSince.set(botId, { up, at: Date.now() });
    store.metaSet('bot_links', Object.fromEntries(linkSince));
  }
  // A fresh start: nobody is connected yet, whatever the last run remembered.
  for (const b of BOTS) if (linkSince.get(b.id)?.up) linkSince.set(b.id, { up: false, at: started });
  // Release id: the release folder name (a git sha) when deployed, else the start time.
  const BUILD = (/^[0-9a-f]{7,40}$/.test(basename(resolve(staticDir, '..'))) ? basename(resolve(staticDir, '..')) : String(started)).slice(0, 40);

  // ── live fan-out ────────────────────────────────────────────────────────────

  function sse(res, event, data, id) {
    try { res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; }
    catch { return false; }
  }
  const toHumans = (event, data) => { for (const res of humans) sse(res, event, data); };

  function online(botId) { return (bots.get(botId)?.size || 0) > 0; }

  // Typing carries the bot's live working phrase ("Reading the CRM") when Hermes has one.
  function setTyping(chatId, memberId, on, status = null) {
    const key = `${chatId}:${memberId}`;
    const prev = typing.get(key);
    clearTimeout(prev?.timer);
    status = status ? String(status).slice(0, 120) : null;
    if (on) {
      const timer = setTimeout(() => { typing.delete(key); toHumans('typing', { chat_id: chatId, member_id: memberId, on: false, status: null }); }, TYPING_TTL_MS);
      typing.set(key, { timer, status });
    } else if (!prev) return;
    else typing.delete(key);
    toHumans('typing', { chat_id: chatId, member_id: memberId, on: !!on, status: on ? status : null });
  }

  function drainBot(conn) {
    const events = store.botEventsAfter(conn.bot, conn.last);
    for (const e of events) {
      if (!sse(conn.res, e.kind, e.payload, e.id)) return;
      conn.last = e.id;
    }
    if (events.length) store.setBotCursor(conn.bot, conn.last);
    if (events.length === 200) setImmediate(() => drainBot(conn));
  }

  function watching(chatId) {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const v of views.values()) if (v.visible && v.chat_id === chatId && v.at >= cutoff) return true;
    return false;
  }

  // Every push goes through here and leaves one log line, so "did my phone get told?" has an answer.
  async function pushAll(data, what) {
    const subs = store.pushSubs();
    if (!subs.length) { log(`push skipped (${what}): no phone subscribed`); return 0; }
    const vapid = { ...config.vapid, subject: config.pushSubject };
    let sent = 0;
    await Promise.all(subs.map(async (sub) => {
      const r = await pushImpl(sub, data, vapid);
      if (r.ok) { sent++; store.pushOk(sub.endpoint); }
      else if (r.gone || sub.fails >= 20) { store.removePushSub(sub.endpoint); log(`push gone (${what}): ${r.status}, subscription removed`); }
      else { store.pushFailed(sub.endpoint); log('push failed', what, r.status, r.error || ''); }
    }));
    if (sent) log(`push ok (${what}) to ${sent}`);
    return sent;
  }

  const waitingCard = (m) => m.kind === 'card' && !m.resolved && (m.buttons || []).flat().some((b) => !b.url);

  async function notify(message) {
    if (!config.vapid) return;
    const chat = store.chat(message.chat_id);
    const card = waitingCard(message);
    if (watching(message.chat_id)) { if (card) log(`push skipped (card ${message.id}): ${chat.id} open on screen`); return; }
    const who = member(message.sender)?.name || 'Vesper';
    const clients = member(message.sender)?.clients;
    const badge = store.unreadTotal(HUMAN);
    let data;
    if (card) {
      // A card gets its own notification (its own tag), never folded into the chat's last one, so iOS shows
      // and sounds every card even when the bot's message about it arrived a second earlier.
      const c = cardLine(message.text);
      data = { title: `${who} needs you`, body: [c.head, c.to].filter(Boolean).join('\n').slice(0, 180), chat_id: chat.id,
        url: `/#/chat/${chat.id}`, message_id: message.id, tag: `card-${message.id}`, badge };
    } else {
      // A handed-over document says what it is and how many files, never "Sent an attachment".
      const n = message.attachments?.length || 0;
      const handed = message.doc ? [message.doc.title, [message.doc.kind, n > 1 ? `${n} files` : null, forWords(message.doc.for_at)].filter(Boolean).join(' \u00b7 ')].filter(Boolean).join('\n') : '';
      const text = handed || plain(message.text) || (n ? (n === 1 ? message.attachments[0].name : `${n} files`) : '');
      const body = (chat.kind === 'room' ? `${who}: ${text}` : text).slice(0, 180);
      data = { title: chat.kind === 'room' ? chat.title : (clients ? `${who} (${clients})` : who), body, chat_id: chat.id, url: `/#/chat/${chat.id}`, message_id: message.id, badge };
    }
    // Its pictures' previews ride along, so the phone has them before he opens the chat (sw.js).
    // A document's first pages too, so a meeting prep is on the phone before he opens it.
    const pics = (message.attachments || []).filter((a) => a.preview).slice(0, 4).map((a) => a.preview);
    const pages = (message.attachments || []).filter((a) => a.view === 'pdf').slice(0, 3)
      .flatMap((a) => [a.thumb, ...Array.from({ length: Math.min(a.pages || 1, 4) }, (_, i) => `${a.url}/pg/${i + 1}`)]);
    if (pics.length || pages.length) data.images = [...pics, ...pages].slice(0, 16);
    await pushAll(data, card ? `card ${message.id}` : `message ${message.id}`);
  }

  // A work card that reached done, needs_you or failed (11-11): one push, its own tag per job, so a second round
  // replaces the first on his lock screen. Progress never rings.
  async function notifyWork(message) {
    const w = message.work;
    if (!config.vapid || !w || !WORK_RINGS.has(w.state)) return;
    if (watching(message.chat_id)) { log(`push skipped (work ${message.id}): ${message.chat_id} open on screen`); return; }
    // Nothing buzzes him 9 PM to 8 AM: a job that finishes overnight waits on its card and under Needs you.
    if (quietHour(new Date(store.now()))) { log(`push skipped (work ${message.id}): quiet hours`); return; }
    const body = [w.title, plain(w.result || w.note || '').slice(0, 140)].filter(Boolean).join('\n');
    await pushAll({ title: w.state === 'done' ? 'Claude finished' : 'Claude needs you', body: body.slice(0, 200), chat_id: message.chat_id,
      url: `/#/chat/${message.chat_id}`, message_id: message.id, tag: `work-${w.job}`, badge: store.unreadTotal(HUMAN) }, `work ${message.id} ${w.state}`);
  }

  // One reminder for cards that have waited two hours unanswered (outside quiet hours, at most every two hours),
  // each card reminded once. Opens the Approvals screen.
  async function remindWaiting(now = Date.now()) {
    if (!config.vapid || quietHour(new Date(now))) return null;
    const last = Number(store.metaGet('remind_last', 0)) || 0;
    if (now - last < REMIND_GAP_MS) return null;
    const done = new Set(store.metaGet('remind_ids', []) || []);
    const waiting = store.waitingCards(now - 2 * 86400000);
    const due = waiting.filter((m) => now - m.at >= REMIND_AFTER_MS && !done.has(m.id));
    if (!due.length) return null;
    const heads = due.map((m) => `${member(m.sender)?.name || 'Vesper'}: ${cardLine(m.text).head}`);
    const data = {
      title: waiting.length === 1 ? 'A card is waiting on you' : `${waiting.length} cards are waiting on you`,
      body: heads.slice(0, 3).join('\n').slice(0, 220) + (heads.length > 3 ? `\nand ${heads.length - 3} more` : ''),
      url: '/#/approvals', route: '#/approvals', tag: 'waiting', badge: store.unreadTotal(HUMAN),
    };
    store.metaSet('remind_last', now);
    const still = new Set(waiting.map((m) => m.id));
    store.metaSet('remind_ids', [...new Set([...[...done].filter((id) => still.has(id)), ...due.map((m) => m.id)])].slice(-200));
    await pushAll(data, `reminder for ${due.map((m) => m.id).join(',')}`);
    return data;
  }
  const reminder = remindEvery ? setInterval(() => { remindWaiting().catch((e) => log('reminder error', e)); }, remindEvery) : null;
  reminder?.unref?.();

  // Later (11-06): a reminder he asked for rings once when it comes due, at the time he asked for (no quiet
  // hours: he picked the time). Opening it lands on home, where the item sits at the top of Needs you.
  async function ringLater(now = Date.now()) {
    const due = store.laterToRing(now);
    for (const it of due) {
      store.laterRang(it.id);
      const who = it.by && member(it.by)?.kind === 'bot' ? member(it.by).name : null;
      const body = [it.text, [it.client, who ? `from ${who}` : null].filter(Boolean).join(' \u00b7 ')].filter(Boolean).join('\n');
      if (config.vapid) await pushAll({ title: 'Reminder', body: body.slice(0, 200), url: '/#/later', route: '#/later', tag: `later-${it.id}`, badge: store.unreadTotal(HUMAN) }, `later ${it.id}`);
    }
    if (due.length) toHumans('later', { items: store.laterList() });
    return due;
  }
  const laterTimer = laterEvery ? setInterval(() => { ringLater().catch((e) => log('later error', e)); }, laterEvery) : null;
  laterTimer?.unref?.();

  // Delivery watch (11-09): a message a connected bot shows no sign of is queued for it once more; one that still
  // has no taker after five minutes is marked on the message, and his phone is told once if he has left the chat.
  const isTyping = (chatId, botId) => typing.has(`${chatId}:${botId}`);
  async function sweepDeliveries(now = Date.now()) {
    const out = store.sweepDeliveries(online, isTyping, now);
    for (const r of out.redelivered) log(`delivery: message ${r.message_id} queued again for ${r.bot} (no sign of it after 90 s)`);
    for (const s of out.stalled) {
      const who = member(s.bot)?.name || s.bot;
      log(`delivery: message ${s.message.id} stalled for ${s.bot} (${s.claude ? 'reply to Claude not taken' : s.quit ? 'picked up, then silent' : online(s.bot) ? 'connected, no sign of it' : 'offline'})`);
      if (!config.vapid || watching(s.message.chat_id)) continue;
      const why = s.claude ? 'Your reply has not reached Claude' : s.quit ? `${who} stopped without answering` : online(s.bot) ? `${who} has not picked up your message` : `${who} is offline and has not seen your message`;
      await pushAll({ title: why, body: `"${plain(s.message.text).slice(0, 120)}"\nOpen the chat to send it again.`, chat_id: s.message.chat_id,
        url: `/#/chat/${s.message.chat_id}`, message_id: s.message.id, tag: `stalled-${s.message.id}`, badge: store.unreadTotal(HUMAN) }, `stalled ${s.message.id}`);
    }
    return out;
  }
  const sweepTimer = sweepEvery ? setInterval(() => { sweepDeliveries().catch((e) => log('delivery sweep error', e)); }, sweepEvery) : null;
  sweepTimer?.unref?.();

  // A new conversation for every bot each morning (11-09). A chat that never ends is re-read in full with every
  // message (one bot read 376,000 tokens to answer "OK"), and old instructions crowd out new ones. Between 4 and 10 AM
  // local time, once a day, each bot whose thread is quiet gets the gateway's own /new, silently. Its memory, rules
  // and routines are untouched, and the owner's next message carries the tail of the thread (store.turnContext).
  // config.dmFreshHour: the hour (default 4); null turns it off.
  const FRESH_WINDOW_H = 6;
  const FRESH_QUIET_MS = 45 * 60 * 1000;
  function freshen(now = Date.now()) {
    const hour = config.dmFreshHour === undefined ? 4 : config.dmFreshHour;
    if (hour == null || !Number.isInteger(hour)) return [];
    const et = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const part = (t) => et.find((x) => x.type === t)?.value;
    const h = Number(part('hour'));
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    if (h < hour || h >= hour + FRESH_WINDOW_H) return [];
    const done = [];
    const due = BOTS.filter((b) => store.metaGet(`fresh_day:${b.id}`, null) !== day && store.chat(`dm-${b.id}`));
    if (!due.length) return done;
    // A routine running right now keeps its bot as it is until the next pass (five minutes on).
    let running = new Set();
    try {
      running = new Set(hermes.runs().bots.filter((x) => (x.today || []).some((r) => (r.status === 'running' || r.status === 'claimed') && now >= Date.parse(r.started_at) && now - Date.parse(r.started_at) < 30 * 60000)).map((x) => x.id));
    } catch { /* not readable: go by the thread alone */ }
    for (const b of due) {
      const chatId = `dm-${b.id}`;
      if (!online(b.id) || running.has(b.id) || isTyping(chatId, b.id) || now - store.lastHumanAt(chatId) < FRESH_QUIET_MS || store.openDeliveries(b.id)) continue;
      store.command(chatId, HUMAN, 'fresh', b.id, { auto: true });
      store.metaSet(`fresh_day:${b.id}`, day);
      log(`fresh: ${b.id} starts a new conversation (nightly)`);
      done.push(b.id);
    }
    return done;
  }
  const freshTimer = sweepEvery ? setInterval(() => { try { freshen(); } catch (e) { log('fresh error', e); } }, 5 * 60 * 1000) : null;
  freshTimer?.unref?.();
  // Once a day, and a minute after start: old queue rows, used sign-in links and settled delivery notes go.
  const tidy = () => { try { const r = store.prune(); if (Object.values(r).some(Boolean)) log(`tidy: ${JSON.stringify(r)}`); } catch (e) { log('tidy error', e); } };
  const tidyTimer = sweepEvery ? setInterval(tidy, 24 * 3600 * 1000) : null;
  tidyTimer?.unref?.();
  if (sweepEvery) setTimeout(tidy, 60000).unref();

  store.on('message', (message, opts) => {
    toHumans('message', { message });
    if (member(message.sender)?.kind === 'bot') {
      setTyping(message.chat_id, message.sender, false);
      if (message.kind === 'work') notifyWork(message).catch((e) => log('push error', e));
      else if (!opts?.silent) notify(message).catch((e) => log('push error', e));
    }
  });
  // A harness error (11-11): no bubble, no push; the bot's typing ends and the System line looks again.
  store.on('system-note', (n) => {
    setTyping(n.chat_id, n.bot, false);
    log(`bot error from ${n.bot} in ${n.chat_id} kept as a system note (message ${n.id})${n.failed ? `; message ${n.failed} marked not answered` : ''}`);
    toHumans('system', { bot: n.bot, at: n.at });
  });
  // The client board (11-11) follows every change in the threads, a moment later and once per burst, the way
  // Needs you follows them: the board rides the live stream as a 'clients' event.
  let boardTimer = null;
  const board = () => clientBoard({ store, teamops, now: store.now() });
  function boardSoon() {
    if (boardTimer || !humans.size) return;
    boardTimer = setTimeout(() => { boardTimer = null; try { toHumans('clients', board()); } catch (e) { log('board error', e); } }, 700);
    boardTimer.unref?.();
  }
  store.on('message', boardSoon);
  store.on('update', boardSoon);
  store.on('work-finished', (message) => notifyWork(message).catch((e) => log('push error', e)));
  store.on('update', (message) => toHumans('update', { message }));
  store.on('later', () => toHumans('later', { items: store.laterList() }));
  store.on('files', () => toHumans('files', {}));
  store.on('read', (r) => toHumans('read', r));
  store.on('bot-event', (bot) => {
    for (const conn of bots.get(bot) || []) drainBot(conn);
    for (const wake of svcWaiters.get(bot) || []) wake();
  });

  const keepalive = setInterval(() => {
    // A named event, so the app can tell a live stream from one that died without closing (11-09).
    for (const res of humans) { try { res.write('event: ping\ndata: {}\n\n'); } catch {} }
    for (const set of bots.values()) for (const c of set) { try { c.res.write(': ping\n\n'); } catch {} }
  }, 20000);
  keepalive.unref();

  // ── auth ────────────────────────────────────────────────────────────────────

  function human(req) {
    const s = store.session(cookies(req)[COOKIE]);
    return s ? s.member : null;
  }

  // A local service (an approvals service, a script) with its own token in config.serviceTokens. It posts
  // cards into a bot's DM as that bot; the owner's presses on those cards come back to the service only.
  function service(req) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const hash = sha256(m[1]);
    for (const [id, h] of Object.entries(config.serviceTokens || {})) if (h && safeEqual(h, hash)) return `svc:${id}`;
    return null;
  }

  function bot(req) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const hash = sha256(m[1]);
    for (const [id, h] of Object.entries(config.botTokens || {})) if (h && safeEqual(h, hash) && member(id)?.kind === 'bot') return id;
    return null;
  }

  // Behind `tailscale serve` the Host header may be the local target, so the configured public
  // address and X-Forwarded-Host also count as this origin.
  const publicHost = (() => { try { return config.publicUrl ? new URL(config.publicUrl).host : null; } catch { return null; } })();
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    return host === req.headers.host || host === req.headers['x-forwarded-host'] || (publicHost && host === publicHost);
  }

  function sessionCookie(req, sid) {
    return `${COOKIE}=${sid}; Path=/; Max-Age=${400 * 86400}; HttpOnly; SameSite=Strict${secureRequest(req) ? '; Secure' : ''}`;
  }

  function secureRequest(req) {
    if (req.headers['x-forwarded-proto'] === 'https') return true;
    return !!(publicHost && config.publicUrl.startsWith('https:') && (req.headers.host === publicHost || req.headers['x-forwarded-for']));
  }

  // ── shared pieces ───────────────────────────────────────────────────────────

  function bootstrap(me) {
    const chats = store.chatsFor(me).map((c) => ({ id: c.id, kind: c.kind, title: c.title, members: c.members, ...store.summary(c.id, me) }));
    const typingNow = [...typing.entries()].map(([k, v]) => { const [chat_id, member_id] = k.split(':'); return { chat_id, member_id, status: v.status }; });
    return {
      me: { id: me, name: member(me).name },
      build: BUILD,
      members: MEMBERS.map(({ profile, ...m }) => ({ ...m, online: m.kind === 'bot' ? online(m.id) : true })),
      team: { ...TEAM_VIEW, lead: DEFAULT_RESPONDER },
      chats, typing: typingNow,
      later: store.laterList(),
      vapidPublicKey: config.vapid?.publicKey || null,
      push: { enabled: !!config.vapid },
    };
  }

  async function upload(req, sender) {
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    // A name with a bare % in it ("50% off.pdf" from a sender that does not encode) is taken as written.
    const rawName = String(req.headers['x-file-name'] || 'file');
    let decoded; try { decoded = decodeURIComponent(rawName); } catch { decoded = rawName; }
    const name = decoded.replace(/[\\/\0\r\n]/g, '_').slice(0, 120) || 'file';
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) throw new HttpError(413, 'too large');
    const id = randomBytes(16).toString('hex');
    const path = join(filesDir, id);
    let size = 0;
    const limiter = new Transform({ transform(chunk, _e, cb) { size += chunk.length; cb(size > MAX_UPLOAD ? new HttpError(413, 'too large') : null, chunk); } });
    try { await pipeline(req, limiter, createWriteStream(path, { mode: 0o600 })); }
    catch (e) { await unlink(path).catch(() => {}); throw e.status ? e : new HttpError(400, 'upload failed'); }
    if (!size) { await unlink(path).catch(() => {}); throw new HttpError(400, 'empty file'); }
    // A sender that only says "bytes" (or guesses wrong for .md or .docx) is corrected from the file's name.
    const named = typeFromName(name);
    const safe = SAFE_FILE_TYPES.has(type) ? type : (named && SAFE_FILE_TYPES.has(named) ? named : 'application/octet-stream');
    const dims = IMAGE_FILE_TYPES.has(safe) ? imageSize(path) : null;
    let file = store.addFile({ id, name, type: safe, size, sender, width: dims?.w, height: dims?.h });
    // Make the preview now, so it is ready by the time the message lands on his phone.
    if (dims || safe === 'image/heic') media?.ensure(store.fileRecord(id)).catch(() => {});
    // A PDF: count its pages before answering (the message that carries it says how long it is), then draw the
    // list thumbnail and the first page in the background.
    if (safe === 'application/pdf' && docs) {
      const info = await docs.inspect(store.fileRecord(id)).catch(() => null);
      if (info) { store.setFileDoc(id, info); file = store.file(id); }
      const rec = store.fileRecord(id);
      docs.thumb(rec).then(() => docs.page(rec, 1)).catch(() => {});
    } else if (docs && file.thumb) docs.thumb(store.fileRecord(id)).catch(() => {});
    return file;
  }

  // /files/<id> is the original; /files/<id>/p the small preview of a picture; /files/<id>/t a document's
  // first-page thumbnail; /files/<id>/pg/<n> one page of a PDF as a picture; /files/<id>/v a document as a page
  // for the viewer's frame (an HTML file, or a Word file turned into HTML). All private, none ever runs a script.
  const made = (res, path, type) => {
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': statSync(path).size, 'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    createReadStream(path).pipe(res);
  };
  async function serveFile(req, res, rest) {
    const [id, variant, arg] = String(rest).split('/');
    if (variant && !['p', 't', 'v', 'pg'].includes(variant)) return send(res, 404, 'not found');
    const f = store.file(id);
    const path = f && join(filesDir, f.id);
    if (!f || !/^[a-f0-9]{32}$/.test(f.id) || !existsSync(path)) return send(res, 404, 'not found');
    const rec = store.fileRecord(f.id);
    if (variant === 'p' && media) {
      const pv = await media.ensure(rec);
      if (pv && existsSync(pv)) return made(res, pv, media.previewType(pv));
    }
    if (variant === 't') {
      const t = docs ? await docs.thumb(rec) : null;
      return t && existsSync(t) ? made(res, t, 'image/jpeg') : send(res, 404, 'no thumbnail');
    }
    if (variant === 'pg') {
      const pg = docs ? await docs.page(rec, Number(arg)) : null;
      return pg && existsSync(pg) ? made(res, pg, 'image/jpeg') : send(res, 404, 'no such page');
    }
    if (variant === 'v') {
      const page = f.type === 'text/html' ? path : (docs ? await docs.html(rec) : null);
      if (!page || !existsSync(page)) return send(res, 404, 'cannot be shown as a page');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': statSync(page).size, 'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': DOC_CSP, 'Referrer-Policy': 'no-referrer',
      });
      return createReadStream(page).pipe(res);
    }
    const inline = INLINE_FILE_TYPES.has(f.type) || /^(video|audio)\//.test(f.type);
    const total = statSync(path).size;
    const head = {
      'Content-Type': /^text\//.test(f.type) ? `${f.type === 'text/html' ? 'text/plain' : f.type}; charset=utf-8` : f.type,
      'Cache-Control': 'private, max-age=31536000, immutable', 'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    };
    // A video or a recording plays in pieces: iOS asks for byte ranges and will not play without them.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers?.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (!(start <= end) || start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
      return createReadStream(path, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': total });
    createReadStream(path).pipe(res);
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const root = resolve(staticDir);
    const full = resolve(root, normalize(rel));
    if (!full.startsWith(root + sep) || !existsSync(full) || !statSync(full).isFile()) {
      return send(res, 404, 'not found');
    }
    const ext = extname(full);
    const longCache = /\/icons\//.test(full);
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      ...(ext === '.html' ? { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' } : {}),
      ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    // The service worker and the page carry the release id: each deploy installs a fresh cached
    // shell, and a page started from an older cached shell can tell and switch at once.
    if (rel === 'sw.js' || ext === '.html') return res.end(readFileSync(full, 'utf8').replaceAll('__BUILD__', BUILD));
    createReadStream(full).pipe(res);
  }

  // ── system status (11-09) ───────────────────────────────────────────────────
  // One honest list of what Vesper depends on, for the System sheet: each check is ok, warn or bad, in plain words.
  function systemStatus(now = Date.now()) {
    const checks = [];
    const add = (key, label, level, detail) => checks.push({ key, label, level, detail });
    const t = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms);
    const day = (ms) => (now - ms < 20 * 3600 * 1000 ? t(ms) : new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms));
    add('server', 'Vesper', 'ok', `Running since ${day(started)}`);
    for (const b of BOTS) {
      const up = online(b.id);
      const since = linkSince.get(b.id);
      // A bot that just dropped gets the same grace the app gives it before calling it offline.
      const fresh = !up && since && !since.up && now - since.at < 60000;
      add(`bot:${b.id}`, b.name, up || fresh || now - started < 60000 ? 'ok' : 'bad',
        up ? `Connected${since?.up ? ` since ${day(since.at)}` : ''}` : `Not connected${since && !since.up ? ` since ${day(since.at)}` : ''}`);
    }
    const d = store.deliveryCounts();
    if (d.stalled || d.failed) add('delivery', 'Your messages', 'bad', `${d.stalled + d.failed} did not reach a bot. Open the chat to send again.`);
    else add('delivery', 'Your messages', 'ok', 'Every message reached its bot');
    const subs = store.pushSubs().length;
    add('push', 'Notifications', !config.vapid ? 'warn' : subs ? 'ok' : 'warn', !config.vapid ? 'Not set up on this server' : subs ? `${subs === 1 ? '1 device' : `${subs} devices`} will ring` : 'No device has notifications on');
    // The morning's new conversations: after the window closes, a bot that was skipped is worth a look
    // (it was offline, or busy from 4 to 10 AM), because its chat keeps growing until it gets one.
    const freshHour = config.dmFreshHour === undefined ? 4 : config.dmFreshHour;
    if (freshHour != null) {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const v = (k) => p.find((x) => x.type === k)?.value;
      const today = `${v('year')}-${v('month')}-${v('day')}`;
      const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now - 86400000);
      const closed = Number(v('hour')) >= freshHour + FRESH_WINDOW_H;
      const late = BOTS.filter((b) => { const d = store.metaGet(`fresh_day:${b.id}`, null); return d !== today && !(d === yesterday && !closed); }).map((b) => b.name);
      const never = BOTS.every((b) => store.metaGet(`fresh_day:${b.id}`, null) == null);
      if (never) add('fresh', 'Morning reset', 'ok', `Every bot starts a new conversation after ${freshHour} AM, starting tomorrow`);
      else add('fresh', 'Morning reset', late.length ? 'warn' : 'ok', late.length ? `${late.join(', ')} did not start a new conversation this morning` : 'Every bot started a new conversation this morning');
    }
    // Harness errors today (11-11): the bots' own failures that used to land in the threads as if a bot said them.
    // A plan limit in the last three hours is a problem (nothing the bots do goes through); anything else a check.
    const sNow = store.now();
    const errs = store.botErrors(dayStart(sNow));
    if (errs.length) {
      const plan = errs.find((e) => e.plan && sNow - e.at < 3 * 3600 * 1000);
      const detail = plan ? plan.plain : `${errs.length === 1 ? '1 bot error' : `${errs.length} bot errors`} today`;
      checks.push({ key: 'bot-errors', label: 'Bot errors', level: plan ? 'bad' : 'warn', detail, headline: detail, items: errs });
    }
    if (docs && !docs.ready.pdf) add('docs', 'Documents', 'warn', 'PDF pages cannot be drawn on this Mac (poppler is missing: brew install poppler), so a PDF shows its first page only');
    for (const c of (system ? system(now) : [])) checks.push(c);
    const worst = checks.some((c) => c.level === 'bad') ? 'bad' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
    const first = checks.find((c) => c.level === worst && worst !== 'ok');
    return { at: now, level: worst, build: BUILD, headline: first ? first.headline || `${first.label}: ${first.detail}` : 'Everything is running', checks };
  }

  // ── routes ──────────────────────────────────────────────────────────────────

  async function handleHuman(req, res, url, me) {
    const p = url.pathname; const m = req.method;
    let r;
    if (m === 'GET' && p === '/api/bootstrap') return send(res, 200, bootstrap(me));
    if (m === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      humans.add(res);
      const cid = String(url.searchParams.get('client') || '');
      req.on('close', () => { humans.delete(res); if (cid) views.delete(cid); });
      return;
    }
    if (m === 'POST' && p === '/api/logout') {
      store.endSession(cookies(req)[COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict` });
    }
    if (m === 'POST' && p === '/api/presence') {
      const b = await readJson(req);
      const cid = String(b.client_id || req.headers['user-agent'] || 'web').slice(0, 120);
      views.set(cid, { visible: !!b.visible, chat_id: b.chat_id ? String(b.chat_id) : null, at: Date.now(), build: b.build ? String(b.build).slice(0, 40) : null, ua: String(req.headers['user-agent'] || '').slice(0, 160) });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/push/subscribe') {
      const b = await readJson(req);
      const sub = b.subscription;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'bad subscription');
      store.addPushSub({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, req.headers['user-agent']);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/push/unsubscribe') {
      const b = await readJson(req);
      if (b.endpoint) store.removePushSub(String(b.endpoint));
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/files') return send(res, 200, { file: await upload(req, me) });
    // Deliverables (11-10): every file the bots handed him, and "he opened it" for the New mark.
    if (m === 'GET' && p === '/api/deliverables') return send(res, 200, { items: store.deliverables(me, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }) });
    if (m === 'POST' && (r = /^\/api\/files\/([a-f0-9]{32})\/seen$/.exec(p))) {
      const file = store.fileSeen(r[1]);
      if (!file) throw new HttpError(404, 'no such file');
      return send(res, 200, { file });
    }
    if ((r = /^\/api\/chats\/([\w-]+)\/messages$/.exec(p))) {
      const chatId = r[1];
      if (!store.isMember(chatId, me)) throw new HttpError(404, 'no such chat');
      if (m === 'GET') {
        const page = store.messages(chatId, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit') });
        return send(res, 200, { ...page, reads: store.reads(chatId) });
      }
      if (m === 'POST') {
        const b = await readJson(req);
        const message = store.postMessage({ chatId, sender: me, text: b.text, replyTo: b.reply_to, attachments: b.attachments, clientId: b.client_id });
        return send(res, 200, { message });
      }
    }
    if (m === 'POST' && (r = /^\/api\/chats\/([\w-]+)\/read$/.exec(p))) {
      if (!store.isMember(r[1], me)) throw new HttpError(404, 'no such chat');
      const b = await readJson(req);
      store.setRead(r[1], me, b.last_id);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/react$/.exec(p))) {
      const b = await readJson(req);
      return send(res, 200, { message: store.react(r[1], me, b.emoji ?? null) });
    }
    if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/press$/.exec(p))) {
      const b = await readJson(req);
      return send(res, 200, { message: store.press(r[1], me, b.data, typeof b.edit === 'string' ? b.edit : null, typeof b.sealed === 'string' ? b.sealed : null) });
    }
    if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/undo$/.exec(p))) return send(res, 200, { message: store.undo(r[1], me) });
    // "Looks good" on a finished work card (11-11): marked on the card, nobody woken, no new message.
    if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/work$/.exec(p))) {
      const b = await readJson(req);
      if (b.ack !== true) throw new HttpError(400, 'say ack: true');
      return send(res, 200, { message: store.workAck(r[1], me) });
    }
    // 11-09: "Send again" under a message a bot never picked up, and Stop / Start fresh for a bot (no bubble).
    if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/redeliver$/.exec(p))) {
      const message = store.redeliver(r[1], me);
      log(`delivery: message ${message.id} sent again by ${me}`);
      return send(res, 200, { message });
    }
    if (m === 'POST' && (r = /^\/api\/chats\/([\w-]+)\/command$/.exec(p))) {
      const b = await readJson(req);
      // `keep: true` with fresh is the nightly kind: the bot's next message carries the tail of the thread.
      const out = store.command(r[1], me, String(b.command || ''), b.bot ? String(b.bot) : null, { auto: b.keep === true });
      log(`command ${out.command} to ${out.bot} by ${me}${b.keep === true ? ' (keeps the tail)' : ''}`);
      if (out.command === 'stop') setTyping(r[1], out.bot, false);
      return send(res, 200, { ok: true, ...out, online: online(out.bot) });
    }
    if (m === 'GET' && p === '/api/system') return send(res, 200, systemStatus());
    if (m === 'GET' && p === '/api/activity') return send(res, 200, teamops.activity ? teamops.activity(Number(url.searchParams.get('since'))) : { since: 0, items: [] });
    if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/change$/.exec(p))) {
      const b = await readJson(req);
      return send(res, 200, store.change(r[1], me, typeof b.text === 'string' ? b.text : ''));
    }
    // "Send a test" from the notifications row: proves the phone gets pushes, and says what happened.
    if (m === 'POST' && p === '/api/push/test') {
      if (!config.vapid) throw new HttpError(400, 'push is not set up on this server');
      const sent = await pushAll({ title: 'Vesper', body: 'Notifications work. Cards ring like this.', url: '/#/', tag: 'test' }, 'test');
      return send(res, 200, { ok: sent > 0, sent, subscribed: store.pushSubs().length });
    }
    // Vesper: routines, run history, token use, memory, Always rules (server/hermes.mjs).
    // Later (11-06): his reminders and parked things, on home beside Needs you.
    if (m === 'GET' && p === '/api/later') return send(res, 200, { items: store.laterList() });
    if (m === 'POST' && p === '/api/later') {
      const b = await readJson(req);
      if (b.chat_id != null && !store.isMember(String(b.chat_id), me)) throw new HttpError(403, 'not your chat');
      const item = store.laterAdd({ text: b.text, note: b.note, by: me, chatId: b.chat_id ?? null, messageId: b.message_id ?? null, dueAt: b.due_at ?? null });
      return send(res, 200, { item });
    }
    if ((r = /^\/api\/later\/(\d+)$/.exec(p))) {
      if (m === 'PATCH') {
        const b = await readJson(req);
        const patch = {};
        for (const k of ['text', 'note', 'due_at', 'done']) if (k in b) patch[k] = b[k];
        return send(res, 200, { item: store.laterUpdate(r[1], patch) });
      }
      if (m === 'DELETE') { store.laterDelete(r[1]); return send(res, 200, { ok: true }); }
    }
    if (m === 'GET' && p === '/api/runs') return send(res, 200, { ...hermes.runs(), claude: teamops.claudeJobs ? teamops.claudeJobs() : null });
    if (m === 'GET' && (r = /^\/api\/agents\/([a-z]+)$/.exec(p))) return send(res, 200, hermes.agent(r[1]));
    if (m === 'POST' && (r = /^\/api\/runs\/([a-z]+)\/([0-9a-f]{6,40})\/(pause|resume|run)$/.exec(p))) {
      const job = await hermes.act(r[1], r[2], r[3]);
      log(`routine ${r[3]}: ${r[1]} ${r[2]}`);
      return send(res, 200, { job });
    }
    if (m === 'POST' && (r = /^\/api\/runs\/([a-z]+)$/.exec(p))) {
      const job = await hermes.create(r[1], await readJson(req));
      log(`routine created: ${r[1]} ${job.id} ${job.name}`);
      return send(res, 200, { job });
    }
    if (m === 'PATCH' && (r = /^\/api\/runs\/([a-z]+)\/([0-9a-f]{6,40})$/.exec(p))) {
      const job = await hermes.edit(r[1], r[2], await readJson(req));
      log(`routine edited: ${r[1]} ${r[2]}`);
      return send(res, 200, { job });
    }
    // Catch me up and the per-client pause switch (server/teamops.mjs hooks; empty in this starter).
    if (m === 'GET' && p === '/api/catchup') return send(res, 200, teamops.catchup(Number(url.searchParams.get('since'))));
    if (m === 'GET' && p === '/api/clients') return send(res, 200, { clients: teamops.clients() });
    if (m === 'GET' && p === '/api/clients/home') return send(res, 200, board());
    if (m === 'GET' && p === '/api/audit') return send(res, 200, teamops.audit());
    if (m === 'GET' && p === '/api/room/rules') return send(res, 200, { rules: store.roomRules() });
    if (m === 'POST' && p === '/api/room/rules') {
      const rules = store.setRoomRules(await readJson(req));
      log(`room rules by ${me}: ${JSON.stringify(rules)}`);
      return send(res, 200, { rules });
    }
    if (m === 'POST' && (r = /^\/api\/clients\/(\d{1,4})\/pause$/.exec(p))) {
      const b = await readJson(req);
      const client = teamops.setPaused(r[1], !!b.paused);
      log(`client ${client.short} ${client.paused ? 'paused' : 'resumed'} by ${me}`);
      return send(res, 200, { client });
    }
    // Vesper 10-30: search everything, the message behind a "card #N" chip, link previews.
    if (m === 'GET' && p === '/api/search') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      const any = String(url.searchParams.get('any') || '').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 6);
      const recent = url.searchParams.get('recent') === '1';
      return send(res, 200, { messages: store.search(me, { q, any, recent }), memory: q || any.length ? hermes.searchMemory(q ? [q] : any) : [] });
    }
    if (m === 'GET' && (r = /^\/api\/cards\/(\d{1,7})$/.exec(p))) return send(res, 200, { message: store.cardMessage(r[1], me) });
    if (m === 'GET' && p === '/api/unfurl') {
      const u = String(url.searchParams.get('u') || '');
      if (!/^https?:\/\//i.test(u) || u.length > 2000) throw new HttpError(400, 'bad link');
      return send(res, 200, publicPreview(await unfurl.preview(u)));
    }
    if (m === 'GET' && p === '/api/unfurl/img') {
      let img = null;
      try { img = await unfurl.image(String(url.searchParams.get('u') || '')); } catch { img = null; }
      if (!img) throw new HttpError(404, 'no such picture');
      res.writeHead(200, {
        'Content-Type': img.type, 'Content-Length': img.body.length, 'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      return res.end(img.body);
    }
    if (m === 'POST' && (r = /^\/api\/rules\/(\d+)\/revoke$/.exec(p))) {
      const out = await hermes.revoke(r[1]);
      log(`always rule ${r[1]} revoked from the app`);
      return send(res, 200, out);
    }
    throw new HttpError(404, 'not found');
  }

  async function handleBot(req, res, url, me) {
    const p = url.pathname; const m = req.method;
    let r;
    if (m === 'GET' && p === '/bot/v1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      // The cursor moves when an event is written, the header says what the bot really took in. After a dropped
      // connection the lower of the two wins, so nothing written into a dead socket is lost (the bot ignores repeats).
      const got = Number(req.headers['last-event-id']) || 0;
      const cursor = store.botCursor(me);
      const conn = { res, bot: me, last: got > 0 ? Math.min(got, cursor) : cursor };
      const set = bots.get(me);
      const wasOnline = set.size > 0;
      set.add(conn);
      clearTimeout(offlineTimers.get(me));
      if (!wasOnline) { toHumans('presence', { member_id: me, online: true }); markLink(me, true); }
      log(`bot ${me} connected (from ${conn.last})`);
      drainBot(conn);
      req.on('close', () => {
        set.delete(conn);
        log(`bot ${me} disconnected`);
        if (set.size === 0) offlineTimers.set(me, setTimeout(() => { if (!online(me)) { toHumans('presence', { member_id: me, online: false }); markLink(me, false); } }, OFFLINE_GRACE_MS));
      });
      return;
    }
    if (m === 'POST' && p === '/bot/v1/messages') {
      const b = await readJson(req);
      const message = store.postMessage({ chatId: String(b.chat_id || ''), sender: me, text: b.text, replyTo: b.reply_to, buttons: b.buttons, attachments: b.attachments, clientId: b.client_id, doc: b.doc });
      return send(res, 200, { id: message.id, message });
    }
    if ((r = /^\/bot\/v1\/messages\/(\d+)$/.exec(p))) {
      if (m === 'PATCH') {
        const b = await readJson(req);
        return send(res, 200, { message: store.editMessage(r[1], me, { text: b.text, buttons: b.buttons, resolved: b.resolved, doc: b.doc }) });
      }
      if (m === 'DELETE') { store.deleteMessage(r[1], me); return send(res, 200, { ok: true }); }
    }
    // What the bot's gateway says about one of the owner's messages: working, done, failed or cancelled (11-09).
    if (m === 'POST' && p === '/bot/v1/receipt') {
      const b = await readJson(req);
      const out = store.receipt(me, b.message_id, String(b.state || ''));
      if (out?.state === 'failed') log(`delivery: ${me} failed on message ${out.message_id}`);
      return send(res, 200, { ok: true, known: !!out });
    }
    if (m === 'POST' && p === '/bot/v1/typing') {
      const b = await readJson(req);
      const chatId = String(b.chat_id || '');
      if (!store.isMember(chatId, me)) throw new HttpError(404, 'no such chat');
      setTyping(chatId, me, b.on !== false, b.status);
      // A bot that starts working has read the chat, which turns the owner's "Delivered" into "Read".
      if (b.on !== false) store.setRead(chatId, me, store.latestId(chatId));
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && (r = /^\/bot\/v1\/chats\/([\w-]+)$/.exec(p))) {
      const chat = store.chat(r[1]);
      if (!chat || !chat.members.includes(me)) throw new HttpError(404, 'no such chat');
      return send(res, 200, { ...chat, members: chat.members.map((id) => ({ id, name: member(id).name, kind: member(id).kind })) });
    }
    // The last few messages of a chat the bot is in (11-09). A bot whose conversation starts fresh each morning
    // reads these with the owner's first message of the day, so a bare "yes" still has something to point at.
    if (m === 'GET' && (r = /^\/bot\/v1\/chats\/([\w-]+)\/messages$/.exec(p))) {
      if (!store.isMember(r[1], me)) throw new HttpError(404, 'no such chat');
      const limit = Math.max(1, Math.min(30, Number(url.searchParams.get('limit')) || 12));
      const page = store.messages(r[1], { before: url.searchParams.get('before'), limit });
      return send(res, 200, { messages: page.messages.map((x) => ({
        id: x.id, sender: x.sender, name: member(x.sender)?.name || x.sender, at: x.at, kind: x.kind,
        text: String(x.text || '').slice(0, 700), attachments: (x.attachments || []).length,
        answered: x.resolved?.label || null, waiting: x.kind === 'card' && !x.resolved })) });
    }
    if (m === 'POST' && p === '/bot/v1/files') return send(res, 200, { file: await upload(req, me) });
    throw new HttpError(404, 'not found');
  }

  // What a service attaches: the creatives on a card he approves (10-29), and since 11-10 any document, on a card
  // or handed over on its own. Only files this service uploaded itself through /svc/v1/files, at most ten. Anything
  // else is refused, never dropped quietly.
  function serviceFiles(list, me) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new HttpError(400, 'attachments must be a list of file ids');
    if (list.length > MAX_SERVICE_FILES) throw new HttpError(400, `at most ${MAX_SERVICE_FILES} files`);
    const ids = list.map(String);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'duplicate file id');
    for (const id of ids) {
      const f = store.fileRecord(id);
      if (!f || f.sender !== me) throw new HttpError(400, `unknown file ${id}`);
    }
    return ids;
  }

  async function handleService(req, res, url, me) {
    const p = url.pathname; const m = req.method;
    let r;
    // Raw image bytes, Content-Type image/png or image/jpeg, name in X-File-Name (as the bot route).
    if (m === 'POST' && p === '/svc/v1/files') return send(res, 200, { file: await upload(req, me) });
    if (m === 'POST' && p === '/svc/v1/messages') {
      const b = await readJson(req);
      const as = String(b.as || '');
      const chat = store.chat(String(b.chat_id || ''));
      // Only into a bot's own DM with the owner, never the room or another bot's thread.
      if (member(as)?.kind !== 'bot' || !chat || chat.kind !== 'dm' || !chat.members.includes(as)) throw new HttpError(403, 'not that bot\'s DM');
      const attachments = serviceFiles(b.attachments, me);
      // A work card never rings when it goes up; it rings once when it finishes (notifyWork).
      const message = store.postMessage({ chatId: chat.id, sender: as, text: b.text, buttons: b.buttons, attachments, clientId: b.client_id, owner: me, silent: b.work != null || !!b.silent, doc: b.doc, work: b.work ?? null });
      if (message.doc) log(`deliverable ${message.id} from ${as}: "${message.doc.title}" (${message.attachments.length} files)`);
      if (message.work) log(`work card ${message.id} from ${as}: ${message.work.job} ${message.work.state}`);
      return send(res, 200, { id: message.id, message });
    }
    // What has been handed to him lately, in plain fields, so a bot can check before sending something twice.
    if (m === 'GET' && p === '/svc/v1/deliverables') {
      const limit = Math.max(1, Math.min(60, Number(url.searchParams.get('limit')) || 20));
      const items = store.deliverables(HUMAN, { limit }).map((d) => ({
        id: d.id, by: d.by, at: d.at, waiting: d.waiting, opened: d.files.every((f) => f.seen), for_at: d.doc?.for_at ?? null, client: d.doc?.client || null, kind: d.doc?.kind || null,
        title: d.doc?.title || plain(String(d.text || '').split('\n')[0].replace(/\s*\(#\d+\)\s*$/, '')).slice(0, 120) || d.files[0].name,
        files: d.files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      }));
      return send(res, 200, { items });
    }
    // One of the owner's own messages: a bot's said-so action is checked against
    // it. `id` is a message id or `last` (his newest message in `chat_id`). Plain fields only; never a bot's words.
    if (m === 'GET' && p === '/svc/v1/said') {
      const ref = String(url.searchParams.get('id') || '');
      const chatId = String(url.searchParams.get('chat_id') || '');
      const x = store.saidMessage(ref, chatId);
      if (!x) throw new HttpError(404, 'no such message');
      return send(res, 200, { message: x });
    }
    if (m === 'PATCH' && (r = /^\/svc\/v1\/messages\/(\d+)$/.exec(p))) {
      const b = await readJson(req);
      const attachments = 'attachments' in b ? serviceFiles(b.attachments, me) : undefined;
      return send(res, 200, { message: store.editMessage(r[1], null, { text: b.text, buttons: b.buttons, resolved: b.resolved, doc: b.doc, work: b.work, attachments }, { owner: me }) });
    }
    // What the service did with a reply to Claude (11-11): done when the job took it, failed when it could not.
    if (m === 'POST' && p === '/svc/v1/receipt') {
      const b = await readJson(req);
      const out = store.receipt(me, b.message_id, String(b.state || ''));
      if (out?.state === 'failed') log(`work reply ${out.message_id}: ${me} could not hand it on`);
      return send(res, 200, { ok: true, known: !!out });
    }
    // Later (11-06): a bot files his "remind me" or "park this" here (team-later), never as a timed chat message.
    // It sits in his own bot's DM by default, so Open chat lands where he asked.
    if (m === 'GET' && p === '/svc/v1/later') return send(res, 200, { items: store.laterList() });
    if (m === 'POST' && p === '/svc/v1/later') {
      const b = await readJson(req);
      const as = String(b.as || '');
      if (member(as)?.kind !== 'bot') throw new HttpError(400, `as is the bot filing it (${BOTS.map((b) => b.id).join(', ')})`);
      const chatId = b.chat_id != null ? String(b.chat_id) : (store.chat(`dm-${as}`) ? `dm-${as}` : null);
      const ref = b.reply_to != null ? store.message(b.reply_to) : null;
      if (b.reply_to != null && (!ref || !store.isMember(ref.chat_id, as))) throw new HttpError(400, 'reply_to is a message in your own thread');
      if (chatId && !store.isMember(chatId, as)) throw new HttpError(403, 'not that bot\'s chat');
      const item = store.laterAdd({ text: b.text, note: b.note, client: b.client, by: as, chatId: b.reply_to != null ? null : chatId, messageId: b.reply_to ?? null, dueAt: b.due_at ?? null });
      return send(res, 200, { item });
    }
    if (m === 'PATCH' && (r = /^\/svc\/v1\/later\/(\d+)$/.exec(p))) {
      const b = await readJson(req);
      const patch = {};
      for (const k of ['text', 'note', 'due_at', 'done']) if (k in b) patch[k] = b[k];
      return send(res, 200, { item: store.laterUpdate(r[1], patch) });
    }
    // Long poll, Telegram getUpdates style: `offset` confirms every event before it; returns events at or
    // after the cursor, waiting up to `wait` seconds (max 30) for the first one.
    if (m === 'GET' && p === '/svc/v1/updates') {
      const offset = Number(url.searchParams.get('offset')) || 0;
      if (offset > 0) store.setBotCursor(me, offset - 1);
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 30) * 1000;
      // A poll still waiting when the server shuts down wakes to a closed database: it answers with nothing.
      const take = () => { try { return store.botEventsAfter(me, store.botCursor(me), 100).map((e) => ({ id: e.id, kind: e.kind, ...e.payload })); } catch { return []; } };
      let events = take();
      if (!events.length && wait) {
        events = await new Promise((resolve) => {
          const set = svcWaiters.get(me) || new Set();
          svcWaiters.set(me, set);
          const done = () => { clearTimeout(timer); set.delete(wake); resolve(take()); };
          const wake = () => done();
          const timer = setTimeout(done, wait);
          set.add(wake);
          req.on('close', () => { clearTimeout(timer); set.delete(wake); });
        });
      }
      return send(res, 200, { events });
    }
    throw new HttpError(404, 'not found');
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://vesper.local');
    const p = url.pathname;
    try {
      if (p === '/health') {
        const ok = store.healthCheck();
        // Which release each recently seen app is running (so a phone stuck on an old shell shows).
        const seen = [...views.values()].filter((v) => Date.now() - v.at < 3600000).map((v) => ({ build: v.build, phone: /iPhone/.test(v.ua || ''), mins_ago: Math.round((Date.now() - v.at) / 60000) }));
        return send(res, ok ? 200 : 503, { ok, uptime_s: Math.round((Date.now() - started) / 1000), build: BUILD, bots: Object.fromEntries(BOTS.map((b) => [b.id, online(b.id)])), web_clients: humans.size, apps: seen, deliveries: store.deliveryCounts() });
      }
      // Sign-in: the one-time link (GET /login?t=) or the same code pasted into the app (POST
      // /api/login), which a Home Screen app needs because it keeps its own cookies apart from Safari.
      // The link answers with a same-origin refresh rather than a redirect so the SameSite=Strict
      // cookie is sent on the first load even when the link was tapped in another app.
      if (p === '/login' && req.method === 'GET') {
        const sid = store.redeemLoginToken(url.searchParams.get('t'), req.headers['user-agent']);
        if (!sid) return send(res, 403, 'This sign-in link has expired or was already used. Ask for a new one on the Mac (bin/login-link).');
        return send(res, 200, '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Vesper</title><p>Signed in. Opening Vesper.</p>', {
          'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': sessionCookie(req, sid), 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
        });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin');
        const b = await readJson(req);
        const code = String(b.code || '').trim().replace(/^.*[?&]t=/, '');
        const sid = store.redeemLoginToken(code, req.headers['user-agent']);
        if (!sid) throw new HttpError(403, 'That code has expired or was already used.');
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, sid) });
      }
      if (p.startsWith('/svc/')) {
        const me = service(req);
        if (!me) throw new HttpError(401, 'bad service token');
        return await handleService(req, res, url, me);
      }
      if (p.startsWith('/bot/')) {
        const me = bot(req);
        if (!me) throw new HttpError(401, 'bad bot token');
        return await handleBot(req, res, url, me);
      }
      if (p.startsWith('/files/')) {
        if (!human(req) && !bot(req)) throw new HttpError(401, 'sign in');
        return await serveFile(req, res, p.slice(7));
      }
      if (p.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'cross-origin');
        const me = human(req);
        if (!me) throw new HttpError(401, 'sign in');
        return await handleHuman(req, res, url, me);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
      throw new HttpError(404, 'not found');
    } catch (e) {
      // A phone that drops mid-request (the app going to the background) is not a server error.
      const gone = e?.message === 'aborted' || e?.code === 'ECONNRESET';
      const status = e.status || (gone ? 400 : 500);
      if (status >= 500) log('error', req.method, p, e.stack || e);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'server error' : e.message });
      else res.end();
    }
  }

  function close() {
    clearInterval(keepalive);
    if (reminder) clearInterval(reminder);
    if (laterTimer) clearInterval(laterTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    if (freshTimer) clearInterval(freshTimer);
    if (tidyTimer) clearInterval(tidyTimer);
    clearTimeout(boardTimer);
    for (const t of typing.values()) clearTimeout(t.timer);
    for (const t of offlineTimers.values()) clearTimeout(t);
    for (const res of humans) res.end();
    for (const set of bots.values()) for (const c of set) c.res.end();
  }

  // Pictures stored before previews existed: learn their shapes, then make their previews one at a time, newest first.
  async function warmPreviews() {
    if (!media) return { sized: 0, made: 0 };
    let sized = 0, made = 0;
    for (const r of store.imageFiles()) {
      if (!r.width && /^[a-f0-9]{32}$/.test(r.id)) {
        const d = imageSize(join(filesDir, r.id));
        if (d) { store.setFileSize(r.id, d.w, d.h); sized++; }
      }
    }
    for (const r of store.imageFiles()) {
      if (existsSync(media.previewPath(r.id))) continue;
      if (await media.ensure(r)) made++;
    }
    if (docs) for (const r of store.pdfFiles()) { const info = await docs.inspect(r).catch(() => null); if (info) store.setFileDoc(r.id, info); }
    if (sized || made) log(`previews: ${sized} sized, ${made} made`);
    return { sized, made };
  }

  return { handler, close, online, remindWaiting, ringLater, warmPreviews, sweepDeliveries, systemStatus, freshen };
}
