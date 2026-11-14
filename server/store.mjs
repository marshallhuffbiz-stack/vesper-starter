// SQLite store (node:sqlite) for chats, messages, reactions, reads, files, bot event queues, web
// sessions and push subscriptions. Emits 'message', 'update', 'read' and 'bot-event' for live fan-out.

import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { CHATS, HUMAN, member, TZ } from './team.mjs';
import { route, cleanRules } from './routing.mjs';
import { wantsPreview } from './media.mjs';
import { viewKind, wantsThumb } from './docs.mjs';
import { harnessError, plainError } from './harness.mjs';

const OWNER = member(HUMAN)?.name || 'the owner'; // how the bots are told who you are

export const MAX_TEXT = 16000;
export const LATER_TEXT_MAX = 300;
export const LATER_NOTE_MAX = 2000;
export const SEALED_TTL_MS = 15 * 60 * 1000;
const BOT_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REACTIONS = new Set(['❤️', '👍', '👎', '😂', '‼️', '❓']);
// Delivery of the owner's messages to the bots they wake (11-09). A message a bot shows no sign of having (no
// typing, no reply, no receipt) is queued for it once more after REDELIVER_AFTER_MS, and marked stalled after
// STALL_AFTER_MS so the app can say so instead of sitting on "Delivered".
export const REDELIVER_AFTER_MS = 90 * 1000;
export const STALL_AFTER_MS = 5 * 60 * 1000;
export const WORK_SILENT_MS = 4 * 60 * 1000;
const DELIVERY_OPEN = ['sent', 'stalled'];
const DELIVERY_STATES = new Set(['working', 'done', 'failed', 'cancelled']);
// Commands the owner can send a bot from the app without a visible message (Hermes slash commands).
export const COMMANDS = { stop: '/stop', fresh: '/new' };
const REACTION_WAKE_GAP_MS = 60 * 1000;
// Work cards (11-11): one message per Claude job that a service keeps current in place. His reply under one goes
// back to the same Claude conversation through the service that owns the card (a 'work_reply' event), never to the
// bot as a chat turn; a reply nobody takes within two minutes is marked stalled like any undelivered message.
export const WORK_STATES = new Set(['queued', 'working', 'done', 'needs_you', 'failed', 'stopped']);
export const WORK_FINISHED = new Set(['done', 'needs_you', 'failed', 'stopped']);
export const WORK_RINGS = new Set(['done', 'needs_you', 'failed']);
export const WORK_REPLY_STALL_MS = 2 * 60 * 1000;
export const WORK_ROUNDS_MAX = 6;
const WORK_WORDS = { queued: 'Waiting to start', working: 'Working', done: 'Finished', needs_you: 'Needs you', failed: 'Did not finish', stopped: 'Stopped' };
const isService = (id) => /^svc:/.test(String(id || ''));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_members (chat_id TEXT NOT NULL, member_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, member_id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
  sender TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reply_to INTEGER, kind TEXT NOT NULL DEFAULT 'text',
  buttons TEXT, resolved TEXT, attachments TEXT, client_id TEXT, woke INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, edited_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages(sender, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS reactions (message_id INTEGER NOT NULL, member_id TEXT NOT NULL, emoji TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (message_id, member_id));
CREATE TABLE IF NOT EXISTS reads (chat_id TEXT NOT NULL, member_id TEXT NOT NULL, last_id INTEGER NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (chat_id, member_id));
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  size INTEGER NOT NULL, sender TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_events (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_events_bot ON bot_events(bot, id);
CREATE TABLE IF NOT EXISTS bot_cursors (bot TEXT PRIMARY KEY, last_id INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS web_sessions (id TEXT PRIMARY KEY, ua TEXT, created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_tokens (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, ua TEXT,
  at INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS later (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, note TEXT, client TEXT,
  added_by TEXT NOT NULL, chat_id TEXT, message_id INTEGER, due_at INTEGER, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, done_at INTEGER, rang_at INTEGER);
CREATE INDEX IF NOT EXISTS later_open ON later(done_at, due_at);
CREATE TABLE IF NOT EXISTS deliveries (message_id INTEGER NOT NULL, bot TEXT NOT NULL, state TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (message_id, bot));
CREATE INDEX IF NOT EXISTS deliveries_open ON deliveries(state, at);
CREATE TABLE IF NOT EXISTS bot_turns (bot TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (bot, chat_id));
`;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const msTime = (v) => {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= 4102444800000 ? Math.round(ms) : null;
};

// A work card's data, cleaned. `input` is what the service sent; given keys replace `prev`'s, null takes one away.
// acked_at ("Looks good") belongs to the server: kept while the job stays finished, cleared when a new round starts.
export function validWork(input, prev = null) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'work is an object: job, title, state, ...');
  const merged = { ...(prev || {}) };
  for (const [k, v] of Object.entries(input)) { if (k === 'acked_at') continue; if (v == null) delete merged[k]; else merged[k] = v; }
  const job = String(merged.job ?? '').trim();
  if (!/^[\w.-]{1,40}$/.test(job)) throw new HttpError(400, 'work.job is the job id (letters, digits, dashes)');
  const state = String(merged.state || '');
  if (!WORK_STATES.has(state)) throw new HttpError(400, `work.state is one of ${[...WORK_STATES].join(', ')}`);
  const out = { job, title: oneLine(merged.title, 120) || 'Claude job', state };
  for (const [k, max] of [['client', 80], ['by', 40], ['ask', 600], ['note', 300]]) if (oneLine(merged[k], max)) out[k] = oneLine(merged[k], max);
  if (block(merged.result, 2400)) out.result = block(merged.result, 2400);
  if (Array.isArray(merged.steps)) {
    const steps = merged.steps.slice(0, 12).map((x) => ({ text: oneLine(typeof x === 'string' ? x : x?.text, 160), done: !!x?.done })).filter((x) => x.text);
    if (steps.length) out.steps = steps;
  }
  for (const k of ['started_at', 'finished_at', 'active_at']) { const t = msTime(merged[k]); if (t != null) out[k] = t; }
  const url = String(merged.url || '').trim();
  if (/^https?:\/\/\S+$/i.test(url) && url.length <= 2000) out.url = url;
  const round = Number(merged.round);
  if (Number.isInteger(round) && round >= 1 && round <= 20) out.round = round;
  if (Array.isArray(merged.rounds)) {
    const rounds = merged.rounds.slice(-WORK_ROUNDS_MAX).map((r) => {
      if (!r || typeof r !== 'object') return null;
      const x = {};
      if (block(r.result, 2400)) x.result = block(r.result, 2400);
      if (oneLine(r.reply, 600)) x.reply = oneLine(r.reply, 600);
      if (WORK_STATES.has(String(r.state || ''))) x.state = String(r.state);
      const t = msTime(r.finished_at); if (t != null) x.finished_at = t;
      return Object.keys(x).length ? x : null;
    }).filter(Boolean);
    if (rounds.length) out.rounds = rounds;
  }
  const wasFinished = prev && WORK_FINISHED.has(prev.state);
  if (prev?.acked_at && wasFinished && WORK_FINISHED.has(state) && (prev.round || 1) === (out.round || 1)) out.acked_at = prev.acked_at;
  return out;
}

// The words a work card carries as its text: what search, quotes and a bot's recap read.
export function workText(w) {
  return [`Claude: ${w.title}${w.client ? ` (${w.client})` : ''}`, WORK_WORDS[w.state] || w.state, w.result || w.note || ''].filter(Boolean).join('\n');
}
export const workWords = (state) => WORK_WORDS[state] || state;

export class Store extends EventEmitter {
  constructor(path, { now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
    this.db.exec(SCHEMA);
    // owner: a local service (e.g. 'svc:approvals') that posted this card as a bot; presses go to it.
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'owner')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN owner TEXT');
    }
    // 11-06: a picture's shape travels with it, so the app reserves its space without downloading it first.
    const fileCols = this.db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
    if (!fileCols.includes('width')) this.db.exec('ALTER TABLE files ADD COLUMN width INTEGER; ALTER TABLE files ADD COLUMN height INTEGER;');
    // 11-09: what the bot was told alongside a message travels with a resend of it.
    if (!this.db.prepare('PRAGMA table_info(deliveries)').all().some((c) => c.name === 'context')) this.db.exec('ALTER TABLE deliveries ADD COLUMN context TEXT');
    // 11-11: why a turn counts as failed when it is not the gateway's own word ('no_answer': a harness error said so).
    if (!this.db.prepare('PRAGMA table_info(deliveries)').all().some((c) => c.name === 'why')) this.db.exec('ALTER TABLE deliveries ADD COLUMN why TEXT');
    // 11-10: documents. A message can carry what it hands over (doc: title, client, kind, for_at); a PDF knows its
    // page count; a file knows when he first opened it. Files from before this are counted as already seen.
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'doc')) this.db.exec('ALTER TABLE messages ADD COLUMN doc TEXT');
    // 11-11: work cards. A message can carry a Claude job's live state (work: job, title, state, steps, result ...).
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'work')) this.db.exec('ALTER TABLE messages ADD COLUMN work TEXT');
    if (!fileCols.includes('pages')) {
      this.db.exec('ALTER TABLE files ADD COLUMN pages INTEGER; ALTER TABLE files ADD COLUMN seen_at INTEGER;');
      this.db.exec('UPDATE files SET seen_at = at');
    }
    this.seed();
    this.hideHarnessErrors();
  }

  // Harness errors already in the threads (from before 11-11) are reclassified once at start, so old threads are
  // clean too: kind 'error' never shows as a bubble, never counts as unread, and lists on the System sheet. The
  // words are kept as they were. Cheap: only bot text messages that start with the warning sign are looked at.
  hideHarnessErrors() {
    const rows = this.db.prepare(`SELECT id, text FROM messages WHERE kind = 'text' AND sender != ? AND owner IS NULL AND buttons IS NULL
      AND attachments IS NULL AND text LIKE ?`).all(HUMAN, '\u26a0%');
    const up = this.db.prepare(`UPDATE messages SET kind = 'error' WHERE id = ?`);
    let n = 0;
    for (const r of rows) if (harnessError(r.text)) { up.run(r.id); n++; }
    return n;
  }

  close() { this.db.close(); }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); this.pendingBotEvents.length = 0; throw e; }
  }

  seed() {
    const at = this.now();
    const insChat = this.db.prepare('INSERT OR IGNORE INTO chats (id, kind, title, sort, created_at) VALUES (?, ?, ?, ?, ?)');
    const insMember = this.db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)');
    this.tx(() => {
      for (const c of CHATS) {
        insChat.run(c.id, c.kind, c.title, c.sort, at);
        for (const m of c.members) insMember.run(c.id, m);
      }
    });
  }

  // ── chats ─────────────────────────────────────────────────────────────────

  chat(id) {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    if (!row) return null;
    const members = this.db.prepare('SELECT member_id FROM chat_members WHERE chat_id = ? ORDER BY rowid').all(id).map((r) => r.member_id);
    return { id: row.id, kind: row.kind, title: row.title, sort: row.sort, members };
  }

  chatsFor(memberId) {
    return this.db.prepare(`SELECT c.id FROM chats c JOIN chat_members m ON m.chat_id = c.id
      WHERE m.member_id = ? ORDER BY c.sort`).all(memberId).map((r) => this.chat(r.id));
  }

  isMember(chatId, memberId) {
    return !!this.db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND member_id = ?').get(chatId, memberId);
  }

  summary(chatId, forMember) {
    const lastRow = this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND kind NOT IN ('deleted', 'error') ORDER BY id DESC LIMIT 1`).get(chatId);
    const readId = this.readId(chatId, forMember);
    const unread = this.db.prepare(`SELECT COUNT(*) n FROM messages WHERE chat_id = ? AND id > ? AND sender != ?
      AND kind NOT IN ('deleted', 'error')`).get(chatId, readId, forMember).n;
    return { last: lastRow ? this.serialize(lastRow) : null, unread };
  }

  // ── messages ──────────────────────────────────────────────────────────────

  message(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
    return row ? this.serialize(row) : null;
  }

  // Search (Vesper 10-30): messages whose words hold the query, or any of a client's names, newest first.
  // With neither, the latest messages, which the app sorts by app itself. Only chats `member` is in.
  search(member, { q = '', any = [], recent = false, limit = 80 } = {}) {
    const lim = Math.max(1, Math.min(300, Number(limit) || 80));
    const like = (t) => `%${String(t).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = ["m.kind NOT IN ('deleted', 'error')", 'cm.member_id = ?'];
    const args = [member];
    if (q) { where.push("m.text LIKE ? ESCAPE '\\'"); args.push(like(q)); }
    const alts = (any || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
    if (alts.length) { where.push(`(${alts.map(() => "m.text LIKE ? ESCAPE '\\'").join(' OR ')})`); args.push(...alts.map(like)); }
    if (!q && !alts.length && !recent) return [];
    const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id
      WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`).all(...args, recent && !q && !alts.length ? 300 : lim);
    return rows.map((r) => this.serialize(r));
  }

  // The message that carries card #id (the approvals service writes "(#id)" at the end of its first line).
  cardMessage(id, member) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id
      WHERE cm.member_id = ? AND m.kind != 'deleted' AND m.text LIKE ? ORDER BY m.id DESC LIMIT 20`).all(member, `%(#${n})%`);
    const re = new RegExp(`\\(#${n}\\)\\s*$`);
    const row = rows.find((r) => re.test(String(r.text || '').split('\n')[0]));
    return row ? this.serialize(row) : null;
  }

  // Deliverables (11-10): everything the bots handed him as a file, newest first. One item per message: its files,
  // what it is (the doc a bot named, or the card it rides on) and whether a card there still waits on him.
  deliverables(member, { limit = 150, before = null } = {}) {
    const lim = Math.max(1, Math.min(300, Number(limit) || 150));
    const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.member_id = ?
      WHERE m.kind != 'deleted' AND m.attachments IS NOT NULL AND m.sender != ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`)
      .all(...[member, HUMAN, ...(before ? [Number(before)] : []), lim]);
    return rows.map((r) => {
      const files = (parse(r.attachments, []) || []).map((id) => this.file(id)).filter(Boolean);
      if (!files.length) return null;
      const buttons = parse(r.buttons);
      const resolved = parse(r.resolved);
      return {
        id: r.id, chat_id: r.chat_id, by: r.sender, at: r.created_at, text: r.text, kind: r.kind, doc: parse(r.doc), buttons, resolved,
        card: !!buttons || !!resolved, waiting: r.kind === 'card' && !resolved && (buttons || []).flat().some((b) => !b.url),
        answered: resolved?.label || null, files,
      };
    }).filter(Boolean);
  }

  serialize(row) {
    let reply = null;
    let toClaude = false;
    if (row.reply_to) {
      const r = this.db.prepare('SELECT id, sender, text, kind, owner FROM messages WHERE id = ?').get(row.reply_to);
      // A card is quoted whole (to 2,000 characters), so a bot asked about it or told to change it sees the full plan.
      if (r) reply = { id: r.id, sender: r.sender, text: r.kind === 'deleted' ? '' : r.text.slice(0, r.kind === 'card' ? 2000 : 280) };
      if (r && r.kind === 'work' && r.owner) { reply.work = true; toClaude = row.sender === HUMAN; }
    }
    const reactions = this.db.prepare('SELECT member_id, emoji FROM reactions WHERE message_id = ? ORDER BY at')
      .all(row.id).map((r) => ({ member_id: r.member_id, emoji: r.emoji }));
    const attachments = (parse(row.attachments, []) || []).map((id) => this.file(id)).filter(Boolean);
    const out = {
      id: row.id, chat_id: row.chat_id, sender: row.sender, text: row.text, at: row.created_at,
      edited_at: row.edited_at, kind: row.kind, reply_to: reply, buttons: parse(row.buttons),
      resolved: parse(row.resolved), attachments, reactions,
    };
    const doc = parse(row.doc);
    if (doc) out.doc = doc;
    const work = row.kind === 'work' ? parse(row.work) : null;
    if (work) out.work = work;
    if (toClaude) out.to_claude = true;
    if (row.client_id && row.sender === HUMAN) out.client_id = row.client_id;
    if (row.sender === HUMAN) {
      // Only a delivery that needs his eye travels with the message: a bot that never picked it up, or a turn that failed.
      const d = this.db.prepare(`SELECT bot, state, tries, why FROM deliveries WHERE message_id = ? AND state IN ('stalled', 'failed')
        ORDER BY state = 'failed' DESC LIMIT 1`).get(row.id);
      // A reply to Claude waits on the service that owns the card; the app names the card's bot and says Claude.
      if (d && isService(d.bot)) out.delivery = { state: d.state, bot: reply ? reply.sender : d.bot, tries: d.tries, claude: true };
      else if (d) out.delivery = { state: d.state, bot: d.bot, tries: d.tries, ...(d.state === 'failed' && d.why ? { why: d.why } : {}) };
    }
    return out;
  }

  messages(chatId, { before = null, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = before
      ? this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chatId, Number(before), lim + 1)
      : this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, lim + 1);
    const more = rows.length > lim;
    const page = rows.slice(0, lim).reverse().filter((r) => r.kind !== 'deleted' && r.kind !== 'error').map((r) => this.serialize(r));
    return { messages: page, more };
  }

  roomRules() {
    try { return cleanRules(JSON.parse(this.db.prepare(`SELECT value FROM meta WHERE key = 'room_rules'`).get()?.value || '{}')); } catch { return cleanRules({}); }
  }

  setRoomRules(patch) {
    const next = cleanRules({ ...this.roomRules(), ...(patch || {}) });
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('room_rules', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
    return next;
  }

  botWakesSinceHuman(chatId) {
    return this.db.prepare(`SELECT COUNT(*) n FROM messages WHERE chat_id = ? AND woke > 0 AND id >
      (SELECT COALESCE(MAX(id), 0) FROM messages WHERE chat_id = ? AND sender = ?)`).get(chatId, chatId, HUMAN).n;
  }

  // What a message hands over (11-10): a title he will recognize, and optionally the client, the kind of thing
  // (Meeting prep, Proposal, Draft) and the meeting or deadline it is for. Only on a message that carries files.
  validDoc(doc, files) {
    if (doc == null) return null;
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'doc is an object with a title');
    if (!files.length) throw new HttpError(400, 'a doc needs at least one file attached');
    const one = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const title = one(doc.title, 120);
    if (!title) throw new HttpError(400, 'doc.title is what he will call it, a few plain words');
    const out = { title };
    if (one(doc.client, 80)) out.client = one(doc.client, 80);
    if (one(doc.kind, 40)) out.kind = one(doc.kind, 40);
    if (doc.for_at != null && doc.for_at !== '') {
      const ms = typeof doc.for_at === 'number' ? doc.for_at : Date.parse(String(doc.for_at));
      if (!Number.isFinite(ms) || ms < 946684800000 || ms > 4102444800000) throw new HttpError(400, 'doc.for_at is a time (ms or ISO 8601 with a zone)');
      out.for_at = Math.round(ms);
    }
    return out;
  }

  validButtons(buttons) {
    if (buttons == null) return null;
    if (!Array.isArray(buttons) || buttons.length > 6) throw new HttpError(400, 'buttons must be rows');
    return buttons.map((row) => {
      if (!Array.isArray(row) || row.length === 0 || row.length > 4) throw new HttpError(400, 'bad button row');
      return row.map((b) => {
        const label = String(b?.label || '').slice(0, 64);
        // A link button (Needs a human, 10-31) opens a page; it is never pressed.
        if (b?.url != null) {
          const url = String(b.url).slice(0, 2000);
          if (!label || !/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, 'a link button needs a label and an http(s) address');
          return { label, data: 'link', url, style: '' };
        }
        const data = String(b?.data || '').slice(0, 128);
        if (!label || !data) throw new HttpError(400, 'button needs label and data');
        const style = ['primary', 'danger'].includes(b.style) ? b.style : '';
        return { label, data, style };
      });
    });
  }

  postMessage({ chatId, sender, text = '', replyTo = null, buttons = null, attachments = [], clientId = null, kind = 'text', owner = null, silent = false, doc = null, work = null }) {
    const chat = this.chat(chatId);
    if (!chat) throw new HttpError(404, 'no such chat');
    if (!chat.members.includes(sender)) throw new HttpError(403, 'not in this chat');
    text = String(text ?? '');
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    const job = work != null ? validWork(work) : null;
    if (job && !owner) throw new HttpError(400, 'only a service posts work cards');
    if (job) { text = workText(job); kind = 'work'; buttons = null; }
    const files = (Array.isArray(attachments) ? attachments : []).map(String).slice(0, 10);
    for (const f of files) if (!this.file(f)) throw new HttpError(400, `unknown file ${f}`);
    if (!text.trim() && files.length === 0) throw new HttpError(400, 'empty message');
    const btns = this.validButtons(buttons);
    const about = this.validDoc(doc, files);
    const cid = clientId ? String(clientId).slice(0, 80) : null;
    // A harness error a bot's gateway wrote into the chat (11-11): kept as a system note, routed to nobody.
    const harness = member(sender)?.kind === 'bot' && !owner && !job ? harnessError(text, { buttons: btns, files: files.length }) : null;
    if (harness) kind = 'error';

    if (cid) {
      const dup = this.db.prepare('SELECT * FROM messages WHERE sender = ? AND client_id = ?').get(sender, cid);
      if (dup) return this.serialize(dup);
    }
    let replyRow = null;
    if (replyTo) {
      replyRow = this.db.prepare('SELECT id, sender, chat_id, kind, owner, work FROM messages WHERE id = ?').get(Number(replyTo));
      if (!replyRow || replyRow.chat_id !== chatId) replyRow = null;
    }

    // The owner typing "send" (or "yes" as a reply) to a waiting card counts as sliding it (10-28). The words
    // still show in the thread, but go to no bot: the card's owner hears the press, as with a slide.
    const typed = member(sender)?.kind === 'human' && files.length === 0 ? this.typedApproval(chatId, text, replyRow) : null;
    const routed = route({
      chat, sender, text, replyToSender: replyRow?.sender || null,
      botWakesSinceHuman: this.botWakesSinceHuman(chatId), rules: this.roomRules(),
    });
    // His reply under a work card goes to Claude through the card's owner, not to the bot as a chat turn (11-11).
    const workCard = member(sender)?.kind === 'human' && replyRow?.kind === 'work' && replyRow.owner ? replyRow : null;
    const { recipients, addressed } = typed || workCard || harness ? { recipients: [], addressed: new Set() } : routed;
    const fromBot = member(sender)?.kind === 'bot';
    const at = this.now();
    const message = this.tx(() => {
      const res = this.db.prepare(`INSERT INTO messages (chat_id, sender, text, reply_to, kind, buttons, attachments,
        client_id, woke, created_at, owner, doc, work) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        chatId, sender, text, replyRow?.id ?? null, btns ? 'card' : kind, json(btns), files.length ? json(files) : null,
        cid, fromBot && addressed.size ? 1 : 0, at, owner, json(about), json(job));
      if (workCard) this.queueWorkReply(workCard, res.lastInsertRowid, text, files, sender, at);
      const msg = this.serialize(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(res.lastInsertRowid));
      const ins = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)');
      for (const bot of recipients) {
        const payload = { chat: { id: chat.id, kind: chat.kind, title: chat.title }, message: msg, addressed: addressed.has(bot) };
        // A bot's own thread with the owner: what it needs to know that its conversation does not hold (11-09).
        const context = !fromBot && addressed.has(bot) && chat.kind === 'dm' ? this.turnContext(bot, chat, msg) : null;
        if (context) payload.context = context;
        const ev = ins.run(bot, 'message', JSON.stringify(payload), at);
        this.pendingBotEvents.push({ bot, id: Number(ev.lastInsertRowid) });
        if (!fromBot && addressed.has(bot)) {
          this.db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, bot, state, tries, at, updated_at, context) VALUES (?, ?, 'sent', 0, ?, ?, ?)`).run(msg.id, bot, at, at, context);
          this.db.prepare(`INSERT INTO bot_turns (bot, chat_id, message_id, at) VALUES (?, ?, ?, ?)
            ON CONFLICT (bot, chat_id) DO UPDATE SET message_id = excluded.message_id, at = excluded.at`).run(bot, chat.id, msg.id, at);
        }
      }
      return msg;
    });
    if (harness) {
      // Never a bubble, a push or an unread: the app hears a system note. A turn that ended without a reply marks
      // the message of his it was for as not answered, so it shows the red note and Send again under his bubble.
      const failed = harness.noAnswer ? this.failTurn(sender, chatId, replyRow, at, harness.kind === 'silence') : null;
      this.emit('system-note', { id: message.id, bot: sender, chat_id: chatId, at, failed });
      return message;
    }
    // A bot that answers has plainly dealt with what he sent before it.
    if (fromBot) this.settleDeliveries(sender, chatId, message.id, 'done');
    this.flushBotEvents();
    this.emit('message', message, { addressed: [...addressed], silent: !!silent });
    // Sending counts as reading everything before it.
    this.setRead(chatId, sender, message.id, at);
    if (typed) {
      try { this.press(typed.id, sender, typed.data); } catch { /* answered a moment earlier: nothing to do */ }
    }
    return message;
  }

  // One reply to Claude: a 'work_reply' event for the service that owns the card, and a delivery row so a reply
  // nobody takes is marked stalled (two minutes) and can be sent again. Runs inside postMessage's transaction.
  queueWorkReply(card, messageId, text, files, sender, at) {
    const w = parse(card.work) || {};
    const payload = { chat_id: card.chat_id, card_id: card.id, message_id: Number(messageId), job: w.job || null, text: String(text || ''),
      attachments: files, by: { id: sender, name: member(sender)?.name || sender } };
    const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(card.owner, 'work_reply', JSON.stringify(payload), at);
    this.pendingBotEvents.push({ bot: card.owner, id: Number(ev.lastInsertRowid) });
    this.db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, bot, state, tries, at, updated_at, context) VALUES (?, ?, 'sent', 0, ?, ?, ?)`)
      .run(Number(messageId), card.owner, at, at, JSON.stringify({ work_reply: payload }));
  }

  // "Looks good" on a finished work card: marked on the card for every device, and nobody is woken.
  workAck(id, memberId) {
    if (member(memberId)?.kind !== 'human') throw new HttpError(403, 'only the owner can do that');
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
    if (!row || row.kind !== 'work') throw new HttpError(404, 'no such work card');
    const w = parse(row.work) || {};
    if (!WORK_FINISHED.has(w.state)) throw new HttpError(409, 'Claude is still working on it');
    if (!w.acked_at) {
      const at = this.now();
      this.db.prepare('UPDATE messages SET work = ? WHERE id = ?').run(json({ ...w, acked_at: at }), row.id);
      this.emit('update', this.message(row.id));
    }
    return this.message(row.id);
  }

  // Which waiting card a typed answer approves, if any. "send", "approve", "do it" and the like approve the
  // newest message in the thread when that is a waiting card, or the card replied to; a bare "yes" or "ok"
  // counts only as a reply to the card. Only cards whose main button approves or sends (not a choice list).
  typedApproval(chatId, text, replyRow) {
    const t = String(text || '').trim().toLowerCase().replace(/[.!\s]+$/, '');
    const strong = /^(send|send it|send now|send that|approve|approved|approve it|go ahead|do it|ship it)$/.test(t);
    const weak = /^(yes|yep|yeah|yup|ok|okay|sure|y)$/.test(t);
    if (!strong && !weak) return null;
    let card = null;
    if (replyRow) card = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(replyRow.id);
    else if (strong) card = this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);
    if (!card || card.kind !== 'card' || parse(card.resolved) || member(card.sender)?.kind !== 'bot') return null;
    if (/^Sealed: /m.test(card.text || '')) return null; // a sealed card needs its field, so typing "send" does not slide it
    const all = (parse(card.buttons) || []).flat();
    const primary = all.find((b) => b.style === 'primary') || all[0];
    if (!primary || !/^(approve|send|allow|yes|confirm)/i.test(primary.label || '')) return null;
    return { id: card.id, data: primary.data };
  }

  pendingBotEvents = [];
  harnessFailed = new Map(); // `${message}:${bot}` -> when a harness error said that turn ended with no reply (memory only)
  sealed = new Map(); // bot_event id -> {value, at}; memory only, never the database (Needs a human, 10-31)
  flushBotEvents() {
    const list = this.pendingBotEvents.splice(0);
    for (const e of list) this.emit('bot-event', e.bot, e.id);
  }

  // `owner` edits a service's card (posted as a bot); otherwise only the sender may edit.
  editMessage(id, sender, { text, buttons, resolved, doc, work, attachments }, { owner = null } = {}) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
    if (!row || row.kind === 'deleted') throw new HttpError(404, 'no such message');
    if (owner ? row.owner !== owner : (row.sender !== sender || row.owner)) throw new HttpError(403, 'not your message');
    const sets = []; const vals = [];
    let rang = null;
    // A work card changes in place (11-11): its data, and the text search reads. It rings once when it reaches done,
    // needs_you or failed (the app pushes on 'work-finished'), never for progress.
    if (work !== undefined) {
      if (row.kind !== 'work') throw new HttpError(400, 'not a work card');
      const prev = parse(row.work) || null;
      const next = validWork(work, prev);
      if (prev && next.job !== prev.job) throw new HttpError(400, 'work.job cannot change');
      if (WORK_RINGS.has(next.state) && !(prev && WORK_RINGS.has(prev.state) && (prev.round || 1) === (next.round || 1))) rang = next.state;
      sets.push('work = ?', 'text = ?'); vals.push(json(next), workText(next));
      text = undefined; buttons = undefined;
    }
    // A service's card takes the files the job made (only files that service uploaded; the app checks).
    if (attachments !== undefined) {
      if (!owner) throw new HttpError(403, 'only a service changes the files on its card');
      const files = (Array.isArray(attachments) ? attachments : []).map(String).slice(0, 10);
      for (const f of files) if (!this.file(f)) throw new HttpError(400, `unknown file ${f}`);
      sets.push('attachments = ?'); vals.push(files.length ? json(files) : null);
      row.attachments = files.length ? json(files) : null;
    }
    if (text !== undefined) { sets.push('text = ?'); vals.push(String(text).slice(0, MAX_TEXT)); }
    if (buttons !== undefined) {
      const b = this.validButtons(buttons);
      sets.push('buttons = ?', 'kind = ?'); vals.push(json(b), b ? 'card' : (row.kind === 'card' && row.resolved ? 'card' : 'text'));
    }
    if (resolved !== undefined) {
      const r = resolved ? { ...(parse(row.resolved) || {}), label: String(resolved.label || '').slice(0, 120), at: this.now() } : null;
      // `by: null` marks an outcome nobody chose (an approval that expired before the tap).
      if (r && resolved && 'by' in resolved && resolved.by == null) delete r.by;
      sets.push('resolved = ?'); vals.push(json(r));
    }
    // Labelling a handed-over file after the fact (11-10): a document a Claude job delivered on its own arrives with
    // the job's working title and no date. Given fields replace the old ones; null takes one away; the title stays.
    if (doc !== undefined) {
      if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'doc is an object: title, client, kind, for_at');
      const merged = { ...(parse(row.doc) || {}) };
      for (const k of ['title', 'client', 'kind', 'for_at']) if (k in doc) { if (doc[k] == null || doc[k] === '') delete merged[k]; else merged[k] = doc[k]; }
      sets.push('doc = ?'); vals.push(json(this.validDoc(merged, parse(row.attachments, []) || [])));
    }
    if (!sets.length) return this.serialize(row);
    sets.push('edited_at = ?'); vals.push(this.now());
    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row.id);
    const msg = this.message(row.id);
    this.emit('update', msg);
    if (rang) this.emit('work-finished', msg);
    return msg;
  }

  deleteMessage(id, sender) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'no such message');
    if (row.sender !== sender || row.owner) throw new HttpError(403, 'not your message');
    this.db.prepare(`UPDATE messages SET kind = 'deleted', text = '', buttons = NULL, edited_at = ? WHERE id = ?`).run(this.now(), row.id);
    const msg = this.serialize(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id));
    this.emit('update', msg);
    return msg;
  }

  react(messageId, memberId, emoji) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!row || row.kind === 'deleted') throw new HttpError(404, 'no such message');
    if (!this.isMember(row.chat_id, memberId)) throw new HttpError(403, 'not in this chat');
    if (emoji == null) this.db.prepare('DELETE FROM reactions WHERE message_id = ? AND member_id = ?').run(row.id, memberId);
    else {
      if (!REACTIONS.has(emoji)) throw new HttpError(400, 'unknown reaction');
      this.db.prepare(`INSERT INTO reactions (message_id, member_id, emoji, at) VALUES (?, ?, ?, ?)
        ON CONFLICT (message_id, member_id) DO UPDATE SET emoji = excluded.emoji, at = excluded.at`).run(row.id, memberId, emoji, this.now());
    }
    const msg = this.message(row.id);
    this.emit('update', msg);
    if (emoji != null) this.tapback(row, memberId, emoji);
    return msg;
  }

  // The owner's tapback on a bot's message reaches that bot (11-09). A thumbs up or down on something the bot asked,
  // or a question mark on anything, wakes it as his answer; every other tapback rides along as context with his
  // next message. A card is answered with its buttons, so a tapback on one never wakes anyone.
  reactionWakes = new Map(); // `${message}:${emoji}` -> at
  tapback(row, memberId, emoji) {
    const author = member(row.sender);
    if (member(memberId)?.kind !== 'human' || author?.kind !== 'bot') return;
    const chat = this.chat(row.chat_id);
    if (!chat) return;
    const at = this.now();
    const text = String(row.text || '');
    const waitingCard = row.kind === 'card' && !parse(row.resolved);
    const asks = /\?/.test(text.slice(-400));
    const key = `${row.id}:${emoji}`;
    const recent = at - (this.reactionWakes.get(key) || 0) < REACTION_WAKE_GAP_MS;
    const wake = !waitingCard && row.kind !== 'card' && row.kind !== 'work' && !recent && (emoji === '❓' || ((emoji === '👍' || emoji === '👎') && asks));
    if (wake) this.reactionWakes.set(key, at);
    for (const [k, t] of this.reactionWakes) if (at - t > 10 * REACTION_WAKE_GAP_MS) this.reactionWakes.delete(k);
    const payload = {
      chat: { id: chat.id, kind: chat.kind, title: chat.title },
      message: { id: row.id, sender: row.sender, text: text.slice(0, 600), at: row.created_at },
      emoji, wake, by: { id: memberId, name: member(memberId).name },
    };
    const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(row.sender, 'reaction', JSON.stringify(payload), at);
    this.emit('bot-event', row.sender, Number(ev.lastInsertRowid));
  }

  // Stop or Start fresh from the app: a Hermes slash command for one bot, with no bubble in the thread.
  command(chatId, memberId, name, botId = null, { auto = false } = {}) {
    if (member(memberId)?.kind !== 'human') throw new HttpError(403, 'only the owner can do that');
    const chat = this.chat(chatId);
    if (!chat || !chat.members.includes(memberId)) throw new HttpError(404, 'no such chat');
    const text = COMMANDS[name];
    if (!text) throw new HttpError(400, 'no such command');
    const bots = chat.members.filter((id) => member(id)?.kind === 'bot');
    const to = chat.kind === 'dm' ? bots[0] : bots.find((id) => id === botId);
    if (!to) throw new HttpError(400, 'say which bot');
    const at = this.now();
    const payload = { chat: { id: chat.id, kind: chat.kind, title: chat.title }, command: text, by: { id: memberId, name: member(memberId).name } };
    // A new conversation says nothing in the thread (the gateway's "Session reset!" banner is dropped by the plugin),
    // and the bot's next message from the owner carries what is still open. The nightly one also carries the tail of
    // the thread; one he asked for does not: forgetting the back-and-forth is why he pressed it.
    if (name === 'fresh') {
      payload.quiet = true;
      if (chat.kind === 'dm') this.metaSet(`fresh:${to}`, { at, recap: !!auto });
    }
    const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(to, 'command', JSON.stringify(payload), at);
    this.emit('bot-event', to, Number(ev.lastInsertRowid));
    return { bot: to, command: name };
  }

  // ── what a bot is told with the owner's message (11-09) ─────────────────────
  // A bot's conversation holds its own turns and its routine posts, never the cards the approvals service posts as
  // it, and after a new conversation starts, nothing at all. So each message of his in the bot's thread carries:
  //   after a nightly new conversation: the last messages of the thread, and what is still open;
  //   always: the cards in this thread that appeared or were answered since the bot's last turn here.
  // Plain lines, capped; the plugin hands it to the bot as context, not as a request.
  turnContext(bot, chat, msg) {
    const when = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);
    const one = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}\u2026` : x; };
    const cardState = (r) => { const res = parse(r.resolved); return res ? `answered: ${res.label || 'done'}${res.change ? ` ("${one(res.change, 120)}")` : ''}` : `waiting on ${OWNER}`; };
    const fresh = this.metaGet(`fresh:${bot}`, null);
    const parts = [];
    if (fresh?.recap) {
      const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND id < ? AND kind NOT IN ('deleted', 'error') ORDER BY id DESC LIMIT 12`).all(chat.id, msg.id).reverse();
      const lines = rows.map((r) => {
        const who = r.sender === bot ? 'You' : (member(r.sender)?.name || r.sender);
        const files = (parse(r.attachments, []) || []).length;
        const tag = r.kind === 'card' ? ` [card, ${cardState(r)}]` : '';
        const d = parse(r.doc);
        const wk = r.kind === 'work' ? parse(r.work) : null;
        if (wk) return `[${who}, ${when(r.created_at)}] Claude job card "${one(wk.title, 120)}": ${workWords(wk.state)}${wk.acked_at ? ` (${OWNER} marked it looks good)` : ''}`;
        const text = (d ? `Handed ${OWNER} "${one(d.title, 120)}" in Vesper. ` : '') + one(r.text, 420) + (files ? ` [${files} attachment${files === 1 ? '' : 's'}]` : '');
        return text.trim() ? `[${who}, ${when(r.created_at)}] ${text}${tag}` : null;
      }).filter(Boolean);
      if (lines.length) parts.push(`[The last messages in this chat, from before this conversation started. They are context for what ${OWNER} says next, not new requests.]\n${lines.join('\n')}`);
    } else {
      const since = this.db.prepare('SELECT at FROM bot_turns WHERE bot = ? AND chat_id = ?').get(bot, chat.id)?.at ?? (msg.at - 24 * 3600 * 1000);
      const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND sender = ? AND owner IS NOT NULL AND id < ? AND kind != 'deleted'
        AND (created_at > ? OR edited_at > ?) ORDER BY id DESC LIMIT 8`).all(chat.id, bot, msg.id, since, since).reverse();
      const lines = rows.map((r) => {
        const d = parse(r.doc);
        const n = (parse(r.attachments, []) || []).length;
        const wk = r.kind === 'work' ? parse(r.work) : null;
        if (wk) return `- Claude job card "${one(wk.title, 120)}": ${workWords(wk.state)}${wk.acked_at ? `, ${OWNER} marked it looks good` : ''}${n ? ` (${n} file${n === 1 ? '' : 's'} on it, already in the Deliverables)` : ''}. ${OWNER} reads Claude's result on the card itself.`;
        if (d) return `- already in ${OWNER}'s Vesper Deliverables: "${one(d.title, 120)}" (${n} file${n === 1 ? '' : 's'}, ${when(r.created_at)}). Do not send it again.`;
        return `- ${one(String(r.text || '').split('\n')[0].replace(/[*_\`]/g, ''), 150)}: ${cardState(r)} (${when(parse(r.resolved)?.at || r.created_at)})`;
      });
      if (lines.length) parts.push(`[Your cards in this thread since your last turn here. Posted for you by the approvals service, so they are not in your conversation. Context only.]\n${lines.join('\n')}`);
    }
    if (fresh) {
      const waiting = this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND kind = 'card' AND resolved IS NULL AND buttons IS NOT NULL AND created_at >= ? ORDER BY id`)
        .all(chat.id, msg.at - 2 * 86400000).slice(-6).map((r) => `- waiting card: ${one(String(r.text || '').split('\n')[0].replace(/[*_\`]/g, ''), 150)} (${when(r.created_at)})`);
      const later = this.laterList().filter((it) => it.by === bot).slice(0, 5).map((it) => `- on his Later list from you: ${one(it.text, 150)}${it.due_at ? ` (due ${when(it.due_at)})` : ''}`);
      if (waiting.length || later.length) parts.push(`[Still open in this thread]\n${[...waiting, ...later].join('\n')}`);
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(`fresh:${bot}`);
    }
    const out = parts.join('\n\n');
    return out ? out.slice(-7000) : null;
  }

  // A message the approvals service checks a said-so action against (11-11): by id, or `last`, his newest message
  // in the chat. Only messages in a bot's DM or the room; the caller checks who wrote it, where and when.
  saidMessage(ref, chatId) {
    let row = null;
    if (ref === 'last') {
      if (!chatId) return null;
      row = this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND sender = ? AND kind != 'deleted' ORDER BY id DESC LIMIT 1`).get(chatId, HUMAN);
    } else if (/^\d+$/.test(ref)) {
      row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(ref));
    }
    if (!row || row.kind === 'deleted') return null;
    const chat = this.chat(row.chat_id);
    if (!chat || (chat.kind !== 'dm' && chat.kind !== 'room')) return null;
    return { id: row.id, chat_id: row.chat_id, sender: row.sender, kind: row.kind, at: row.created_at, text: String(row.text || '').slice(0, 1000) };
  }

  // When the owner last wrote in a chat (the nightly new conversation waits for a quiet thread).
  lastHumanAt(chatId) {
    return this.db.prepare('SELECT COALESCE(MAX(created_at), 0) at FROM messages WHERE chat_id = ? AND sender = ?').get(chatId, HUMAN).at;
  }

  openDeliveries(bot) {
    return this.db.prepare(`SELECT COUNT(*) n FROM deliveries WHERE bot = ? AND state IN ('sent', 'working') AND at >= ?`).get(bot, this.now() - 6 * 3600 * 1000).n;
  }

  // ── delivery to bots (11-09) ──────────────────────────────────────────────

  // A bot showed it has everything up to `lastId` in this chat (it started typing, or posted).
  ackDeliveries(bot, chatId, lastId) {
    const rows = this.db.prepare(`SELECT d.message_id, d.state FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.bot = ? AND m.chat_id = ? AND d.message_id <= ? AND d.state IN ('sent', 'stalled')`).all(bot, chatId, Number(lastId) || 0);
    if (!rows.length) return 0;
    const at = this.now();
    const up = this.db.prepare(`UPDATE deliveries SET state = 'working', updated_at = ? WHERE message_id = ? AND bot = ?`);
    for (const r of rows) up.run(at, r.message_id, bot);
    for (const r of rows) if (r.state === 'stalled') { const m = this.message(r.message_id); if (m) this.emit('update', m); }
    return rows.length;
  }

  // A bot that posts in the chat has dealt with what he sent before it, whether or not it was seen typing first
  // (a quick reply with no typing must never read as "stopped without answering").
  settleDeliveries(bot, chatId, beforeId, state) {
    const flagged = this.db.prepare(`SELECT message_id FROM deliveries WHERE bot = ? AND state = 'stalled' AND message_id < ?
      AND message_id IN (SELECT id FROM messages WHERE chat_id = ?)`).all(bot, Number(beforeId), chatId);
    this.db.prepare(`UPDATE deliveries SET state = ?, updated_at = ? WHERE bot = ? AND state IN ('sent', 'working', 'stalled')
      AND message_id < ? AND message_id IN (SELECT id FROM messages WHERE chat_id = ?)`).run(state, this.now(), bot, Number(beforeId), chatId);
    for (const r of flagged) { const m = this.message(r.message_id); if (m) this.emit('update', m); }
  }

  // What the bot's own gateway says about one message: working, done, failed or cancelled (the plugin's hooks).
  receipt(bot, messageId, state) {
    if (!DELIVERY_STATES.has(state)) throw new HttpError(400, 'state is working, done, failed or cancelled');
    const row = this.db.prepare('SELECT d.*, m.chat_id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.message_id = ? AND d.bot = ?').get(Number(messageId), bot);
    if (!row) return null; // a bot's or a service's message, or one from before deliveries were kept
    const flagged = (st) => st === 'stalled' || st === 'failed';
    // A turn already marked failed (a harness error said it ended with no reply) stays failed when the gateway
    // then reports the same turn as done: the turn finished, but he got no answer.
    const key = `${row.message_id}:${bot}`;
    if (row.state === 'failed' && state === 'done' && this.harnessFailed.get(key) > this.now() - 10 * 60 * 1000) return { message_id: row.message_id, state: 'failed' };
    this.harnessFailed.delete(key);
    this.db.prepare('UPDATE deliveries SET state = ?, updated_at = ? WHERE message_id = ? AND bot = ?').run(state, this.now(), row.message_id, bot);
    // Everything he sent this bot before it in the chat came along with it (quick messages are handled as one turn).
    if (state === 'working') this.ackDeliveries(bot, row.chat_id, row.message_id);
    // The turn is over: whatever else was riding in it is over too.
    else this.db.prepare(`UPDATE deliveries SET state = 'done', updated_at = ? WHERE bot = ? AND state = 'working'
      AND message_id IN (SELECT id FROM messages WHERE chat_id = ?)`).run(this.now(), bot, row.chat_id);
    if (flagged(row.state) !== flagged(state)) { const m = this.message(row.message_id); if (m) this.emit('update', m); }
    return { message_id: row.message_id, state };
  }

  // Runs every half minute. Returns what it did so the app can log it and tell the owner about a stalled message.
  //   redelivered: [{message_id, bot}]  queued once more for a connected bot that showed no sign of it
  //   stalled:     [{message, bot}]     still no sign after STALL_AFTER_MS, or picked up and then silent (quit: true)
  sweepDeliveries(online = () => true, typing = () => false, now = this.now()) {
    const out = { redelivered: [], stalled: [] };
    // A reply to Claude that its service has not taken (no receipt) within two minutes: stalled, so it never vanishes.
    for (const d of this.db.prepare(`SELECT * FROM deliveries WHERE bot LIKE 'svc:%' AND state = 'sent' AND at <= ?`).all(now - WORK_REPLY_STALL_MS)) {
      this.db.prepare(`UPDATE deliveries SET state = 'stalled', updated_at = ? WHERE message_id = ? AND bot = ?`).run(now, d.message_id, d.bot);
      const fresh = this.message(d.message_id);
      if (!fresh) continue;
      this.emit('update', fresh);
      out.stalled.push({ message: fresh, bot: d.bot, claude: true });
    }
    // A bot that took the message, then went quiet without a word (its gateway was restarted mid-turn): stalled too.
    for (const d of this.db.prepare(`SELECT * FROM deliveries WHERE state = 'working' AND bot NOT LIKE 'svc:%' AND updated_at <= ?`).all(now - WORK_SILENT_MS)) {
      const m = this.message(d.message_id);
      if (!m) continue;
      if (typing(m.chat_id, d.bot)) { this.db.prepare('UPDATE deliveries SET updated_at = ? WHERE message_id = ? AND bot = ?').run(now, d.message_id, d.bot); continue; }
      this.db.prepare(`UPDATE deliveries SET state = 'stalled', updated_at = ? WHERE message_id = ? AND bot = ?`).run(now, d.message_id, d.bot);
      const fresh = this.message(d.message_id);
      this.emit('update', fresh);
      out.stalled.push({ message: fresh, bot: d.bot, quit: true });
    }
    const rows = this.db.prepare(`SELECT * FROM deliveries WHERE state = 'sent' AND bot NOT LIKE 'svc:%' AND at <= ? ORDER BY message_id`).all(now - REDELIVER_AFTER_MS);
    for (const d of rows) {
      const m = this.message(d.message_id);
      if (!m) { this.db.prepare('DELETE FROM deliveries WHERE message_id = ? AND bot = ?').run(d.message_id, d.bot); continue; }
      if (this.readId(m.chat_id, d.bot) >= m.id) { this.ackDeliveries(d.bot, m.chat_id, m.id); continue; }
      if (now - d.at >= STALL_AFTER_MS) {
        this.db.prepare(`UPDATE deliveries SET state = 'stalled', updated_at = ? WHERE message_id = ? AND bot = ?`).run(now, d.message_id, d.bot);
        const fresh = this.message(d.message_id);
        this.emit('update', fresh);
        out.stalled.push({ message: fresh, bot: d.bot });
      } else if (d.tries === 0 && online(d.bot)) {
        this.requeue(m, d.bot, 0);
        this.db.prepare('UPDATE deliveries SET tries = 1, updated_at = ? WHERE message_id = ? AND bot = ?').run(now, d.message_id, d.bot);
        out.redelivered.push({ message_id: d.message_id, bot: d.bot });
      }
    }
    return out;
  }

  // Put a message on a bot's queue again. `again` > 0 marks a resend the owner asked for, which the bot must take
  // even though it saw the message before; 0 is the quiet safety resend, which a bot that has it ignores.
  requeue(m, bot, again) {
    const chat = this.chat(m.chat_id);
    const payload = { chat: { id: chat.id, kind: chat.kind, title: chat.title }, message: m, addressed: true, redelivery: again };
    const context = this.db.prepare('SELECT context FROM deliveries WHERE message_id = ? AND bot = ?').get(m.id, bot)?.context;
    if (context) payload.context = context;
    const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(bot, 'message', JSON.stringify(payload), this.now());
    this.emit('bot-event', bot, Number(ev.lastInsertRowid));
  }

  // "Send again" under a message a bot never picked up or failed on.
  redeliver(messageId, memberId) {
    if (member(memberId)?.kind !== 'human') throw new HttpError(403, 'only the owner can do that');
    const m = this.message(messageId);
    if (!m || m.sender !== memberId) throw new HttpError(404, 'no such message');
    const rows = this.db.prepare(`SELECT * FROM deliveries WHERE message_id = ? AND state IN ('stalled', 'failed')`).all(m.id);
    if (!rows.length) throw new HttpError(409, 'nothing to send again');
    const at = this.now();
    for (const d of rows) {
      this.db.prepare(`UPDATE deliveries SET state = 'sent', tries = ?, at = ?, updated_at = ?, why = NULL WHERE message_id = ? AND bot = ?`).run(d.tries + 1, at, at, m.id, d.bot);
      if (isService(d.bot)) {
        // A reply to Claude goes to the card's service again, as the same event.
        const payload = parse(d.context, {})?.work_reply;
        if (!payload) continue;
        const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(d.bot, 'work_reply', JSON.stringify({ ...payload, redelivery: d.tries + 1 }), at);
        this.emit('bot-event', d.bot, Number(ev.lastInsertRowid));
      } else this.requeue({ ...m, delivery: undefined }, d.bot, d.tries + 1);
    }
    const fresh = this.message(m.id);
    this.emit('update', fresh);
    return fresh;
  }

  deliveryCounts() {
    const out = { sent: 0, stalled: 0, failed: 0 };
    for (const r of this.db.prepare(`SELECT state, COUNT(*) n FROM deliveries WHERE state IN ('sent', 'stalled', 'failed') AND at >= ? GROUP BY state`).all(this.now() - 2 * 86400000)) out[r.state] = r.n;
    return out;
  }

  // Housekeeping, once a day: queues, sign-in links and delivery notes nobody will read again.
  prune(now = this.now()) {
    const week = now - 7 * 86400000;
    const a = this.db.prepare('DELETE FROM bot_events WHERE at < ?').run(week).changes;
    const b = this.db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now - 86400000).changes;
    const c = this.db.prepare('DELETE FROM deliveries WHERE at < ?').run(now - 14 * 86400000).changes;
    const d = this.db.prepare('DELETE FROM web_sessions WHERE seen_at < ?').run(now - 400 * 86400000).changes;
    return { bot_events: a, login_tokens: b, deliveries: c, web_sessions: d };
  }

  // A button press. Only the human may press; the first press wins and is recorded on the card at once,
  // then the card's author (a bot, or the service that posted it as that bot) gets a 'press' event.
  // `edit` (Vesper review with edits): The owner's changed wording for a service card's approve button
  // ("a|<id>|<hash>"); the service sends that text instead of the draft.
  press(messageId, memberId, data, edit = null, sealed = null) {
    if (member(memberId)?.kind !== 'human') throw new HttpError(403, 'only the owner can press buttons');
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!row || row.kind === 'deleted') throw new HttpError(404, 'no such message');
    const buttons = parse(row.buttons) || [];
    const button = buttons.flat().find((b) => b.data === String(data));
    if (!button || button.url) throw new HttpError(400, 'no such button');
    if (parse(row.resolved)) throw new HttpError(409, 'already answered');
    // A sealed value (a code or key the owner types into a Needs-you card) is held in memory for the card's owner
    // and never written to the database, the card or the log.
    if (sealed != null) {
      sealed = String(sealed).trim();
      if (!row.owner || !/^a\|\d+\|/.test(button.data) || !/^Sealed: /m.test(row.text || '')) throw new HttpError(400, 'this card has no sealed field');
      if (!sealed || sealed.length > 500) throw new HttpError(400, 'the sealed value must be 1 to 500 characters');
    }
    if (edit != null) {
      edit = String(edit).replace(/\r\n/g, '\n').trim();
      if (!row.owner || !/^a\|\d+\|/.test(button.data)) throw new HttpError(400, 'this card cannot be edited');
      if (!edit || edit.length > 4000) throw new HttpError(400, 'the edited text must be 1 to 4000 characters');
    }
    const at = this.now();
    const msg = this.tx(() => {
      this.db.prepare('UPDATE messages SET resolved = ?, edited_at = ? WHERE id = ?')
        .run(json({ label: button.label, data: button.data, style: button.style, by: memberId, at, ...(edit != null ? { edited: true } : {}), ...(sealed ? { sealed: true } : {}) }), at, row.id);
      const to = row.owner || (member(row.sender)?.kind === 'bot' ? row.sender : null);
      if (to) {
        const payload = { chat_id: row.chat_id, message_id: row.id, data: button.data, label: button.label, by: { id: memberId, name: member(memberId).name }, ...(edit != null ? { edit } : {}) };
        const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(to, 'press', JSON.stringify(payload), at);
        this.pendingBotEvents.push({ bot: to, id: Number(ev.lastInsertRowid) });
        if (sealed) this.sealed.set(Number(ev.lastInsertRowid), { value: sealed, at });
      }
      return this.message(row.id);
    });
    this.flushBotEvents();
    this.emit('update', msg);
    return msg;
  }

  // Undo on a finished plan's receipt (Vesper 10-31). The card already carries its approve press, so Undo is not a
  // button: it goes to the card's owner (the approvals service) as a press with data "u|<action id>|-", once.
  undo(messageId, memberId) {
    if (member(memberId)?.kind !== 'human') throw new HttpError(403, 'only the owner can undo');
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!row || row.kind === 'deleted' || !row.owner) throw new HttpError(404, 'no such card');
    const aid = /\(#(\d{1,7})\)/.exec(String(row.text || '').split('\n')[0])?.[1];
    if (!aid || !/^Undo: /m.test(row.text || '')) throw new HttpError(400, 'nothing to undo on this card');
    const prev = parse(row.resolved) || {};
    if (prev.undo) throw new HttpError(409, 'undo already asked');
    const at = this.now();
    const msg = this.tx(() => {
      this.db.prepare('UPDATE messages SET resolved = ?, edited_at = ? WHERE id = ?').run(json({ ...prev, undo: at }), at, row.id);
      const payload = { chat_id: row.chat_id, message_id: row.id, data: `u|${aid}|-`, label: 'Undo', by: { id: memberId, name: member(memberId).name } };
      const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(row.owner, 'press', JSON.stringify(payload), at);
      this.pendingBotEvents.push({ bot: row.owner, id: Number(ev.lastInsertRowid) });
      return this.message(row.id);
    });
    this.flushBotEvents();
    this.emit('update', msg);
    return msg;
  }

  // "Change it" on a waiting card (Vesper 11-02, the owner: "click a button and basically say no, don't add it to
  // this, go ahead and start a Claude session, or no, we don't need to text him because of this, or go check the
  // website before you do this"). Nothing on the card goes out: a service card's owner hears "c|<id>|<hash>" with
  // his words (it closes the card as changed); a bot's own card gets its deny press. Then his words go into the
  // thread as his reply under the card, so the bot reads them with the card quoted and redoes it his way.
  change(messageId, memberId, text) {
    if (member(memberId)?.kind !== 'human') throw new HttpError(403, 'only the owner can change a card');
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!row || row.kind !== 'card') throw new HttpError(404, 'no such card');
    if (parse(row.resolved)) throw new HttpError(409, 'already answered');
    const note = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!note || note.length > 2000) throw new HttpError(400, 'say what to do instead in 1 to 2000 characters');
    const all = (parse(row.buttons) || []).flat().filter((b) => !b.url);
    const owned = row.owner ? all.find((b) => /^[ag]\|\d+\|/.test(String(b.data || ''))) : null;
    const deny = owned ? null : all.find((b) => b.style === 'danger');
    if (!owned && !deny) throw new HttpError(400, 'this card cannot be changed; reply to it instead');
    const data = owned ? String(owned.data).replace(/^[ag]\|/, 'c|') : deny.data;
    const to = row.owner || (member(row.sender)?.kind === 'bot' ? row.sender : null);
    const at = this.now();
    const card = this.tx(() => {
      this.db.prepare('UPDATE messages SET resolved = ?, edited_at = ? WHERE id = ?')
        .run(json({ label: 'Changed', data, style: '', by: memberId, at, change: note.slice(0, 280) }), at, row.id);
      if (to) {
        const payload = { chat_id: row.chat_id, message_id: row.id, data, label: owned ? 'Changed' : deny.label, by: { id: memberId, name: member(memberId).name }, ...(owned ? { change: note } : {}) };
        const ev = this.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run(to, 'press', JSON.stringify(payload), at);
        this.pendingBotEvents.push({ bot: to, id: Number(ev.lastInsertRowid) });
      }
      return this.message(row.id);
    });
    this.flushBotEvents();
    this.emit('update', card);
    const reply = this.postMessage({ chatId: row.chat_id, sender: memberId, text: note, replyTo: row.id });
    return { message: this.message(row.id), reply };
  }

  // The message of his a failed turn was for (11-11): the one the error replies to, else his newest message this bot
  // took up in this chat in the last 30 minutes with no reply from the bot since. For the silence marker, which
  // always answers him, his newest message in the bot's own thread is the fallback. Marked failed, like a turn the
  // gateway reports as failed. Returns the message id, or null.
  failTurn(bot, chatId, replyRow, at, silence = false) {
    const since = at - 30 * 60 * 1000;
    let id = replyRow && replyRow.sender === HUMAN ? replyRow.id : null;
    id ??= this.db.prepare(`SELECT d.message_id id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.bot = ? AND m.chat_id = ?
      AND m.created_at >= ? ORDER BY d.message_id DESC LIMIT 1`).get(bot, chatId, since)?.id ?? null;
    if (id == null && silence && this.chat(chatId)?.kind === 'dm') {
      id = this.db.prepare(`SELECT id FROM messages WHERE chat_id = ? AND sender = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`).get(chatId, HUMAN, since)?.id ?? null;
    }
    if (id == null) return null;
    const answered = this.db.prepare(`SELECT 1 FROM messages WHERE chat_id = ? AND sender = ? AND id > ? AND kind NOT IN ('deleted', 'error') LIMIT 1`).get(chatId, bot, id);
    if (answered) return null;
    this.db.prepare(`INSERT INTO deliveries (message_id, bot, state, tries, at, updated_at, why) VALUES (?, ?, 'failed', 0, ?, ?, 'no_answer')
      ON CONFLICT (message_id, bot) DO UPDATE SET state = 'failed', updated_at = excluded.updated_at, why = 'no_answer'`).run(id, bot, at, at);
    this.harnessFailed.set(`${id}:${bot}`, at);
    for (const [k, t] of this.harnessFailed) if (t < at - 10 * 60 * 1000) this.harnessFailed.delete(k);
    const m = this.message(id);
    if (m) this.emit('update', m);
    return id;
  }

  // Harness errors the bots' gateways wrote since `sinceMs`, newest first, as system notes: who, when, a plain
  // line, and the raw words for the disclosure on the System sheet.
  botErrors(sinceMs = 0, limit = 30) {
    return this.db.prepare(`SELECT id, chat_id, sender, text, created_at FROM messages WHERE kind = 'error' AND created_at >= ? ORDER BY id DESC LIMIT ?`)
      .all(sinceMs, limit).map((r) => {
        const e = harnessError(r.text);
        const name = member(r.sender)?.name || r.sender;
        return { id: r.id, bot: r.sender, name, chat_id: r.chat_id, at: r.created_at, kind: e?.kind || 'other', plan: !!e?.plan, plain: plainError(e, name), raw: String(r.text || '').slice(0, 2000) };
      });
  }

  messageChat(id) { return this.db.prepare('SELECT chat_id FROM messages WHERE id = ?').get(Number(id))?.chat_id || null; }

  // Work cards touched since `sinceMs` (the client board, 11-11).
  workCards(sinceMs = 0) {
    return this.db.prepare(`SELECT * FROM messages WHERE kind = 'work' AND (created_at >= ? OR edited_at >= ?) ORDER BY id`).all(sinceMs, sinceMs).map((r) => this.serialize(r));
  }

  // Cards still waiting on the owner (buttons, no press yet), oldest first.
  waitingCards(sinceMs = 0) {
    return this.db.prepare(`SELECT * FROM messages WHERE kind = 'card' AND resolved IS NULL AND buttons IS NOT NULL
      AND created_at >= ? ORDER BY id`).all(sinceMs).map((r) => this.serialize(r)).filter((m) => (m.buttons || []).flat().some((b) => !b.url));
  }

  // Everything unread for one member across their chats (the app icon badge a push sets).
  unreadTotal(memberId) {
    return this.chatsFor(memberId).reduce((n, c) => n + this.summary(c.id, memberId).unread, 0);
  }

  metaGet(key, fallback = null) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return r ? parse(r.value, fallback) : fallback;
  }

  metaSet(key, value) {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  readId(chatId, memberId) {
    return this.db.prepare('SELECT last_id FROM reads WHERE chat_id = ? AND member_id = ?').get(chatId, memberId)?.last_id || 0;
  }

  setRead(chatId, memberId, lastId, at = this.now()) {
    const n = Number(lastId) || 0;
    const res = this.db.prepare(`INSERT INTO reads (chat_id, member_id, last_id, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id, member_id) DO UPDATE SET last_id = excluded.last_id, at = excluded.at
      WHERE excluded.last_id > reads.last_id`).run(chatId, memberId, n, at);
    if (res.changes) {
      this.emit('read', { chat_id: chatId, member_id: memberId, last_id: n, at });
      if (member(memberId)?.kind === 'bot') this.ackDeliveries(memberId, chatId, n);
    }
    return res.changes > 0;
  }

  reads(chatId) {
    const out = {};
    for (const r of this.db.prepare('SELECT member_id, last_id, at FROM reads WHERE chat_id = ?').all(chatId)) out[r.member_id] = { last_id: r.last_id, at: r.at };
    return out;
  }

  latestId(chatId) {
    return this.db.prepare('SELECT COALESCE(MAX(id), 0) id FROM messages WHERE chat_id = ?').get(chatId).id;
  }

  // ── files ─────────────────────────────────────────────────────────────────

  // His own uploads count as seen from the start; what a bot or a service sends is new until he opens it.
  addFile({ id, name, type, size, sender, width = null, height = null }) {
    const at = this.now();
    this.db.prepare('INSERT INTO files (id, name, type, size, sender, at, width, height, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, type, size, sender, at, width || null, height || null, sender === HUMAN ? at : null);
    return this.file(id);
  }

  // A PDF's page count and first-page shape, learned right after upload.
  setFileDoc(id, { pages = null, width = null, height = null } = {}) {
    this.db.prepare('UPDATE files SET pages = ?, width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ?').run(pages || null, width || null, height || null, String(id));
  }
  pdfFiles() { return this.db.prepare("SELECT * FROM files WHERE type = 'application/pdf' AND pages IS NULL ORDER BY at DESC").all(); }

  // He opened it. Returns the file as clients see it, or null.
  fileSeen(id) {
    const r = this.db.prepare('UPDATE files SET seen_at = ? WHERE id = ? AND seen_at IS NULL').run(this.now(), String(id));
    if (r.changes) this.emit('files');
    return this.file(id);
  }

  setFileSize(id, width, height) { this.db.prepare('UPDATE files SET width = ?, height = ? WHERE id = ?').run(width || null, height || null, String(id)); }
  imageFiles() { return this.db.prepare("SELECT * FROM files WHERE type LIKE 'image/%' ORDER BY at DESC").all(); }

  // The stored row, uploader included (file() is what clients see).
  fileRecord(id) {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(String(id)) || null;
  }

  file(id) {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(String(id));
    if (!r) return null;
    const out = { id: r.id, name: r.name, type: r.type, size: r.size, url: `/files/${r.id}`, view: viewKind(r), seen: r.seen_at != null };
    // Documents: how many pages a PDF has, the shape of a page, and the small first-page picture for lists.
    if (r.type === 'application/pdf') { if (r.pages) out.pages = r.pages; if (r.width && r.height) { out.width = r.width; out.height = r.height; } }
    if (wantsThumb(r)) out.thumb = `/files/${r.id}/t`;
    // Pictures: their shape, and the small preview the app shows (the original opens on a tap).
    if (/^image\//.test(r.type)) {
      if (r.width && r.height) { out.width = r.width; out.height = r.height; }
      out.preview = wantsPreview(r) ? `/files/${r.id}/p` : out.url;
    }
    return out;
  }

  // ── bot event queues ──────────────────────────────────────────────────────

  botEventsAfter(bot, afterId, limit = 200) {
    const since = this.now() - BOT_EVENT_MAX_AGE_MS;
    for (const [id, s] of this.sealed) if (this.now() - s.at > SEALED_TTL_MS) this.sealed.delete(id);
    return this.db.prepare('SELECT * FROM bot_events WHERE bot = ? AND id > ? AND at >= ? ORDER BY id LIMIT ?')
      .all(bot, Number(afterId) || 0, since, limit)
      .map((r) => {
        const payload = parse(r.payload, {});
        const s = this.sealed.get(r.id);
        return { id: r.id, kind: r.kind, payload: s ? { ...payload, sealed: s.value } : payload };
      });
  }

  botCursor(bot) {
    return this.db.prepare('SELECT last_id FROM bot_cursors WHERE bot = ?').get(bot)?.last_id || 0;
  }

  setBotCursor(bot, id) {
    for (const k of this.sealed.keys()) if (k <= Number(id)) this.sealed.delete(k); // confirmed: gone
    this.db.prepare(`INSERT INTO bot_cursors (bot, last_id, at) VALUES (?, ?, ?)
      ON CONFLICT (bot) DO UPDATE SET last_id = excluded.last_id, at = excluded.at WHERE excluded.last_id > bot_cursors.last_id`)
      .run(bot, Number(id), this.now());
  }

  // ── web sessions and one-time login links ─────────────────────────────────

  mintLoginToken(ttlMs = 30 * 60 * 1000) {
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO login_tokens (hash, expires_at) VALUES (?, ?)').run(sha256(token), this.now() + ttlMs);
    return token;
  }

  redeemLoginToken(token, ua = '') {
    const hash = sha256(token || '');
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(hash);
      if (!row || row.used_at || row.expires_at < this.now()) return null;
      this.db.prepare('UPDATE login_tokens SET used_at = ? WHERE hash = ?').run(this.now(), hash);
      const sid = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO web_sessions (id, ua, created_at, seen_at) VALUES (?, ?, ?, ?)').run(sha256(sid), String(ua).slice(0, 200), this.now(), this.now());
      return sid;
    });
  }

  session(sid) {
    if (!sid) return null;
    const hash = sha256(sid);
    const row = this.db.prepare('SELECT * FROM web_sessions WHERE id = ?').get(hash);
    if (!row) return null;
    if (this.now() - row.seen_at > 60 * 60 * 1000) this.db.prepare('UPDATE web_sessions SET seen_at = ? WHERE id = ?').run(this.now(), hash);
    return { id: hash, member: HUMAN };
  }

  endSession(sid) { this.db.prepare('DELETE FROM web_sessions WHERE id = ?').run(sha256(sid || '')); }

  // ── push subscriptions ────────────────────────────────────────────────────

  addPushSub(sub, ua = '') {
    this.db.prepare(`INSERT INTO push_subs (endpoint, sub, ua, at, fails) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT (endpoint) DO UPDATE SET sub = excluded.sub, ua = excluded.ua, at = excluded.at, fails = 0`)
      .run(sub.endpoint, JSON.stringify(sub), String(ua).slice(0, 200), this.now());
  }

  removePushSub(endpoint) { this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint); }
  pushSubs() { return this.db.prepare('SELECT endpoint, sub, fails FROM push_subs').all().map((r) => ({ ...parse(r.sub, {}), fails: r.fails })); }
  pushFailed(endpoint) { this.db.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').run(endpoint); }
  pushOk(endpoint) { this.db.prepare('UPDATE push_subs SET fails = 0 WHERE endpoint = ?').run(endpoint); }

  // ── later (11-06) ─────────────────────────────────────────────────────────
  // The owner's reminders and parked things: "remind me Tuesday", "park this for later". They live on the home
  // screen next to Needs you, never as a chat message that scrolls away. due_at null = parked with no date; an
  // item past its due_at shows in Needs you, and the app rings it once (rang_at).

  laterRow(r) {
    return r ? { id: r.id, text: r.text, note: r.note || null, client: r.client || null, by: r.added_by, chat_id: r.chat_id || null,
      message_id: r.message_id ?? null, due_at: r.due_at ?? null, created_at: r.created_at, updated_at: r.updated_at,
      done_at: r.done_at ?? null } : null;
  }

  laterItem(id) { return this.laterRow(this.db.prepare('SELECT * FROM later WHERE id = ?').get(Number(id))); }

  // Open items: dated ones by when they are due, then the undated ones, newest parked first.
  laterList() {
    return this.db.prepare(`SELECT * FROM later WHERE done_at IS NULL
      ORDER BY due_at IS NULL, due_at, created_at DESC`).all().map((r) => this.laterRow(r));
  }

  laterDueAt(v) {
    if (v == null || v === '') return null;
    const ms = typeof v === 'number' ? v : Date.parse(String(v));
    if (!Number.isFinite(ms) || ms < 946684800000 || ms > 4102444800000) throw new HttpError(400, 'due_at is a time (ms or ISO 8601 with a zone)');
    return Math.round(ms);
  }

  laterText(v, field = 'text', max = LATER_TEXT_MAX) {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (field === 'text' && !t) throw new HttpError(400, 'text is the thing to remember, a few plain words');
    if (t.length > max) throw new HttpError(400, `${field} is at most ${max} characters`);
    return t || null;
  }

  laterAdd({ text, note = null, client = null, by, chatId = null, messageId = null, dueAt = null }) {
    const t = this.laterText(text);
    const n = this.laterText(note, 'note', LATER_NOTE_MAX);
    const cl = this.laterText(client, 'client', 80);
    const due = this.laterDueAt(dueAt);
    if (chatId != null && !this.chat(String(chatId))) throw new HttpError(400, 'unknown chat');
    let mid = null;
    if (messageId != null && messageId !== '') {
      const m = this.message(messageId);
      if (!m || (chatId != null && m.chat_id !== String(chatId))) throw new HttpError(400, 'that message is not in that chat');
      mid = m.id;
      chatId = m.chat_id;
    }
    const at = this.now();
    // The same thing asked twice (a bot retrying, or "remind me" said again) moves the one item, never adds a second.
    const dup = this.db.prepare('SELECT * FROM later WHERE done_at IS NULL AND lower(text) = lower(?) LIMIT 1').get(t);
    if (dup) {
      this.db.prepare('UPDATE later SET due_at = ?, rang_at = NULL, note = COALESCE(?, note), updated_at = ? WHERE id = ?').run(due, n, at, dup.id);
      this.emit('later');
      return this.laterItem(dup.id);
    }
    const r = this.db.prepare(`INSERT INTO later (text, note, client, added_by, chat_id, message_id, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t, n, cl, String(by), chatId == null ? null : String(chatId), mid, due, at, at);
    this.emit('later');
    return this.laterItem(r.lastInsertRowid);
  }

  // Patch: text, note, due_at (null parks it with no date), done (true or false, for Undo).
  laterUpdate(id, patch = {}) {
    const cur = this.db.prepare('SELECT * FROM later WHERE id = ?').get(Number(id));
    if (!cur) throw new HttpError(404, 'no such item');
    const sets = [];
    const vals = [];
    if ('text' in patch) { sets.push('text = ?'); vals.push(this.laterText(patch.text)); }
    if ('note' in patch) { sets.push('note = ?'); vals.push(this.laterText(patch.note, 'note', LATER_NOTE_MAX)); }
    if ('due_at' in patch) { sets.push('due_at = ?', 'rang_at = NULL'); vals.push(this.laterDueAt(patch.due_at)); }
    if ('done' in patch) { sets.push('done_at = ?'); vals.push(patch.done ? (cur.done_at ?? this.now()) : null); }
    if (!sets.length) return this.laterRow(cur);
    sets.push('updated_at = ?');
    vals.push(this.now());
    this.db.prepare(`UPDATE later SET ${sets.join(', ')} WHERE id = ?`).run(...vals, cur.id);
    this.emit('later');
    return this.laterItem(cur.id);
  }

  laterDelete(id) {
    const r = this.db.prepare('DELETE FROM later WHERE id = ?').run(Number(id));
    if (!r.changes) throw new HttpError(404, 'no such item');
    this.emit('later');
  }

  // Due and not rung yet: the app pushes each one once.
  laterToRing(now = this.now()) {
    return this.db.prepare('SELECT * FROM later WHERE done_at IS NULL AND rang_at IS NULL AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at')
      .all(now).map((r) => this.laterRow(r));
  }

  laterRang(id) { this.db.prepare('UPDATE later SET rang_at = ? WHERE id = ?').run(this.now(), Number(id)); }

  // ── health ────────────────────────────────────────────────────────────────

  healthCheck() {
    const at = String(this.now());
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('health', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(at);
    return this.db.prepare(`SELECT value FROM meta WHERE key = 'health'`).get()?.value === at;
  }
}
