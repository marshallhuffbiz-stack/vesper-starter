// 11-09: delivery of Alex's messages to the bots (safety resend, stalled, receipts, Send again), tapbacks and
// commands reaching a bot, the event stream's replay after a dropped connection, housekeeping and the System list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, sha256, REDELIVER_AFTER_MS, STALL_AFTER_MS, WORK_SILENT_MS } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createTeamOps } from '../server/teamops.mjs';
import { generateVapidKeys } from '../server/push.mjs';

let dir, store, app, server, base, cookie;
let clock = Date.UTC(2026, 10, 9, 15, 0, 0);
const pushes = [];
const logs = [];
const SAM = 'ben-token-0123456789abcdef';
const HANK = 'eli-token-0123456789abcdef';
const APPROVALS = 'approvals-token-0123456789abcdef';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vesper-delivery-'));
  mkdirSync(join(dir, 'files')); mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Vesper</title>');
  store = new Store(join(dir, 'holler.db'), { now: () => clock });
  const config = { vapid: generateVapidKeys(), pushSubject: 'https://example.com', botTokens: { ben: sha256(SAM), eli: sha256(HANK) }, serviceTokens: { approvals: sha256(APPROVALS) } };
  app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(dir, 'web'), log: (...a) => logs.push(a.join(' ')),
    pushImpl: async (sub, data) => { pushes.push(data); return { ok: true, status: 201 }; },
    system: () => [{ key: 'disk', label: 'Mac disk', level: 'ok', detail: '15 GB free' }] });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/login?t=${store.mintLoginToken()}`);
  cookie = res.headers.get('set-cookie').split(';')[0];
  store.addPushSub({ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }, 'test');
});

after(() => { app.close(); server.closeAllConnections(); server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const say = async (chat, text) => (await (await fetch(`${base}/api/chats/${chat}/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json()).message;
const bot = (token, path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const human = (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const delivery = (id, b = 'ben') => store.db.prepare('SELECT state, tries FROM deliveries WHERE message_id = ? AND bot = ?').get(id, b);
const eventsFor = (b) => store.db.prepare('SELECT id, kind, payload FROM bot_events WHERE bot = ? ORDER BY id').all(b).map((r) => ({ id: r.id, kind: r.kind, ...JSON.parse(r.payload) }));

// Open a bot's event stream and collect events until closed.
function stream(token, lastId = 0) {
  const ctrl = new AbortController();
  const got = [];
  const ready = fetch(`${base}/bot/v1/events`, { headers: { authorization: `Bearer ${token}`, ...(lastId ? { 'last-event-id': String(lastId) } : {}) }, signal: ctrl.signal }).then(async (res) => {
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const id = /^id: (\d+)$/m.exec(block)?.[1];
          const kind = /^event: (\w+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data && kind) got.push({ id: Number(id), kind, ...JSON.parse(data) });
        }
      }
    } catch { /* closed */ }
  });
  return { got, close: async () => { ctrl.abort(); await ready.catch(() => {}); await new Promise((r) => setTimeout(r, 30)); } };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

test('a message is tracked until its bot shows it has it; typing is that sign', async () => {
  const m = await say('dm-ben', 'Check the Acme budget');
  assert.deepEqual({ ...delivery(m.id) }, { state: 'sent', tries: 0 });
  assert.equal(m.delivery, undefined, 'nothing to flag yet');
  await bot(SAM, '/bot/v1/typing', { chat_id: 'dm-ben', on: true });
  assert.equal(delivery(m.id).state, 'working');
  await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Budget is $20 a day.' });
  assert.equal(delivery(m.id).state, 'done', 'a reply settles it');
  // A quick reply with no typing first settles it too, and never reads as "stopped without answering".
  const q = await say('dm-ben', 'Thanks');
  await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Anytime.' });
  assert.equal(delivery(q.id).state, 'done');
  assert.deepEqual(await app.sweepDeliveries(clock + 10 * 60000), { redelivered: [], stalled: [] });
});

test('no sign from a connected bot: queued once more after 90 s, stalled after 5 min, Send again resets it', async () => {
  const s = stream(SAM);
  await settle();
  const m = await say('dm-ben', 'Did Pat answer?');
  await settle();
  assert.equal(s.got.filter((e) => e.kind === 'message' && e.message.id === m.id).length, 1);
  let out = await app.sweepDeliveries(clock + 30 * 1000);
  assert.deepEqual(out, { redelivered: [], stalled: [] }, 'too soon to worry');
  clock += REDELIVER_AFTER_MS + 1000;
  out = await app.sweepDeliveries(clock);
  assert.deepEqual(out.redelivered, [{ message_id: m.id, bot: 'ben' }]);
  await settle();
  const again = s.got.filter((e) => e.kind === 'message' && e.message.id === m.id);
  assert.equal(again.length, 2, 'the bot is sent the message a second time');
  assert.equal(again[1].redelivery, 0, 'marked as the quiet safety resend, which a bot that has it ignores');
  assert.equal(delivery(m.id).tries, 1);
  out = await app.sweepDeliveries(clock + 1000);
  assert.equal(out.redelivered.length, 0, 'only once');
  clock += STALL_AFTER_MS;
  pushes.length = 0;
  out = await app.sweepDeliveries(clock);
  assert.equal(out.stalled.length, 1);
  assert.equal(delivery(m.id).state, 'stalled');
  assert.equal(pushes.length, 1, 'his phone hears about it once');
  assert.match(pushes[0].title, /^Ben has not picked up your message$/);
  assert.equal(pushes[0].tag, `stalled-${m.id}`);
  const page = await (await human('/api/chats/dm-ben/messages', null, 'GET')).json();
  assert.deepEqual(page.messages.at(-1).delivery, { state: 'stalled', bot: 'ben', tries: 1 }, 'the message carries it for the app');
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.deliveries.stalled, 1);

  const r = await human(`/api/messages/${m.id}/redeliver`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).message.delivery, undefined);
  await settle();
  const third = s.got.filter((e) => e.kind === 'message' && e.message.id === m.id).at(-1);
  assert.equal(third.redelivery, 2, 'a resend he asked for is numbered, so the bot takes it even though it saw the message');
  assert.equal((await human(`/api/messages/${m.id}/redeliver`)).status, 409, 'nothing to send again while it is on its way');
  // The bot's gateway reports the turn: working clears the flag for good, failed raises it again.
  await bot(SAM, '/bot/v1/receipt', { message_id: m.id, state: 'working' });
  assert.equal(delivery(m.id).state, 'working');
  await bot(SAM, '/bot/v1/receipt', { message_id: m.id, state: 'failed' });
  assert.equal(delivery(m.id).state, 'failed');
  assert.equal(store.message(m.id).delivery.state, 'failed');
  assert.equal((await bot(SAM, '/bot/v1/receipt', { message_id: m.id, state: 'nope' })).status, 400);
  assert.equal((await (await bot(SAM, '/bot/v1/receipt', { message_id: 999999, state: 'done' })).json()).known, false);
  await bot(SAM, '/bot/v1/receipt', { message_id: m.id, state: 'done' });
  await s.close();
});

test('an offline bot: no resend into the void, stalled says offline, and it clears when the bot comes back', async () => {
  const m = await say('dm-eli', 'Any new leads?');
  clock += REDELIVER_AFTER_MS + 1000;
  let out = await app.sweepDeliveries(clock);
  assert.equal(out.redelivered.length, 0, 'the first copy is still waiting in its queue');
  clock += STALL_AFTER_MS;
  pushes.length = 0;
  out = await app.sweepDeliveries(clock);
  assert.equal(out.stalled.length, 1);
  assert.match(pushes[0].title, /^Eli is offline and has not seen your message$/);
  await bot(HANK, '/bot/v1/typing', { chat_id: 'dm-eli', on: true });
  assert.equal(delivery(m.id, 'eli').state, 'working');
  assert.equal(store.message(m.id).delivery, undefined);
  await bot(HANK, '/bot/v1/messages', { chat_id: 'dm-eli', text: 'Two new ones since lunch.' });
  assert.equal(delivery(m.id, 'eli').state, 'done');
});

test('picked up and then silent (a gateway restart mid-turn) is stalled too; a bot still typing is left alone', async () => {
  const m = await say('dm-eli', 'Draft the follow-up for Mark');
  await bot(HANK, '/bot/v1/typing', { chat_id: 'dm-eli', on: true });
  clock += WORK_SILENT_MS + 1000;
  let out = await app.sweepDeliveries(clock);
  assert.equal(out.stalled.length, 0, 'typing right now: still at it');
  await bot(HANK, '/bot/v1/typing', { chat_id: 'dm-eli', on: false });
  clock += WORK_SILENT_MS + 1000;
  pushes.length = 0;
  out = await app.sweepDeliveries(clock);
  assert.equal(out.stalled.length, 1);
  assert.equal(out.stalled[0].quit, true);
  assert.match(pushes[0].title, /^Eli stopped without answering$/);
  // Two quick messages handled as one turn: the receipt for one settles both.
  const a = await say('dm-eli', 'One more thing');
  const b2 = await say('dm-eli', 'Also check Northside');
  await bot(HANK, '/bot/v1/receipt', { message_id: b2.id, state: 'working' });
  assert.equal(delivery(a.id, 'eli').state, 'working');
  await bot(HANK, '/bot/v1/receipt', { message_id: b2.id, state: 'done' });
  assert.equal(delivery(a.id, 'eli').state, 'done');
  assert.equal(delivery(m.id, 'eli').state, 'done', 'and the stalled one before it, which rode in the same turn');
});

test('a dropped connection replays from what the bot really took in', async () => {
  const s1 = stream(SAM);
  await settle();
  const m1 = await say('dm-ben', 'first');
  await settle();
  const seen = s1.got.filter((e) => e.kind === 'message').at(-1);
  assert.equal(seen.message.id, m1.id);
  await s1.close();
  const m2 = await say('dm-ben', 'second, sent while the stream was down');
  // The server's cursor may be ahead of the bot (an event written into a dying socket). The bot names the last
  // event it handled; here it says it never got m1's event.
  store.setBotCursor('ben', seen.id + 5);
  const s2 = stream(SAM, seen.id - 1);
  await settle();
  const ids = s2.got.filter((e) => e.kind === 'message').map((e) => e.message.id);
  assert.ok(ids.includes(m1.id) && ids.includes(m2.id), `replayed both (${ids})`);
  await s2.close();
  // A fresh gateway sends no header: it starts from the server's cursor.
  const s3 = stream(SAM);
  await settle();
  assert.equal(s3.got.filter((e) => e.kind === 'message').length, 0);
  await s3.close();
  await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Got both.' });
});

test('tapbacks reach the bot: thumbs on a question and a question mark wake it, the rest ride as context', async () => {
  const q = await (await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Pat wants Thursday instead. Want me to move it?' })).json();
  const note = await (await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Report sent to Hal.' })).json();
  const card = await (await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Approve? Text Pat', buttons: [[{ label: 'Approve', data: 'ea:once:1', style: 'primary' }, { label: 'Deny', data: 'ea:deny:1', style: 'danger' }]] })).json();
  const before = eventsFor('ben').length;
  const react = (id, emoji) => human(`/api/messages/${id}/react`, { emoji });
  await react(q.id, '👍');
  await react(note.id, '👍');
  await react(note.id, '❓');
  await react(note.id, '❤️');
  await react(card.id, '👍');
  await react(q.id, null);
  const evs = eventsFor('ben').slice(before);
  assert.deepEqual(evs.map((e) => [e.kind, e.message.id, e.emoji, e.wake]), [
    ['reaction', q.id, '👍', true],
    ['reaction', note.id, '👍', false],
    ['reaction', note.id, '❓', true],
    ['reaction', note.id, '❤️', false],
    ['reaction', card.id, '👍', false],
  ], 'a card is answered with its buttons, and taking a tapback off says nothing');
  assert.equal(evs[0].message.text, 'Pat wants Thursday instead. Want me to move it?');
  assert.equal(evs[0].by.name, 'Alex');
  // Tapping the same thing again within a minute does not wake the bot twice.
  await react(q.id, null);
  await react(q.id, '👍');
  assert.equal(eventsFor('ben').at(-1).wake, false);
  // His own messages and a bot's tapback never make an event.
  const mine = await say('dm-ben', 'ok');
  const n = eventsFor('ben').length;
  await react(mine.id, '👍');
  assert.equal(eventsFor('ben').length, n);
});

test('Stop and Start fresh go to the bot as commands with no bubble', async () => {
  const msgs = store.latestId('dm-ben');
  const r = await human('/api/chats/dm-ben/command', { command: 'stop' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).bot, 'ben');
  assert.equal(store.latestId('dm-ben'), msgs, 'nothing lands in the thread');
  const ev = eventsFor('ben').at(-1);
  assert.deepEqual([ev.kind, ev.command, ev.chat.id], ['command', '/stop', 'dm-ben']);
  await human('/api/chats/dm-ben/command', { command: 'fresh' });
  assert.equal(eventsFor('ben').at(-1).command, '/new');
  assert.equal((await human('/api/chats/dm-ben/command', { command: 'rm -rf' })).status, 400);
  assert.equal((await human('/api/chats/room/command', { command: 'stop' })).status, 400, 'the room needs a bot named');
  assert.equal((await human('/api/chats/room/command', { command: 'stop', bot: 'eli' })).status, 200);
  assert.equal(eventsFor('eli').at(-1).command, '/stop');
});

test('System lists what Vesper depends on, worst first in the headline', async () => {
  const s = await (await human('/api/system', null, 'GET')).json();
  const by = Object.fromEntries(s.checks.map((c) => [c.key, c]));
  assert.equal(by.server.level, 'ok');
  assert.equal(by.push.detail, '1 device will ring');
  assert.equal(by.disk.detail, '15 GB free', 'outside checks are folded in');
  assert.equal(by.delivery.level, 'ok');
  assert.ok(['ok', 'bad'].includes(s.level));
  // A bot that is not connected is bad once the server has been up a minute; right after start it gets grace.
  assert.equal(by['bot:ada'].level, 'ok');
  const later = app.systemStatus(Date.now() + 5 * 60000);
  const d = later.checks.find((c) => c.key === 'bot:ada');
  assert.equal(d.level, 'bad');
  assert.match(d.detail, /^Not connected/);
  assert.equal(later.level, 'bad');
  assert.match(later.headline, /Not connected/);
});

test('housekeeping drops old queue rows, used sign-in links and settled delivery notes', async () => {
  const old = clock - 8 * 86400000;
  store.db.prepare('INSERT INTO bot_events (bot, kind, payload, at) VALUES (?, ?, ?, ?)').run('ben', 'message', '{}', old);
  store.db.prepare('INSERT INTO login_tokens (hash, expires_at) VALUES (?, ?)').run('dead', old);
  store.db.prepare(`INSERT INTO deliveries (message_id, bot, state, tries, at, updated_at) VALUES (1, 'dora', 'done', 0, ?, ?)`).run(clock - 15 * 86400000, old);
  const r = store.prune(clock);
  assert.ok(r.bot_events >= 1 && r.login_tokens >= 1 && r.deliveries === 1, JSON.stringify(r));
  assert.ok(store.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n > 0, 'recent events stay');
});

test('a bot can read the tail of a chat it is in, and no other', async () => {
  const r = await bot(SAM, '/bot/v1/chats/dm-ben/messages?limit=5', null, 'GET');
  assert.equal(r.status, 200);
  const rows = (await r.json()).messages;
  assert.equal(rows.length, 5);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['answered', 'at', 'attachments', 'id', 'kind', 'name', 'sender', 'text', 'waiting']);
  assert.ok(rows.every((x) => ['Alex', 'Ben'].includes(x.name)));
  const card = (await (await bot(SAM, '/bot/v1/chats/dm-ben/messages?limit=30', null, 'GET')).json()).messages.find((x) => x.kind === 'card');
  assert.equal(card.waiting, true);
  const before = await (await bot(SAM, `/bot/v1/chats/dm-ben/messages?limit=30&before=${rows[0].id}`, null, 'GET')).json();
  assert.ok(before.messages.every((x) => x.id < rows[0].id));
  assert.equal((await bot(SAM, '/bot/v1/chats/dm-eli/messages', null, 'GET')).status, 404);
});

test('each message in a bot\'s thread carries the cards the approvals service posted for it since its last turn', async () => {
  const svc = (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${APPROVALS}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await say('dm-ben', 'Text Pat that Wednesday works');
  await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'On it.' });
  clock += 60000;
  const card = await (await svc('/svc/v1/messages', { as: 'ben', chat_id: 'dm-ben', text: '**Acme Pressure Washing**: Pat: confirm Wednesday 2:30 (#301)\nText to Pat (ends 1234): "Sounds good."',
    buttons: [[{ label: 'Approve', data: 'a|301|abc', style: 'primary' }, { label: 'Decline', data: 'd|301|abc', style: 'danger' }]] })).json();
  clock += 60000;
  const m1 = await say('dm-ben', 'Make it friendlier');
  const ev1 = eventsFor('ben').filter((e) => e.kind === 'message' && e.message?.id === m1.id).at(-1);
  assert.match(ev1.context, /^\[Your cards in this thread since your last turn here\./);
  assert.match(ev1.context, /- Acme Pressure Washing: Pat: confirm Wednesday 2:30 \(#301\): waiting on Alex \(/);
  assert.ok(!/Sounds good/.test(ev1.context), 'one line a card, not its whole text');
  // Nothing new since that turn: nothing is added.
  const m2 = await say('dm-ben', 'Shorter too');
  assert.equal(eventsFor('ben').filter((e) => e.message?.id === m2.id).at(-1).context, undefined);
  // He slides it: the bot's next turn hears how it ended.
  clock += 60000;
  await human(`/api/messages/${card.id}/press`, { data: 'a|301|abc' });
  clock += 60000;
  const m3 = await say('dm-ben', 'Thanks');
  assert.match(eventsFor('ben').filter((e) => e.message?.id === m3.id).at(-1).context, /\(#301\): answered: Approve \(/);
  // A safety resend carries the same context the first copy had.
  store.db.prepare(`UPDATE deliveries SET state = 'stalled' WHERE message_id = ?`).run(m3.id);
  await human(`/api/messages/${m3.id}/redeliver`);
  const again = eventsFor('ben').filter((e) => e.message?.id === m3.id).at(-1);
  assert.equal(again.redelivery, 1);
  assert.match(again.context, /answered: Approve/);
  await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Anytime.' });
});

test('every bot starts a new conversation each morning, quietly, and his next message carries the tail of the thread', async () => {
  const s = stream(SAM);
  await settle();
  clock = Date.UTC(2026, 10, 10, 8, 30, 0); // 3:30 AM Eastern: not yet
  assert.deepEqual(app.freshen(clock), []);
  clock = Date.UTC(2026, 10, 10, 9, 30, 0); // 4:30 AM Eastern
  const before = store.latestId('dm-ben');
  assert.deepEqual(app.freshen(clock), ['ben'], 'only bots that are connected (Eli is not) and whose thread is quiet');
  const cmd = eventsFor('ben').at(-1);
  assert.deepEqual([cmd.kind, cmd.command, cmd.quiet, cmd.chat.id], ['command', '/new', true, 'dm-ben']);
  assert.equal(store.latestId('dm-ben'), before, 'no bubble');
  assert.deepEqual(app.freshen(clock + 600000), [], 'once a day');
  clock += 3 * 3600 * 1000;
  const m = await say('dm-ben', 'yes');
  const ev = eventsFor('ben').filter((e) => e.message?.id === m.id).at(-1);
  assert.match(ev.context, /^\[The last messages in this chat, from before this conversation started\./);
  assert.match(ev.context, /\[You, \w{3} \d{1,2}:\d{2} [AP]M\] Anytime\./);
  assert.match(ev.context, /\[Alex, \w{3} \d{1,2}:\d{2} [AP]M\] Thanks/);
  assert.match(ev.context, /\(#301\).*\[card, answered: Approve\]/);
  assert.ok(!/\] yes/.test(ev.context), 'his new message is not in its own recap');
  assert.match(ev.context, /\[Still open in this thread\]\n- waiting card: Approve\? Text Pat/, 'the card still waiting from earlier is named');
  const m2 = await say('dm-ben', 'and then?');
  assert.equal(eventsFor('ben').filter((e) => e.message?.id === m2.id).at(-1).context, undefined, 'the recap is given once');
  // Not while he is mid-conversation, not outside the morning window, not when it is turned off.
  clock = Date.UTC(2026, 10, 11, 9, 5, 0);
  await say('dm-ben', 'up early');
  await bot(SAM, '/bot/v1/messages', { chat_id: 'dm-ben', text: 'Morning.' });
  clock += 10 * 60000;
  assert.deepEqual(app.freshen(clock), [], 'he wrote ten minutes ago');
  clock += 50 * 60000;
  assert.deepEqual(app.freshen(clock), ['ben']);
  clock = Date.UTC(2026, 10, 12, 16, 0, 0); // 11 AM: the window has passed, today is skipped
  assert.deepEqual(app.freshen(clock), []);
  // The System list says so when a bot missed its morning.
  const sys = app.systemStatus(clock).checks.find((c) => c.key === 'fresh');
  assert.equal(sys.level, 'warn');
  assert.match(sys.detail, /^Ada, Ben, Cleo, Dora, Eli did not start a new conversation this morning$/);
  const early = app.systemStatus(Date.UTC(2026, 10, 11, 12, 0, 0)).checks.find((c) => c.key === 'fresh'); // 7 AM on a day Ben had his
  assert.match(early.detail, /^Ada, Cleo, Dora, Eli did not/);
  // One he asked for: no tail (forgetting is the point), still what is open.
  await human('/api/chats/dm-ben/command', { command: 'fresh' });
  const m3 = await say('dm-ben', 'start over on the Birch post');
  const ctx = eventsFor('ben').filter((e) => e.message?.id === m3.id).at(-1).context || '';
  assert.ok(!/The last messages in this chat/.test(ctx), 'no tail of the thread');
  assert.equal(store.metaGet('fresh:ben', null), null, 'and the marker is spent');
  await s.close();
});
