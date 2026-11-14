#!/usr/bin/env node
// Zero-dependency mock of Holler's Human API (docs/design.md) for building and testing web/ without
// the real server. Serves web/ statically, keeps everything in memory, never writes to disk.
//
//   node tools/mock-server.mjs --port 8790 [--host 127.0.0.1] [--no-push] [--chatty] [--later]
//
// Test hooks:
//   POST /mock/inject {chat_id, sender, text, buttons?, typing_ms?, status?, photo?}  a bot types, then posts
//   GET  /mock/drop      closes every live event stream (tests reconnect and resync)
//   POST /mock/stall {chat_id, state?, bot?}   marks Alex's newest message there as not picked up (or failed)
//   POST /mock/system {level, headline, checks?}   what GET /api/system answers (null = all good)
//   POST /mock/claude {running?, queued?}      Claude sessions on GET /api/runs
//   POST /mock/work {chat_id?, sender?, work, id?, pdf?}   posts a work card (or, with id, changes it in place; 11-11)
//   GET  /mock/commands   the Stop / Start fresh commands sent so far
//   GET  /mock/signout   every /api call answers 401 until GET /mock/signin or POST /api/login
//   POST /api/login {code}  any code signs in, except "bad", "expired" or "used" (403)
//   A message containing "#fail" gets a 500 the first time (tests Not Delivered and retry).
//   Ask a bot for a "card", "photo" or "markdown" to get that kind of reply.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const PORT = Number(arg('port', 8790));
const HOST = arg('host', '127.0.0.1');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// ── team: the test team (test/fixtures/team.json), or your own with VESPER_TEAM=<path> ──────────
process.env.VESPER_TEAM ||= path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'team.json');
const TEAM = await import('../server/team.mjs');
const members = TEAM.MEMBERS.map(({ profile, ...m }, i, all) => ({ ...m, online: i < all.length - 1 || all.length < 3 }));
const ME = TEAM.HUMAN;
const BOTS = members.filter((m) => m.kind === 'bot').map((m) => m.id);
const nameOf = (id) => members.find((m) => m.id === id)?.name || id;
const chats = [
  { id: 'room', kind: 'room', title: TEAM.ROOM_TITLE, members: members.map((m) => m.id) },
  ...BOTS.map((b) => ({ id: `dm-${b}`, kind: 'dm', title: nameOf(b), members: [ME, b] })),
];
const REACTIONS = new Set(['❤️', '👍', '👎', '😂', '‼️', '❓']);

// ── storage (memory only) ──────────────────────────────────────────────────
let nextId = 1;
const byId = new Map();
const perChat = new Map(chats.map((c) => [c.id, []]));
const reads = new Map(chats.map((c) => [c.id, {}])); // chatId -> {memberId: lastId}
const files = new Map();
const failedOnce = new Set();
let signedOut = false;

function msgOut(m) {
  return { ...m, reactions: m.reactions.map((r) => ({ ...r })), attachments: m.attachments.map((a) => ({ ...a })) };
}

// Routines for the Runs screen and agent pages.
const at = (hh, mm, dayOff = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOff); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
const mockJobs = [
  { bot: 'ada', id: 'a1b2c3d4e5f6', name: 'Morning briefing call', schedule: '45 7 * * 1-5', hh: 7, mm: 45, tokens: 182000 },
  { bot: 'ada', id: 'a1b2c3d4e5f7', name: 'Daily wrap', schedule: '0 17 * * 1-5', hh: 17, mm: 0, tokens: 240000 },
  { bot: 'ben', id: 'b1b2c3d4e5f6', name: 'Morning sweep', schedule: '50 7 * * 1-5', hh: 7, mm: 50, tokens: 699000 },
  { bot: 'ben', id: 'b1b2c3d4e5f7', name: 'End of day check-in', schedule: '45 16 * * 1-5', hh: 16, mm: 45, tokens: 120000 },
  { bot: 'cleo', id: 'c1b2c3d4e5f6', name: 'Dune feed run', schedule: '30 11 * * *', hh: 11, mm: 30, tokens: 310000 },
  { bot: 'dora', id: 'd1b2c3d4e5f6', name: 'Fjord weekly report', schedule: '0 14 * * 4', hh: 14, mm: 0, tokens: 520000, failed: true },
  { bot: 'eli', id: 'e1b2c3d4e5f6', name: 'Prospect scan', schedule: '7 8 * * 1-5', hh: 8, mm: 7, tokens: 260000 },
  { bot: 'ben', id: 'b1b2c3d4e5f8', name: 'Client watch', schedule: '*/10 8-20 * * *', hh: 8, mm: 0, tokens: 90000, watch: true },
  { bot: 'ben', id: 'b1b2c3d4e5f9', name: 'Friday: Hal\u2019s filter sales sheet', schedule: 'once at 2026-11-06 09:00', hh: 9, mm: 0, tokens: 0, finished: true },
].map((j) => ({ ...j, paused: false }));
// 11-09: Claude sessions the bots started, the System list, and the commands the app sent.
let mockClaude = { running: [], queued: [], today: 3, stopped: false };
let mockSystem = null;
const mockCommands = [];
const systemOut = () => mockSystem || { at: Date.now(), level: 'ok', build: 'mock', headline: 'Everything is running', checks: [
  { key: 'server', label: 'Vesper', level: 'ok', detail: 'Running since 8:02 AM' },
  ...members.filter((x) => x.kind === 'bot').map((b) => ({ key: `bot:${b.id}`, label: b.name, level: 'ok', detail: 'Connected since 8:02 AM' })),
  { key: 'delivery', label: 'Your messages', level: 'ok', detail: 'Every message reached its bot' },
  { key: 'push', label: 'Notifications', level: 'ok', detail: '2 devices will ring' },
  { key: 'approvals', label: 'Approval cards', level: 'ok', detail: 'The card service is running' },
  { key: 'claude', label: 'Claude sessions', level: 'ok', detail: '3 started today' },
  { key: 'backup', label: 'Backup', level: 'ok', detail: 'Saved and copied off the Mac Mon 3:20 AM' },
  { key: 'disk', label: 'Mac disk', level: 'ok', detail: '15 GB free' }] };
function mockRuns() {
  const now = new Date();
  const bots = ['ada', 'ben', 'cleo', 'dora', 'eli'].map((id) => {
    const jobs = mockJobs.filter((j) => j.bot === id).map((j) => {
      const todayAt = new Date(at(j.hh, j.mm));
      const ran = todayAt < now;
      return {
        id: j.id, bot: id, name: j.name, schedule: j.schedule, paused: j.paused, model: 'openai/gpt-6.1-sol', finished: !!j.finished, once: !!j.finished,
        next_at: j.paused || j.finished ? null : (ran ? at(j.hh, j.mm, 1) : at(j.hh, j.mm)), last_at: j.finished ? at(j.hh, j.mm, -3) : ran ? at(j.hh, j.mm) : at(j.hh, j.mm, -1),
        last_status: j.failed ? 'error' : 'ok', last_error: j.failed ? 'Google Ads asked for a verification code; the run stopped.' : null, failures: j.failed ? 1 : 0,
        prompt: j.prompt || `${j.name}. Check every client you own, say what changed since the last run, and post it to Alex in plain words.`, quiet: !!j.quiet,
        week: { runs: 5, failed: j.failed ? 1 : 0, tokens: j.tokens, ms: 5 * 41000 },
      };
    });
    const today = jobs.filter((j) => Date.parse(j.last_at) > new Date().setHours(0, 0, 0, 0))
      .flatMap((j) => Array.from({ length: mockJobs.find((x) => x.id === j.id).watch ? 12 : 1 }, (_, k) => ({ job_id: j.id, bot: id, status: j.last_status === 'ok' ? 'completed' : 'failed', started_at: new Date(Date.parse(j.last_at) + k * 600000).toISOString(), finished_at: j.last_at, error: j.last_error })));
    for (const j of jobs) j.woke_today = mockJobs.find((x) => x.id === j.id).watch ? 2 : 0;
    // Runs that woke the bot today (the Runs day strip): each finished routine, plus watch wakes.
    const activity = today.filter((r, k) => !mockJobs.find((x) => x.id === r.job_id)?.watch || k % 6 === 0)
      .map((r) => ({ at: Date.parse(r.started_at), job_id: r.job_id, error: r.status === 'failed' }));
    return { id, jobs, week: { runs: jobs.length * 5, failed: jobs.filter((j) => j.last_status !== 'ok').length, tokens: jobs.reduce((n, j) => n + j.week.tokens, 0) }, today, activity };
  });
  return { at: Date.now(), bots, claude: mockClaude };
}

function addMessage({ chat_id, sender, text = '', at = Date.now(), kind, reply_to = null, buttons = null, resolved = null, attachments = [], client_id = null, reactions = [] }) {
  const m = {
    id: nextId++,
    chat_id,
    sender,
    text,
    at,
    edited_at: null,
    kind: kind || (buttons ? 'card' : 'text'),
    reply_to: reply_to ? { id: reply_to.id, sender: reply_to.sender, text: String(reply_to.text || '').slice(0, 280), ...(reply_to.kind === 'work' ? { work: true } : {}) } : null,
    buttons,
    resolved,
    attachments,
    reactions,
  };
  if (client_id && sender === ME) m.client_id = client_id;
  if (reply_to?.kind === 'work' && sender === ME) m.to_claude = true;
  byId.set(m.id, m);
  perChat.get(chat_id).push(m);
  return m;
}

// ── a generated PNG (bar chart) so the seed has a real image attachment ───
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function chartPng() {
  const W = 480, H = 320;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const vals = [5, 8, 4, 9, 7, 12, 14];
  const mix = (a, b, t) => Math.round(a + (b - a) * t);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      let r = 250, g = 251, b = 250;
      if (y > 40 && y < 280 && (y - 40) % 60 === 0) { r = 228; g = 232; b = 230; }
      const i = Math.floor((x - 40) / 58);
      const bx = (x - 40) % 58;
      if (i >= 0 && i < 7 && bx >= 10 && bx < 46) {
        const top = 280 - vals[i] * 16;
        const cx = Math.min(bx - 10, 45 - bx);
        const corner = cx < 6 && y - top < 6 && Math.hypot(6 - cx, 6 - (y - top)) > 6;
        if (y >= top && y < 280 && !corner) {
          const t = (y - top) / Math.max(1, 280 - top);
          r = mix(123, 31, t); g = mix(224, 166, t); b = mix(122, 90, t);
          if (i === 6) { r = mix(47, 14, t); g = mix(211, 143, t); b = mix(198, 214, t); }
        }
      }
      if (y >= 280 && y < 282 && x > 40 && x < 446) { r = 190; g = 196; b = 192; }
      raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let previewHits = 0, originalHits = 0;
function addFile(name, type, buf) {
  const id = crypto.randomBytes(16).toString('hex');
  const f = { id, name, type, size: buf.length, url: `/files/${id}`, buf };
  files.set(id, f);
  // Pictures carry their shape and a preview address, as the real server sends them (11-06); the mock's
  // preview is the same bytes.
  const png = type === 'image/png' && buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR';
  return { id, name, type, size: buf.length, url: f.url, ...(png ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), preview: `${f.url}/p` } : {}) };
}

// ── seed: ten days of room history plus hand-written recent threads ────────
function seed() {
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const day = (d, hh, mm) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(hh, mm, 0, 0); return t.getTime(); };
  const now = Date.now();
  const lines = {
    ada: ['Morning. Board is up to date.', 'Gale routines ran clean overnight.', 'Two callbacks on the calendar for this afternoon.', 'I moved the Friday corner post to 10 AM.', 'All five bots checked in.', 'HQ deploy went through, probes green.', 'Reminder: invoices go out Friday.'],
    ben: ['Acme lighting ads spent $18 yesterday, 3 leads.', 'Birch card options are on the pick board.', 'Cedar feed is scheduled through the 14th.', 'Acme asked about a fall promo, drafting one.', 'Birch testimonial cut is ready for review.', 'Posted the Cedar reel, 1.2k views so far.'],
    cleo: ['Dune Sunday lineup: 5 trucks confirmed.', 'Ember sent new shop photos, sorting them.', 'Feed run for Dune is queued.', 'Two vendors asked for host credit, logged it.', 'Ember wants a before and after carousel.'],
    dora: ['Fjord: 9 leads this week so far.', 'Search terms cleaned, added 6 negatives.', 'CPL is holding at $31.', 'Fjord asked for a call recap, sent it.', 'Budget pacing is on track for the month.'],
    eli: ['Walk-in route for Thursday: 34 plazas.', 'Scraped 120 new prospects in Fairview.', '12 follow-ups due today.', 'Two prospects replied to the checkup offer.', 'Dialer list refreshed for tomorrow.'],
    alex: ['Good.', 'Thanks.', 'Keep me posted.', 'Let me look tonight.', 'Send it.', 'Hold that one.', 'Nice work.', 'What do we need from me?'],
  };
  const events = [];
  const push = (e) => { events.push(e); return e; };
  for (let d = 10; d >= 2; d--) {
    for (const [hh, mm] of [[8, 0], [12, 20], [16, 5]]) {
      let t = day(d, hh, mm);
      const n = 14 + Math.floor(rnd() * 8);
      let sender = 'ada';
      for (let i = 0; i < n; i++) {
        if (i > 0 && rnd() < 0.55) sender = pick([...BOTS, ME, ME]);
        push({ chat_id: 'room', sender, text: pick(lines[sender]), at: t });
        t += (20 + Math.floor(rnd() * 160)) * 1000;
      }
    }
  }
  // Yesterday afternoon.
  push({ chat_id: 'room', sender: ME, text: 'Where are we on the Birch Mechanical card options?', at: day(1, 16, 4) });
  push({ chat_id: 'room', sender: 'ben', text: 'Four options are on the pick board. Option 2 tested best with the office crew.', at: day(1, 16, 5) });
  push({ chat_id: 'room', sender: 'ben', text: 'Want me to print proofs of 2 and 4?', at: day(1, 16, 5) + 20000 });
  push({ chat_id: 'room', sender: ME, text: 'Hold until I look tonight.', at: day(1, 16, 7) });
  push({ chat_id: 'room', sender: 'cleo', text: 'Dune Dune Sunday lineup is drafted. 6 trucks confirmed, 2 pending.', at: day(1, 16, 9), reactions: [{ member_id: ME, emoji: '❤️' }] });
  push({ chat_id: 'room', sender: 'ada', text: 'Approval needed: restart the launchd job `com.example.lead-desk` on the Mac.', at: day(1, 18, 30), buttons: [[{ label: 'Approve once', data: 'appr:r1:once', style: 'primary' }, { label: 'Deny', data: 'appr:r1:deny', style: 'danger' }]], resolved: { label: 'Approve once', data: 'appr:r1:once', style: 'primary', by: ME, at: day(1, 18, 34) } });
  push({ chat_id: 'room', sender: 'ada', text: 'Restarted. Lead Desk is back up.', at: day(1, 18, 35) });
  // Today.
  const t0 = now - 4 * 3600 * 1000;
  push({ chat_id: 'room', sender: 'ada', at: t0, text: '**Morning board** for today\n\n1. Oakline walkthrough tomorrow at 10 AM, prints done\n2. Fjord ads: CPL down 12% week over week\n3. Thursday walk-in route is ready\n\n- _Blocked:_ BotFather cap for Eli\n- `holler` server build in progress\n\nFull board: [HQ](https://example.com/board)' });
  push({ chat_id: 'room', sender: 'dora', at: t0 + 60000, text: 'Fjord update: 14 leads this week, 3 booked. Search is carrying it.' });
  push({ chat_id: 'room', sender: 'dora', at: t0 + 75000, text: 'Here is the week.', attachments: [addFile('fjord-leads-week.png', 'image/png', chartPng())], reactions: [{ member_id: ME, emoji: '👍' }, { member_id: 'ada', emoji: '‼️' }] });
  const hankRoute = push({ chat_id: 'room', sender: 'eli', at: t0 + 30 * 60000, text: 'Thursday route has 36 stops, all plazas near the office. Printing a copy for the clipboard.' });
  push({ chat_id: 'room', sender: ME, at: t0 + 33 * 60000, text: 'Perfect. Print it tonight.', replyRef: hankRoute });
  push({ chat_id: 'room', sender: 'cleo', at: t0 + 90 * 60000, text: 'Feed run for Dune is scheduled. Command I used:\n```\npostiz schedule --brand dune --from 2026-10-28 --count 12 --time 11:30\n```\nAll 12 posts land at 11:30 AM. *Two* still need captions.' });
  push({ chat_id: 'room', sender: 'ben', at: now - 40 * 60000, text: 'Approval needed: run `npm install web-push@3.6.7` in ~/holler/server?', buttons: [[{ label: 'Approve once', data: 'appr:x:once', style: 'primary' }, { label: 'Deny', data: 'appr:x:deny', style: 'danger' }]] });
  push({ chat_id: 'room', sender: 'eli', at: now - 12 * 60000, text: 'Two prospects replied to the checkup offer. One wants a call Thursday.' });

  // DMs.
  push({ chat_id: 'dm-ada', sender: ME, at: day(2, 9, 10), text: 'Can you pull the week for Gale?' });
  push({ chat_id: 'dm-ada', sender: 'ada', at: day(2, 9, 12), text: 'On it. Bots ran **41 routines**, 2 retries, no failures.' });
  push({ chat_id: 'dm-ada', sender: 'ada', at: day(2, 9, 12) + 30000, text: 'Want me to send the recap to him?' });
  push({ chat_id: 'dm-ada', sender: ME, at: day(2, 9, 20), text: 'Draft it, I will send it.' });
  push({ chat_id: 'dm-ada', sender: 'ada', at: now - 3 * 3600 * 1000, text: 'Draft is in your Gmail drafts.' });
  push({ chat_id: 'dm-ada', sender: ME, at: now - 3 * 3600 * 1000 + 90000, text: '🙏' });
  push({ chat_id: 'dm-ada', sender: 'ada', at: now - 50 * 60000, text: 'Gale replied, he signed off on the recap.' });
  push({ chat_id: 'dm-ada', sender: 'ada', at: now - 50 * 60000 + 30000, text: '🎉🎉' });
  push({ chat_id: 'dm-ada', sender: ME, at: now - 6 * 60000, text: 'Send it.' });

  push({ chat_id: 'dm-ben', sender: 'ben', at: day(1, 10, 0), text: 'Acme wants to run the lighting ads one more week.' });
  push({ chat_id: 'dm-ben', sender: ME, at: day(1, 10, 3), text: 'Fine by me. Same budget.' });
  push({ chat_id: 'dm-ben', sender: 'ben', at: now - 25 * 60000, text: 'Approval needed: post the Cedar reel to Instagram now?', buttons: [[{ label: 'Approve once', data: 'appr:ws:once', style: 'primary' }, { label: 'Deny', data: 'appr:ws:deny', style: 'danger' }]] });

  push({ chat_id: 'dm-cleo', sender: 'cleo', at: day(3, 14, 0), text: 'Ember sent 40 new photos. I picked 8 for the feed.' });
  push({ chat_id: 'dm-cleo', sender: ME, at: day(3, 14, 30), text: 'Show me the 8 tomorrow.' });
  push({ chat_id: 'dm-cleo', sender: 'cleo', at: now - 4 * 60000, text: '**Dune Dune**: tell the vendors the Truck Meet starts at 5 PM (#412)\n\nText to 9 vendors:\n"Truck Meet update: we now open at 5 PM Saturday. Same spot, same setup time."', buttons: [[{ label: 'Approve', data: 'a|412|h', style: 'primary' }, { label: 'Always: Dune vendor updates', data: 'w|412|h', style: '' }, { label: 'Decline', data: 'n|412|h', style: 'danger' }]] });

  push({ chat_id: 'dm-dora', sender: 'dora', at: now - 2 * 3600 * 1000, text: 'Fjord asked if we can add a Saturday call window. Want me to set it up?' });
  // Vesper 10-30: a finished text with a Stripe link, a bot pointing at a card, a link with a preview.
  push({ chat_id: 'dm-ben', sender: 'ben', at: now - 50 * 60000, text: '**Acme Pressure Washing**: Send Pat his $375 payment link (#91)\n\nText to Pat (ends 0117):\n"Hey Pat, here\'s the $375 payment link: https://buy.stripe.com/test_00example0001\n\nThat covers the lighting week and the applicant campaign."\n\nSent. Texted Pat at 2:00 PM.' });
  push({ chat_id: 'dm-cleo', sender: 'cleo', at: now - 3 * 60000, text: 'Two vendors asked about parking, so card #412 now says the lot opens at 4:30.' });
  push({ chat_id: 'dm-dora', sender: 'dora', at: now - 75 * 60000, text: 'The new repair page is live: https://fjorddoors.example/garage-door-repair' });
  push({ chat_id: 'dm-dora', sender: 'dora', at: now - 70 * 60000, text: '**Fjord**: send the weekly report (#418)\n\nEmail to Ron at Fjord\nSubject: Week of Oct 26\n"Calls are up 18% this week and cost per lead is $23.10. Full report attached."', buttons: [[{ label: 'Approve', data: 'a|418|h', style: 'primary' }, { label: 'Decline', data: 'n|418|h', style: 'danger' }]] });

  push({ chat_id: 'dm-eli', sender: ME, at: day(1, 19, 0), text: 'How many stops on Thursday?' });
  push({ chat_id: 'dm-eli', sender: 'eli', at: day(1, 19, 1), text: '36, all plazas.' });

  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    const { replyRef, ...rest } = e;
    const m = addMessage({ ...rest, reply_to: replyRef ? byId.get(replyRef._id) : null });
    e._id = m.id;
  }
  // Reads: bots have read everything; Alex has a few unread.
  for (const c of chats) {
    const list = perChat.get(c.id);
    const last = list[list.length - 1];
    for (const b of BOTS) if (c.members.includes(b)) reads.get(c.id)[b] = last?.id || 0;
    const unread = { room: 2, 'dm-ben': 1, 'dm-dora': 1 }[c.id] || 0;
    reads.get(c.id)[ME] = list[list.length - 1 - unread]?.id || 0;
  }
}
seed();

// ── live stream ────────────────────────────────────────────────────────────
const streams = new Set();
// Later (11-06), with --later: one reminder due an hour ago (Needs you), two coming up, one parked with no date.
// Off by default so the main checks (tools/shots.mjs) keep the chat rows on screen.
const HOUR = 3600000;
let laterSeq = 10;
let laterItems = !flag('later') ? [] : [
  { id: 1, text: 'Do the pictures for Hal', note: 'Pull them off the office computer and bring them Friday.', client: 'Birch Mechanical', by: 'ben', chat_id: 'dm-ben', message_id: null, due_at: Date.now() - HOUR, created_at: Date.now() - 3 * 86400000, updated_at: Date.now(), done_at: null },
  { id: 2, text: 'Send Reed the DEN screen text', note: null, client: null, by: 'ben', chat_id: 'dm-ben', message_id: null, due_at: Date.now() + 26 * HOUR, created_at: Date.now() - 86400000, updated_at: Date.now(), done_at: null },
  { id: 3, text: 'Look at the gas logs lead ads budget', note: null, client: null, by: 'ada', chat_id: 'dm-ada', message_id: null, due_at: Date.now() + 4 * 86400000, created_at: Date.now() - 86400000, updated_at: Date.now(), done_at: null },
  { id: 4, text: 'Weekend photo studio idea', note: null, client: null, by: 'alex', chat_id: null, message_id: null, due_at: null, created_at: Date.now() - 2 * 86400000, updated_at: Date.now(), done_at: null },
];
const laterOpen = () => laterItems.filter((x) => !x.done_at).sort((a, b) => ((a.due_at == null) - (b.due_at == null)) || (a.due_at ?? 0) - (b.due_at ?? 0) || b.created_at - a.created_at);
const laterChanged = () => broadcast('later', { items: laterOpen() });

// muted: the open streams get nothing, as a phone's connection does while iOS has the app frozen (/mock/mute).
let muted = new Set();
const net = { eventsDelay: 0, messagesDelay: 0, messagesFail: 0 };
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) { if (muted.has(res)) continue; try { res.write(line); } catch { /* closed */ } }
}
setInterval(() => { for (const res of streams) { try { res.write('event: ping\ndata: {}\n\n'); } catch { /* closed */ } } }, 15000).unref();

const typingNow = new Map(); // `${chat}:${member}` -> status
function typing(chat_id, member_id, on, status = null) {
  const k = `${chat_id}:${member_id}`;
  if (on) typingNow.set(k, status); else typingNow.delete(k);
  broadcast('typing', { chat_id, member_id, on, status: on ? status : null });
}

// ── bot behavior ───────────────────────────────────────────────────────────
const STATUSES = {
  ada: ['Checking the board', 'Reading HQ clients'],
  ben: ['Reading HQ clients', 'Opening the Acme journal'],
  cleo: ['Looking at Postiz', 'Sorting Ember photos'],
  dora: ['Pulling Fjord numbers', 'Reading the ads journal'],
  eli: ['Scanning the lead sheet', 'Checking the dialer list'],
};
const REPLIES = {
  ada: ['On it. I will post an update in the room when it is done.', 'Got it. Added to the board for today.', 'Done. Everything else is on schedule.'],
  ben: ['Will do. Acme and Birch are both quiet today.', 'Got it. I will have a draft in an hour.', 'Checked: Cedar posts are all scheduled.'],
  cleo: ['Sure thing. Dune is set through Sunday.', 'On it. Ember photos are sorted by tomorrow.', 'Noted. I will ping the vendors.'],
  dora: ['Will do. Fjord numbers look steady.', 'Got it. I will adjust the budget pacing.', 'Done. Call window added.'],
  eli: ['On it. Route is printed.', 'Got it. I will add them to the dialer list.', 'Will do. Three more replies came in.'],
};
let replyCount = 0;

function addressed(chat, m) {
  if (chat.kind === 'dm') return chat.members.filter((x) => x !== ME);
  const text = m.text || '';
  if (/(^|\s)@all\b/i.test(text)) return [...BOTS];
  const out = new Set();
  for (const b of BOTS) {
    const n = nameOf(b);
    if (new RegExp(`(^|\\s)@${n}\\b`, 'i').test(text) || new RegExp(`^\\s*${n}\\b`, 'i').test(text)) out.add(b);
  }
  if (m.reply_to && BOTS.includes(m.reply_to.sender)) out.add(m.reply_to.sender);
  if (!out.size) out.add('ada');
  return [...out];
}

function botReply(chat, bot, trigger, delay = 0) {
  const n = replyCount++;
  const status = n % 2 === 0 ? STATUSES[bot][n % STATUSES[bot].length] : null;
  const t = trigger.text || '';
  setTimeout(() => {
    reads.get(chat.id)[bot] = trigger.id;
    broadcast('read', { chat_id: chat.id, member_id: bot, last_id: trigger.id });
  }, delay + 900);
  setTimeout(() => typing(chat.id, bot, true, status), delay + 1500);
  if (status) setTimeout(() => typing(chat.id, bot, true, STATUSES[bot][(n + 1) % STATUSES[bot].length]), delay + 2600);
  setTimeout(() => {
    typing(chat.id, bot, false);
    let reply;
    if (/\bcard\b/i.test(t)) {
      reply = { text: 'Approval needed: send the weekly recap email to the client?', buttons: [[{ label: 'Approve once', data: `appr:${Date.now()}:once`, style: 'primary' }, { label: 'Deny', data: `appr:${Date.now()}:deny`, style: 'danger' }]] };
    } else if (/\b(photo|chart|image)\b/i.test(t)) {
      reply = { text: 'Here is the latest chart.', attachments: [addFile('chart.png', 'image/png', chartPng())] };
    } else if (/\b(markdown|long|list)\b/i.test(t)) {
      reply = { text: '**Here is the rundown**\n\n- First, the _quick_ wins\n- Then the `config` change\n  - nested detail\n\n1. Check\n2. Ship\n\n```js\nconst holler = await fetch("/api/bootstrap");\n```\nMore at https://example.com/notes.' };
    } else {
      reply = { text: REPLIES[bot][n % REPLIES[bot].length] };
    }
    const m = addMessage({ chat_id: chat.id, sender: bot, at: Date.now(), ...reply, reply_to: chat.kind === 'room' && trigger.sender === ME && n % 3 === 0 ? trigger : null });
    for (const b of chat.members) if (b !== ME) reads.get(chat.id)[b] = Math.max(reads.get(chat.id)[b] || 0, m.id);
    broadcast('message', { message: msgOut(m) });
  }, delay + 3600);
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

let lastSealed = null;
const mockRules = { botToBot: true, chainCap: 4, muted: [] };
const mockClients = [
  { id: 2, short: 'Acme', name: 'Acme Pressure Washing', bot: 'ben', paused: false, since: null },
  { id: 5, short: 'Birch', name: 'Birch Mechanical', bot: 'ben', paused: false, since: null },
  { id: 13, short: 'Cedar', name: 'Cedar Boutique', bot: 'ben', paused: false, since: null },
  { id: 10, short: 'Dune', name: 'Dune Eats', bot: 'cleo', paused: false, since: null },
  { id: 11, short: 'Ember', name: 'Ember Custom', bot: 'cleo', paused: false, since: null },
  { id: 9, short: 'Fjord', name: 'Fjord Garage Doors', bot: 'dora', paused: false, since: null },
  { id: 14, short: 'Gale', name: 'Gale Capital (Gale)', bot: 'ada', paused: false, since: null },
];
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function chatSummary(c) {
  const list = perChat.get(c.id);
  const readId = reads.get(c.id)[ME] || 0;
  return {
    ...c,
    last: list.length ? msgOut(list[list.length - 1]) : null,
    unread: list.filter((m) => m.id > readId && m.sender !== ME).length,
  };
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return send(res, 400, 'bad path'); }
  const full = path.resolve(ROOT, path.normalize(rel));
  if (!full.startsWith(ROOT + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const m = req.method;
  let r;

  // Mock controls.
  if (p === '/mock/signout') { signedOut = true; return send(res, 200, { ok: true, signedOut }); }
  if (p === '/mock/signin') { signedOut = false; return send(res, 200, { ok: true, signedOut }); }
  // How many picture downloads were originals and how many previews (pictures, 11-06).
  if (p === '/mock/file-hits') { const out = { originals: originalHits, previews: previewHits }; if (url.searchParams.has('reset')) originalHits = previewHits = 0; return send(res, 200, out); }
  // A slow or flaky phone network after waking (11-06): {eventsDelay, messagesDelay, messagesFail} in ms / count.
  if (p === '/mock/net' && m === 'POST') { Object.assign(net, { eventsDelay: 0, messagesDelay: 0, messagesFail: 0 }, await readJson(req)); return send(res, 200, net); }
  // Freeze every stream open now without closing it (the app's connection looks alive but hears nothing).
  if (p === '/mock/mute') { muted = new Set(streams); return send(res, 200, { muted: muted.size }); }
  if (p === '/mock/drop') { const n = streams.size; for (const s of streams) s.destroy(); streams.clear(); return send(res, 200, { dropped: n }); }
  if (p === '/mock/last-sealed' && m === 'GET') return send(res, 200, { sealed: lastSealed });
  if (p === '/mock/commands' && m === 'GET') return send(res, 200, { commands: mockCommands });
  if (p === '/mock/system' && m === 'POST') { const b = await readJson(req); mockSystem = b && b.level ? { at: Date.now(), build: 'mock', checks: [], ...b } : null; return send(res, 200, systemOut()); }
  if (p === '/mock/claude' && m === 'POST') { mockClaude = { running: [], queued: [], today: 3, stopped: false, ...(await readJson(req)) }; return send(res, 200, mockClaude); }
  if (p === '/mock/work' && m === 'POST') {
    const b = await readJson(req);
    const words = { queued: 'Waiting to start', working: 'Working', done: 'Finished', needs_you: 'Needs you', failed: 'Did not finish', stopped: 'Stopped' };
    const textOf = (w) => [`Claude: ${w.title}`, words[w.state] || w.state, w.result || ''].filter(Boolean).join('\n');
    const pdf = () => [addFile(b.pdf, 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'))];
    if (b.id) {
      const msg = byId.get(Number(b.id));
      if (!msg || msg.kind !== 'work') return send(res, 404, { error: 'no such work card' });
      const next = { ...msg.work };
      for (const [k, v] of Object.entries(b.work || {})) { if (v == null) delete next[k]; else next[k] = v; }
      if (msg.work.state !== next.state && !['done', 'needs_you', 'failed', 'stopped'].includes(next.state)) delete next.acked_at;
      msg.work = next; msg.text = textOf(next); msg.edited_at = Date.now();
      if (b.pdf) msg.attachments = pdf();
      broadcast('update', { message: msgOut(msg) });
      return send(res, 200, { message: msgOut(msg) });
    }
    const chat_id = b.chat_id || 'dm-ben';
    const msg = addMessage({ chat_id, sender: b.sender || chat_id.replace(/^dm-/, ''), text: textOf(b.work), kind: 'work', attachments: b.pdf ? pdf() : [] });
    msg.work = { ...b.work };
    broadcast('message', { message: msgOut(msg) });
    return send(res, 200, { message: msgOut(msg) });
  }
  if (p === '/mock/stall' && m === 'POST') {
    const b = await readJson(req);
    const mine = (perChat.get(String(b.chat_id)) || []).filter((x) => x.sender === ME).at(-1);
    if (!mine) return send(res, 404, { error: 'no message of his there' });
    mine.delivery = { state: b.state || 'stalled', bot: b.bot || String(b.chat_id).replace(/^dm-/, ''), tries: 1 };
    broadcast('update', { message: msgOut(mine) });
    return send(res, 200, { message: msgOut(mine) });
  }
  if (p === '/mock/inject' && m === 'POST') {
    const b = await readJson(req);
    const chat = chats.find((c) => c.id === b.chat_id);
    if (!chat || !BOTS.includes(b.sender)) return send(res, 400, { error: 'chat_id and a bot sender required' });
    const wait = Number(b.typing_ms ?? 1500);
    if (wait > 0) typing(chat.id, b.sender, true, b.status || null);
    setTimeout(() => {
      typing(chat.id, b.sender, false);
      const msg = addMessage({ chat_id: chat.id, sender: b.sender, text: String(b.text || ''), buttons: b.buttons || null,
        attachments: b.photo ? [addFile('creative.png', 'image/png', chartPng())] : [] });
      broadcast('message', { message: msgOut(msg) });
    }, Math.max(0, wait));
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/login') {
    const b = await readJson(req);
    const raw = String(b.code || '').trim();
    const code = (/[?&#]code=([^&#\s]+)/.exec(raw) || /\/login\/([^/?#\s]+)/.exec(raw) || [null, raw])[1];
    await delay(400);
    if (!code) return send(res, 400, { error: 'Paste the code from the sign-in link.' });
    if (/^(bad|expired|used)$/i.test(code)) return send(res, 403, { error: 'That code has expired or was already used.' });
    signedOut = false;
    return send(res, 200, { ok: true }, { 'set-cookie': 'holler_sid=mock; Path=/; HttpOnly; SameSite=Strict' });
  }
  if (p.startsWith('/api/') && signedOut) return send(res, 401, { error: 'signed out' });
  if (p.startsWith('/files/')) {
    if (signedOut) return send(res, 401, 'signed out');
    const [fid, variant] = p.slice(7).split('/');
    const f = !variant || variant === 'p' ? files.get(fid) : null;
    if (!f) return send(res, 404, 'not found');
    if (variant) previewHits++; else originalHits++;
    res.writeHead(200, { 'content-type': f.type, 'content-length': f.size, 'cache-control': 'private, max-age=31536000, immutable' });
    return res.end(f.buf);
  }
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  if (m === 'GET' && p === '/api/bootstrap') {
    return send(res, 200, {
      me: { id: ME, name: nameOf(ME) },
      members: members.map((x) => ({ ...x })),
      team: { ...TEAM.TEAM_VIEW, lead: TEAM.DEFAULT_RESPONDER },
      chats: chats.map(chatSummary),
      typing: [...typingNow.entries()].map(([k, status]) => { const [chat_id, member_id] = k.split(':'); return { chat_id, member_id, status }; }),
      vapidPublicKey: flag('no-push') ? null : VAPID,
      push: { enabled: !flag('no-push') },
      later: laterOpen(),
    });
  }
  if (m === 'GET' && p === '/api/later') return send(res, 200, { items: laterOpen() });
  if (m === 'POST' && p === '/api/later') {
    const b = await readJson(req);
    const text = String(b.text || '').trim();
    if (!text) return send(res, 400, { error: 'text' });
    const item = { id: ++laterSeq, text, note: b.note || null, client: null, by: ME, chat_id: b.chat_id || null, message_id: b.message_id ?? null, due_at: b.due_at ?? null, created_at: Date.now(), updated_at: Date.now(), done_at: null };
    laterItems.push(item);
    laterChanged();
    return send(res, 200, { item });
  }
  if ((r = /^\/api\/later\/(\d+)$/.exec(p))) {
    const item = laterItems.find((x) => x.id === Number(r[1]));
    if (!item) return send(res, 404, { error: 'no such item' });
    if (m === 'DELETE') { laterItems = laterItems.filter((x) => x !== item); laterChanged(); return send(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      const b = await readJson(req);
      if ('due_at' in b) item.due_at = b.due_at;
      if ('text' in b) item.text = b.text;
      if ('done' in b) item.done_at = b.done ? Date.now() : null;
      item.updated_at = Date.now();
      laterChanged();
      return send(res, 200, { item });
    }
  }
  if (m === 'GET' && p === '/api/events') {
    if (net.eventsDelay) await delay(net.eventsDelay);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  if ((r = /^\/api\/chats\/([\w-]+)\/messages$/.exec(p))) {
    if (m === 'GET' && net.messagesFail > 0) { net.messagesFail--; return send(res, 503, { error: 'mock: network waking up' }); }
    if (m === 'GET' && net.messagesDelay) await delay(net.messagesDelay);
    const chat = chats.find((c) => c.id === r[1]);
    if (!chat) return send(res, 404, { error: 'no such chat' });
    const list = perChat.get(chat.id);
    if (m === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      const before = url.searchParams.get('before');
      const older = before ? list.filter((x) => x.id < Number(before)) : list;
      const page = older.slice(-limit);
      await delay(before ? 350 : 120);
      return send(res, 200, { messages: page.map(msgOut), more: older.length > page.length, reads: { ...reads.get(chat.id) } });
    }
    if (m === 'POST') {
      const b = await readJson(req);
      const cid = b.client_id ? String(b.client_id) : null;
      const dup = cid && list.find((x) => x.client_id === cid);
      if (dup) return send(res, 200, { message: msgOut(dup) });
      if (/#fail/i.test(b.text || '') && cid && !failedOnce.has(cid)) { failedOnce.add(cid); await delay(600); return send(res, 500, { error: 'mock failure' }); }
      const text = String(b.text || '');
      const atts = (b.attachments || []).map((id) => files.get(id)).filter(Boolean).map(({ buf, ...f }) => f);
      if (!text.trim() && !atts.length) return send(res, 400, { error: 'empty message' });
      await delay(250);
      const reply = b.reply_to ? byId.get(Number(b.reply_to)) : null;
      const msg = addMessage({ chat_id: chat.id, sender: ME, text, reply_to: reply, attachments: atts, client_id: cid });
      reads.get(chat.id)[ME] = msg.id;
      broadcast('message', { message: msgOut(msg) });
      // A reply to a work card goes to Claude, not to the bot (11-11).
      if (!msg.to_claude) addressed(chat, msg).forEach((bot, i) => botReply(chat, bot, msg, i * 2200));
      return send(res, 200, { message: msgOut(msg) });
    }
  }
  if (m === 'POST' && (r = /^\/api\/chats\/([\w-]+)\/read$/.exec(p))) {
    const b = await readJson(req);
    const rr = reads.get(r[1]);
    if (!rr) return send(res, 404, { error: 'no such chat' });
    if (Number(b.last_id) > (rr[ME] || 0)) { rr[ME] = Number(b.last_id); broadcast('read', { chat_id: r[1], member_id: ME, last_id: rr[ME] }); }
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/react$/.exec(p))) {
    const b = await readJson(req);
    const msg = byId.get(Number(r[1]));
    if (!msg) return send(res, 404, { error: 'no such message' });
    msg.reactions = msg.reactions.filter((x) => x.member_id !== ME);
    if (b.emoji != null) {
      if (!REACTIONS.has(b.emoji)) return send(res, 400, { error: 'unknown reaction' });
      msg.reactions.push({ member_id: ME, emoji: b.emoji });
    }
    broadcast('update', { message: msgOut(msg) });
    return send(res, 200, { message: msgOut(msg) });
  }
  if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/undo$/.exec(p))) {
    const msg = byId.get(Number(r[1]));
    if (!msg || !/^Undo: /m.test(msg.text || '')) return send(res, 400, { error: 'nothing to undo on this card' });
    if (msg.resolved?.undo) return send(res, 409, { error: 'undo already asked' });
    msg.resolved = { ...(msg.resolved || {}), undo: Date.now() };
    broadcast('update', { message: msgOut(msg) });
    return send(res, 200, { message: msgOut(msg) });
  }
  // Change it (11-02): the card closes as Changed, his words go under it, the bot answers.
  if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/change$/.exec(p))) {
    const b = await readJson(req);
    const msg = byId.get(Number(r[1]));
    if (!msg || msg.kind !== 'card') return send(res, 404, { error: 'no such card' });
    if (msg.resolved) return send(res, 409, { error: 'already answered' });
    const text = String(b.text || '').trim();
    if (!text) return send(res, 400, { error: 'say what to do instead' });
    await delay(300);
    msg.resolved = { label: 'Changed', data: 'c', style: '', by: ME, at: Date.now(), change: text.slice(0, 280) };
    msg.edited_at = Date.now();
    broadcast('update', { message: msgOut(msg) });
    const reply = addMessage({ chat_id: msg.chat_id, sender: ME, text, reply_to: msg });
    broadcast('message', { message: msgOut(reply) });
    setTimeout(() => {
      const done = addMessage({ chat_id: msg.chat_id, sender: msg.sender, text: 'Got it. Nothing went out. I’ll redo it that way and put the new version up here.' });
      broadcast('message', { message: msgOut(done) });
    }, 1500);
    return send(res, 200, { message: msgOut(msg), reply: msgOut(reply) });
  }
  if (m === 'POST' && p === '/api/push/test') return send(res, 200, { ok: true, sent: 1, subscribed: 1 });
  if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/work$/.exec(p))) {
    const msg = byId.get(Number(r[1]));
    if (!msg || msg.kind !== 'work') return send(res, 404, { error: 'no such work card' });
    msg.work = { ...msg.work, acked_at: msg.work.acked_at || Date.now() };
    broadcast('update', { message: msgOut(msg) });
    return send(res, 200, { message: msgOut(msg) });
  }
  if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/press$/.exec(p))) {
    const b = await readJson(req);
    const msg = byId.get(Number(r[1]));
    if (!msg) return send(res, 404, { error: 'no such message' });
    const button = (msg.buttons || []).flat().find((x) => x.data === String(b.data));
    if (!button) return send(res, 400, { error: 'no such button' });
    if (msg.resolved) return send(res, 409, { error: 'already answered' });
    if (button.url) return send(res, 400, { error: 'no such button' });
    if (typeof b.sealed === 'string') { if (!/^Sealed: /m.test(msg.text || '')) return send(res, 400, { error: 'this card has no sealed field' }); lastSealed = b.sealed; }
    await delay(700);
    msg.resolved = { label: button.label, data: button.data, style: button.style, by: ME, at: Date.now(), ...(typeof b.edit === 'string' ? { edited: true } : {}), ...(typeof b.sealed === 'string' ? { sealed: true } : {}) };
    if (typeof b.edit === 'string') msg.text = String(msg.text).replace(/"[\s\S]*"\s*$/, `"${b.edit}"`);
    msg.edited_at = Date.now();
    broadcast('update', { message: msgOut(msg) });
    const chat = chats.find((c) => c.id === msg.chat_id);
    const ok = button.style !== 'danger';
    setTimeout(() => typing(chat.id, msg.sender, true, ok ? 'Running the command' : null), 600);
    setTimeout(() => {
      typing(chat.id, msg.sender, false);
      const done = addMessage({ chat_id: chat.id, sender: msg.sender, text: ok ? 'Done. It ran clean.' : 'Okay, skipped it.' });
      broadcast('message', { message: msgOut(done) });
    }, 2400);
    return send(res, 200, { message: msgOut(msg) });
  }
  // Vesper 10-31: Ada's catch-up and the per-client pause switch (server/teamops.mjs), made up.
  if (m === 'GET' && p === '/api/system') return send(res, 200, systemOut());
  if (m === 'GET' && p === '/api/activity') {
    const ago = (h) => Date.now() - h * 3600e3;
    const items = [
      { id: 91, at: ago(0.5), bot: 'ben', who: 'Ben', client: 'Acme', kind: 'text', what: 'confirm Wednesday 2:30 and hold the hour', to: 'Pat', status: 'done', word: 'Sent', auto: false, heard: false, result: 'Texted Pat at 2:12 PM.', look: false },
      { id: 90, at: ago(1), bot: 'dora', who: 'Dora', client: 'Fjord', kind: 'task', what: 'add 12 negatives', to: '', status: 'failed', word: 'Failed', auto: false, heard: false, result: 'Google Ads asked for a code.', look: true },
      { id: 89, at: ago(2), bot: 'ben', who: 'Ben', client: 'Birch', kind: 'text', what: 'reply to Hal about the filter', to: 'Hal', status: 'done', word: 'Sent', auto: true, heard: false, result: 'Texted Hal.', look: false },
      { id: 88, at: ago(3), bot: 'cleo', who: 'Cleo', client: 'Dune', kind: 'task', what: 'post the Sunday lineup', to: '', status: 'posted', word: 'Waiting on you', auto: false, heard: false, result: '', look: true },
      { id: 87, at: ago(26), bot: 'cleo', who: 'Cleo', client: 'Dune', kind: 'task', what: 'Halloween captions', to: '', status: 'done', word: 'Done', auto: false, heard: false, result: '', look: false },
    ];
    return send(res, 200, { since: Number(url.searchParams.get('since')) || ago(12), ok: true, items, counts: { done: 3, auto: 1, failed: 1, waiting: 1 } });
  }
  if (m === 'POST' && (r = /^\/api\/messages\/(\d+)\/redeliver$/.exec(p))) {
    const msg = byId.get(Number(r[1]));
    if (!msg || !msg.delivery) return send(res, 409, { error: 'nothing to send again' });
    delete msg.delivery;
    broadcast('update', { message: msgOut(msg) });
    return send(res, 200, { message: msgOut(msg) });
  }
  if (m === 'POST' && (r = /^\/api\/chats\/([\w-]+)\/command$/.exec(p))) {
    const b = await readJson(req);
    if (!['stop', 'fresh'].includes(b.command)) return send(res, 400, { error: 'no such command' });
    const botId = r[1] === 'room' ? b.bot : r[1].replace(/^dm-/, '');
    if (!BOTS.includes(botId)) return send(res, 400, { error: 'say which bot' });
    mockCommands.push({ chat_id: r[1], bot: botId, command: b.command });
    if (b.command === 'stop') setTimeout(() => typing(r[1], botId, false), 250);
    return send(res, 200, { ok: true, bot: botId, command: b.command, online: members.find((x) => x.id === botId)?.online !== false });
  }
  if (m === 'GET' && p === '/api/catchup') {
    const paused = mockClients.filter((c) => c.paused).map((c) => c.short);
    return send(res, 200, { since: Date.now() - 6 * 3600e3, when: '9:10 AM', paused, summary: '2 done \u00b7 2 sent on their own \u00b7 3 from recordings',
      note: paused.length ? `${paused.join(' and ')} ${paused.length === 1 ? 'is' : 'are'} paused` : null, failed: 0, lines: [
      'Done since 9:10 AM: add 12 negatives (Dora, Fjord) and Halloween captions (Cleo, Dune).',
      '2 replies went out on their own; 3 cards came from your recordings (1 already done, withdrawn).',
      ...(paused.length ? [`${paused.join(' and ')} ${paused.length === 1 ? 'is' : 'are'} paused.`] : [])] });
  }
  if (m === 'GET' && p === '/api/clients') return send(res, 200, { clients: mockClients });
  // 11-11: the client board. Empty here, so the main checks keep their home screen (tools/clienthome-shots.mjs runs the real board).
  if (m === 'GET' && p === '/api/clients/home') return send(res, 200, { at: Date.now(), clients: [], map: {} });
  if (m === 'GET' && p === '/api/room/rules') return send(res, 200, { rules: mockRules });
  if (m === 'POST' && p === '/api/room/rules') {
    const b = await readJson(req);
    if ('botToBot' in b) mockRules.botToBot = !!b.botToBot;
    if ([2, 4, 6, 8].includes(Number(b.chainCap))) mockRules.chainCap = Number(b.chainCap);
    if (Array.isArray(b.muted)) mockRules.muted = b.muted.filter((x) => ['ada', 'ben', 'cleo', 'dora', 'eli'].includes(x));
    return send(res, 200, { rules: mockRules });
  }
  if (m === 'GET' && p === '/api/audit') {
    const at = (h) => Date.now() - h * 3600e3;
    return send(res, 200, { ok: true, items: [
      { id: 80, at: at(2), who: 'Ben', client: 'Acme', kind: 'text', what: 'Sunday post reply', status: 'done', result: 'Texted Pat.', why: 'Auto reply' },
      { id: 79, at: at(5), who: 'Dora', client: 'Fjord', kind: 'task', what: 'pause 3 keywords', status: 'done', result: '', why: 'Always rule' },
      { id: 78, at: at(30), who: 'Cleo', client: 'Dune', kind: 'text', what: 'vendor time update', status: 'stopped', result: '', why: 'Auto reply' },
    ] });
  }
  if (m === 'POST' && (r = /^\/api\/clients\/(\d+)\/pause$/.exec(p))) {
    const b = await readJson(req);
    const c = mockClients.find((x) => x.id === Number(r[1]));
    if (!c) return send(res, 404, { error: 'no such client' });
    Object.assign(c, { paused: !!b.paused, since: b.paused ? new Date().toISOString() : null });
    return send(res, 200, { client: c });
  }
  // Vesper: routines, run history and agent pages (server/hermes.mjs), with made-up data.
  if (m === 'GET' && p === '/api/deliverables') return send(res, 200, { items: [] }); // the real thing: tools/docs-shots.mjs
  if (m === 'GET' && p === '/api/runs') return send(res, 200, mockRuns());
  if (m === 'GET' && (r = /^\/api\/agents\/([a-z]+)$/.exec(p))) {
    const b = mockRuns().bots.find((x) => x.id === r[1]);
    if (!b) return send(res, 404, { error: 'no such bot' });
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return { day: d.toISOString().slice(0, 10), runs: [6, 9, 4, 11, 8, 3, 7][i], failed: i === 3 ? 1 : 0, tokens: [6, 9, 4, 11, 8, 3, 7][i] * 410000 }; });
    return send(res, 200, { id: b.id, jobs: b.jobs, week: { ...b.week, ms: 412000 }, days, memory: { notes: `${r[1]} keeps short notes here.\n§\nAcme prefers calls after 3 PM.\n§\nCedar posts go out at 7:30 PM.`, user: 'Alex wants plain words, no ids.' },
      rules: r[1] === 'ben' ? [{ id: 3, created: Date.now() - 6 * 86400000, client: 'Cedar Wellness', kind: 'posts' }] : [],
      actions: [{ id: 41, at: Date.now() - 3600000, kind: 'text', ask: 'Lighting ads end date', client: 'Acme', to: 'Pat', status: 'done', auto: false, result: 'Texted Pat at 4:12 PM, delivered.' }] });
  }
  if (m === 'POST' && (r = /^\/api\/runs\/([a-z]+)\/([0-9a-f]{6,40})\/(pause|resume|run)$/.exec(p))) {
    const job = mockJobs.find((j) => j.bot === r[1] && j.id === r[2]);
    if (!job) return send(res, 404, { error: 'no such routine' });
    if (r[3] === 'pause') job.paused = true;
    if (r[3] === 'resume') job.paused = false;
    return send(res, 200, { job });
  }
  if (m === 'POST' && (r = /^\/api\/runs\/([a-z]+)$/.exec(p))) {
    const b = await readJson(req);
    if (!b.name || !/^\S+ \S+ \S+ \S+ \S+$/.test(String(b.schedule || '')) || String(b.prompt || '').trim().length < 20) return send(res, 400, { error: 'Say what it should do in a sentence or more (20 to 6000 characters).' });
    const [mi, hr] = String(b.schedule).split(' ');
    const job = { bot: r[1], id: crypto.randomBytes(6).toString('hex'), name: b.name, schedule: b.schedule, hh: Number(hr) || 9, mm: Number(mi) || 0, tokens: 0, paused: false, prompt: b.prompt, quiet: !!b.quiet };
    mockJobs.push(job);
    return send(res, 200, { job: mockRuns().bots.find((x) => x.id === r[1]).jobs.find((j) => j.id === job.id) });
  }
  if (m === 'PATCH' && (r = /^\/api\/runs\/([a-z]+)\/([0-9a-f]{6,40})$/.exec(p))) {
    const job = mockJobs.find((j) => j.bot === r[1] && j.id === r[2]);
    if (!job) return send(res, 404, { error: 'no such routine' });
    const b = await readJson(req);
    Object.assign(job, { name: b.name || job.name, schedule: b.schedule || job.schedule, prompt: b.prompt || job.prompt, quiet: !!b.quiet });
    return send(res, 200, { job: mockRuns().bots.find((x) => x.id === r[1]).jobs.find((j) => j.id === job.id) });
  }
  if (m === 'POST' && (r = /^\/api\/rules\/(\d+)\/revoke$/.exec(p))) return send(res, 200, { ok: true, rule: Number(r[1]) });
  // Vesper 10-30: search, card chips and link previews (server/store.mjs, server/unfurl.mjs).
  if (m === 'GET' && p === '/api/search') {
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const any = String(url.searchParams.get('any') || '').split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const all = [...byId.values()].filter((x) => x.kind !== 'deleted').sort((a, b) => b.id - a.id);
    const hit = all.filter((x) => (!q || String(x.text || '').toLowerCase().includes(q)) && (!any.length || any.some((t) => String(x.text || '').toLowerCase().includes(t))));
    const memory = q ? [{ bot: 'ben', note: 'Acme prefers calls after 3 PM.' }].filter((x) => x.note.toLowerCase().includes(q)) : [];
    return send(res, 200, { messages: (q || any.length || url.searchParams.get('recent') ? hit : []).slice(0, 80).map(msgOut), memory });
  }
  if (m === 'GET' && (r = /^\/api\/cards\/(\d+)$/.exec(p))) {
    const found = [...byId.values()].reverse().find((x) => new RegExp(`\\(#${r[1]}\\)\\s*$`).test(String(x.text || '').split('\n')[0]));
    return send(res, 200, { message: found ? msgOut(found) : null });
  }
  if (m === 'GET' && p === '/api/unfurl') {
    const u = String(url.searchParams.get('u') || '');
    const host = (() => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    if (/stripe\.com$/.test(host)) return send(res, 200, { url: u, kind: 'stripe', host, title: '', site: '', image: '', status: { tone: 'wait', label: 'Not paid yet' } });
    return send(res, 200, { url: u, kind: 'page', host, title: 'Garage door repair in Springfield', site: 'Fjord Garage Doors', image: '' });
  }
  if (m === 'POST' && p === '/api/files') {
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).replace(/[\\/\0\r\n]/g, '_').slice(0, 120) || 'file'; } catch { /* keep default */ }
    const buf = await readBody(req);
    if (!buf.length) return send(res, 400, { error: 'empty file' });
    await delay(400);
    return send(res, 200, { file: addFile(name, type, buf) });
  }
  if (m === 'POST' && p === '/api/presence') { await readJson(req); return send(res, 200, { ok: true }); }
  if (m === 'POST' && (p === '/api/push/subscribe' || p === '/api/push/unsubscribe')) { await readJson(req); return send(res, 200, { ok: true }); }
  if (m === 'POST' && p === '/api/logout') { signedOut = true; return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'not found' });
}

// A real P-256 public key so pushManager.subscribe() accepts it (nothing is ever pushed).
const VAPID = (() => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
})();

if (flag('chatty')) {
  setInterval(() => {
    const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
    const chat = Math.random() < 0.5 ? chats[0] : chats.find((c) => c.id === `dm-${bot}`);
    typing(chat.id, bot, true, STATUSES[bot][0]);
    setTimeout(() => {
      typing(chat.id, bot, false);
      const msg = addMessage({ chat_id: chat.id, sender: bot, text: REPLIES[bot][Math.floor(Math.random() * 3)] });
      broadcast('message', { message: msgOut(msg) });
    }, 2500);
  }, 25000).unref();
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); else res.end(); });
}).listen(PORT, HOST, () => {
  console.log(`Holler mock on http://${HOST}:${PORT}  (${byId.size} seeded messages, web root ${ROOT})`);
});
