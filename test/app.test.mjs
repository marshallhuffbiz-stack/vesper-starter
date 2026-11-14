import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, createHmac, createDecipheriv } from 'node:crypto';
import { Store, sha256 } from '../server/store.mjs';
import { createApp, quietHour, cardLine } from '../server/app.mjs';
import { generateVapidKeys, encryptPayload, vapidAuthHeader } from '../server/push.mjs';

let dir, store, app, server, base;
const pushes = [];
const SAM = 'ben-token-0123456789abcdef';
const DARLENE = 'ada-token-0123456789abcdef';
const APPROVALS = 'approvals-token-0123456789abcdef';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'holler-test-'));
  mkdirSync(join(dir, 'files')); mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><meta name="holler-build" content="__BUILD__"><title>Holler</title>');
  store = new Store(join(dir, 'holler.db'));
  const config = { vapid: generateVapidKeys(), pushSubject: 'https://example.com', botTokens: { ben: sha256(SAM), ada: sha256(DARLENE) }, serviceTokens: { approvals: sha256(APPROVALS) } };
  app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(dir, 'web'), pushImpl: async (sub, data) => { pushes.push(data); return { ok: true, status: 201 }; } });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { app.close(); server.closeAllConnections(); server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

async function signIn() {
  const token = store.mintLoginToken();
  const res = await fetch(`${base}/login?t=${token}`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /http-equiv="refresh"/);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const again = await fetch(`${base}/login?t=${token}`, { redirect: 'manual' });
  assert.equal(again.status, 403, 'login links are single use');
  return cookie;
}

const json = (cookie, body, method = 'POST') => ({ method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const botReq = (token, body, method = 'POST') => ({ method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Read SSE events from a stream until `want` events arrive or the timeout passes.
async function readEvents(url, headers, want, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const events = [];
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = { id: null, event: 'message', data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data += line.slice(6);
        }
        if (ev.data) { events.push({ ...ev, data: JSON.parse(ev.data) }); if (events.length >= want) { ctrl.abort(); return events; } }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  finally { clearTimeout(timer); }
  return events;
}

test('API needs a session; bot API needs a token', async () => {
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
  assert.equal((await fetch(`${base}/bot/v1/events`, { headers: { authorization: 'Bearer nope' } })).status, 401);
});

test('bootstrap lists the room and five DMs and never leaks profiles', async () => {
  const cookie = await signIn();
  const b = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal(b.me.id, 'alex');
  assert.deepEqual(b.chats.map((c) => c.id), ['room', 'dm-ada', 'dm-ben', 'dm-cleo', 'dm-dora', 'dm-eli']);
  assert.ok(b.members.every((m) => !('profile' in m)));
  assert.ok(b.vapidPublicKey);
  assert.ok(b.build, 'bootstrap names the release so a stale cached app can tell');
  await fetch(`${base}/api/presence`, json(cookie, { visible: true, chat_id: null, client_id: 'phone-1', build: 'abc1234' }));
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.build, b.build);
  assert.ok(health.apps.some((a) => a.build === 'abc1234'), 'health shows which release each app runs');
});

test('a DM reaches the bot stream addressed, the reply reaches the web app and pushes', async () => {
  const cookie = await signIn();
  const sent = await (await fetch(`${base}/api/chats/dm-ben/messages`, json(cookie, { text: 'Ben, how are Acme leads?', client_id: 'c-1' }))).json();
  assert.equal(sent.message.client_id, 'c-1');
  const dup = await (await fetch(`${base}/api/chats/dm-ben/messages`, json(cookie, { text: 'Ben, how are Acme leads?', client_id: 'c-1' }))).json();
  assert.equal(dup.message.id, sent.message.id, 'client_id makes sends idempotent');

  const evs = await readEvents(`${base}/bot/v1/events`, { authorization: `Bearer ${SAM}` }, 1);
  assert.equal(evs[0].event, 'message');
  assert.equal(evs[0].data.addressed, true);
  assert.equal(evs[0].data.message.text, 'Ben, how are Acme leads?');

  // Reconnecting resumes after the stored cursor, so nothing is delivered twice.
  const again = await readEvents(`${base}/bot/v1/events`, { authorization: `Bearer ${SAM}` }, 1, 400);
  assert.equal(again.length, 0);

  store.addPushSub({ endpoint: 'https://web.push.apple.com/test', keys: { p256dh: 'x', auth: 'y' } });
  const webEvents = readEvents(`${base}/api/events`, { cookie }, 1);
  await new Promise((r) => setTimeout(r, 100));
  const reply = await (await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: '**Six** new leads today.', reply_to: sent.message.id }))).json();
  const [ev] = await webEvents;
  assert.equal(ev.event, 'message');
  assert.equal(ev.data.message.id, reply.id);
  assert.equal(ev.data.message.reply_to.id, sent.message.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pushes.at(-1).title, 'Ben (Acme, Birch, Cedar)');
  assert.equal(pushes.at(-1).body, 'Six new leads today.');
});

test('a bot cannot post into a chat it is not in, or edit another bot message', async () => {
  const r = await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ada', text: 'hi' }));
  assert.equal(r.status, 403);
  const m = await (await fetch(`${base}/bot/v1/messages`, botReq(DARLENE, { chat_id: 'room', text: 'morning' }))).json();
  const e = await fetch(`${base}/bot/v1/messages/${m.id}`, botReq(SAM, { text: 'hacked' }, 'PATCH'));
  assert.equal(e.status, 403);
});

test('room: Ada gets unaddressed messages, Ben gets them as context', async () => {
  const cookie = await signIn();
  const before = store.botCursor('ada');
  await fetch(`${base}/api/chats/room/messages`, json(cookie, { text: 'what is on today?', client_id: 'c-room-1' }));
  const d = store.botEventsAfter('ada', before).filter((e) => e.payload.message?.text === 'what is on today?');
  const s = store.botEventsAfter('ben', 0).filter((e) => e.payload.message?.text === 'what is on today?');
  assert.equal(d[0].payload.addressed, true);
  assert.equal(s[0].payload.addressed, false);
});

test('only Alex can press a card button; first press wins; the bot gets a press event', async () => {
  const cookie = await signIn();
  const card = await (await fetch(`${base}/bot/v1/messages`, botReq(SAM, {
    chat_id: 'dm-ben', text: 'Run `rm -rf build`?', buttons: [[{ label: 'Approve once', data: 'ea:once:1', style: 'primary' }, { label: 'Deny', data: 'ea:deny:1', style: 'danger' }]],
  }))).json();
  assert.equal(card.message.kind, 'card');
  const botPress = await fetch(`${base}/api/messages/${card.id}/press`, { method: 'POST', headers: { authorization: `Bearer ${SAM}`, 'content-type': 'application/json' }, body: '{"data":"ea:once:1"}' });
  assert.equal(botPress.status, 401, 'bot tokens do not work on the human API');
  const p = await (await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'ea:once:1' }))).json();
  assert.equal(p.message.resolved.label, 'Approve once');
  const second = await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'ea:deny:1' }));
  assert.equal(second.status, 409);
  const press = store.botEventsAfter('ben', 0).filter((e) => e.kind === 'press');
  assert.equal(press.at(-1).payload.data, 'ea:once:1');
});

test('approvals service: posts as a bot only into its DM, gets the press, the bot does not', async () => {
  const cookie = await signIn();
  const svc = (body, method = 'POST', path = '/svc/v1/messages') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  assert.equal((await fetch(`${base}/svc/v1/messages`, botReq(SAM, { as: 'ben', chat_id: 'dm-ben', text: 'x' }))).status, 401, 'bot tokens are not service tokens');
  assert.equal((await svc({ as: 'ben', chat_id: 'room', text: 'x' })).status, 403, 'never the room');
  assert.equal((await svc({ as: 'ben', chat_id: 'dm-ada', text: 'x' })).status, 403, 'never another bot thread');
  assert.equal((await svc({ as: 'alex', chat_id: 'dm-ben', text: 'x' })).status, 403, 'never as Alex');
  const before = pushes.length;
  const card = await (await svc({ as: 'ben', chat_id: 'dm-ben', text: 'Approve? #9 from Ben', silent: true, client_id: 'appr-9',
    buttons: [[{ label: 'Approve', data: 'a|9|h', style: 'primary' }, { label: 'Decline', data: 'n|9|h', style: 'danger' }]] })).json();
  assert.equal(card.message.sender, 'ben');
  assert.equal(card.message.kind, 'card');
  assert.equal(card.message.owner, undefined, 'owner stays server side');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pushes.length, before, 'silent cards do not push');
  assert.equal((await fetch(`${base}/bot/v1/messages/${card.id}`, botReq(SAM, { text: 'changed' }, 'PATCH'))).status, 403, 'the bot cannot edit the service card');
  assert.equal((await fetch(`${base}/bot/v1/messages/${card.id}`, botReq(SAM, {}, 'DELETE'))).status, 403, 'or delete it');
  const empty = await (await svc(undefined, 'GET', '/svc/v1/updates?wait=0')).json();
  const waiting = svc(undefined, 'GET', `/svc/v1/updates?wait=5`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 100));
  await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'a|9|h' }));
  const got = await waiting;
  assert.equal(empty.events.length, 0);
  assert.equal(got.events.length, 1, 'the long poll wakes on the press');
  assert.equal(got.events[0].data, 'a|9|h');
  assert.equal(got.events[0].by.id, 'alex');
  assert.equal(got.events[0].message_id, card.id);
  assert.ok(!store.botEventsAfter('ben', 0).some((e) => e.kind === 'press' && e.payload.message_id === card.id), 'Ben never sees the press');
  const again = await (await svc(undefined, 'GET', `/svc/v1/updates?offset=${got.events[0].id + 1}&wait=0`)).json();
  assert.equal(again.events.length, 0, 'offset confirms handled events');
  const edited = await (await svc({ text: 'Done. Texted Pat.', buttons: null }, 'PATCH', `/svc/v1/messages/${card.id}`)).json();
  assert.equal(edited.message.text, 'Done. Texted Pat.');
  assert.equal(edited.message.resolved.label, 'Approve');
});

test('review with edits: the changed words ride the press to the service; only its approve button takes them', async () => {
  const cookie = await signIn();
  const svc = (body, method = 'POST', path = '/svc/v1/messages') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  const card = await (await svc({ as: 'ben', chat_id: 'dm-ben', text: '**Acme**: end date (#21)\n\nText to Pat:\n"Hey Pat, done."', client_id: 'appr-21',
    buttons: [[{ label: 'Approve', data: 'a|21|h', style: 'primary' }, { label: 'Decline', data: 'n|21|h', style: 'danger' }]] })).json();
  assert.equal((await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'n|21|h', edit: 'x' }))).status, 400, 'Decline takes no edit');
  assert.equal((await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'a|21|h', edit: '   ' }))).status, 400, 'an empty edit is refused');
  const r = await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'a|21|h', edit: 'Hey Pat, all set for Monday.' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).message.resolved.edited, true);
  const got = await (await svc(undefined, 'GET', '/svc/v1/updates?wait=0')).json();
  const ev = got.events.find((e) => e.message_id === card.id);
  assert.equal(ev.data, 'a|21|h');
  assert.equal(ev.edit, 'Hey Pat, all set for Monday.');
  // A bot's own card (no service owner) never takes an edit.
  const own = await (await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: 'Approve?', buttons: [[{ label: 'Approve', data: 'a|5|h', style: 'primary' }]] }))).json();
  assert.equal((await fetch(`${base}/api/messages/${own.id}/press`, json(cookie, { data: 'a|5|h', edit: 'x' }))).status, 400);
});

test('undo on a receipt goes to the service once, as a press, and never re-opens the card', async () => {
  const cookie = await signIn();
  const svc = (body, method = 'POST', path = '/svc/v1/messages') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  const card = await (await svc({ as: 'dora', chat_id: 'dm-dora', text: '**Fjord**: add 12 negatives (#72)\n\nAdd them.\n\nDone by Dora in 12 min. Added.\nUndo: remove the 12 negatives', client_id: 'appr-72' })).json();
  const plain = await (await svc({ as: 'dora', chat_id: 'dm-dora', text: '**Fjord**: weekly check (#73)\n\nDone by Dora. Fine.', client_id: 'appr-73' })).json();
  assert.equal((await fetch(`${base}/api/messages/${plain.id}/undo`, json(cookie, {}))).status, 400, 'no Undo line, no undo');
  await svc(undefined, 'GET', '/svc/v1/updates?wait=0');
  const r = await fetch(`${base}/api/messages/${card.id}/undo`, json(cookie, {}));
  assert.equal(r.status, 200);
  const msg = (await r.json()).message;
  assert.ok(msg.resolved.undo);
  assert.ok(!msg.buttons, 'still not a waiting card');
  assert.equal((await fetch(`${base}/api/messages/${card.id}/undo`, json(cookie, {}))).status, 409, 'once');
  const got = await (await svc(undefined, 'GET', '/svc/v1/updates?wait=0')).json();
  const ev = got.events.filter((e) => e.message_id === card.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data, 'u|72|-');
  assert.equal(ev[0].by.id, 'alex');
});

test('change it: nothing goes out, the service hears c| with his words, and his words reach the bot as a reply under the card', async () => {
  const cookie = await signIn();
  const svc = (body, method = 'POST', path = '/svc/v1/messages') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  await svc(undefined, 'GET', '/svc/v1/updates?wait=0');
  const card = await (await svc({ as: 'ben', chat_id: 'dm-ben', text: '**Acme**: text Pat the link (#31)\n\nText to Pat (ends 0120):\n"Hey Pat, here is the link."', client_id: 'appr-31',
    buttons: [[{ label: 'Approve', data: 'a|31|h', style: 'primary' }, { label: 'Decline', data: 'n|31|h', style: 'danger' }]] })).json();
  assert.equal((await fetch(`${base}/api/messages/${card.id}/change`, json(cookie, { text: '   ' }))).status, 400, 'he has to say something');
  const before = store.botEventsAfter('ben', 0, 10000).length;
  const r = await fetch(`${base}/api/messages/${card.id}/change`, json(cookie, { text: 'Don’t text him, he already paid. Check Stripe first.' }));
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.message.resolved.label, 'Changed');
  assert.equal(out.message.resolved.change, 'Don’t text him, he already paid. Check Stripe first.');
  assert.equal(out.reply.sender, 'alex');
  assert.equal(out.reply.reply_to.id, card.id, 'his words sit under the card');
  assert.equal((await fetch(`${base}/api/messages/${card.id}/change`, json(cookie, { text: 'again' }))).status, 409, 'once');
  assert.equal((await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'a|31|h' }))).status, 409, 'and it can no longer be slid');
  const got = await (await svc(undefined, 'GET', '/svc/v1/updates?wait=0')).json();
  const ev = got.events.filter((e) => e.message_id === card.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data, 'c|31|h');
  assert.equal(ev[0].change, 'Don’t text him, he already paid. Check Stripe first.');
  const bot = store.botEventsAfter('ben', 0, 10000).slice(before);
  const said = bot.find((e) => e.kind === 'message' && e.payload.message.id === out.reply.id);
  assert.ok(said, 'Ben hears his words');
  assert.equal(said.payload.message.reply_to.id, card.id);
  assert.match(said.payload.message.reply_to.text, /text Pat the link/);
  assert.ok(!bot.some((e) => e.kind === 'press'), 'the press goes to the service, not the bot');
});

test('ask about a card: his question reaches the bot with the whole card quoted, and the card stays up', async () => {
  const cookie = await signIn();
  const svc = (body, method = 'POST', path = '/svc/v1/messages') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  const plan = 'Run the remote-start ad Nov 2 to 15 with a hard $350 cap. '.repeat(12);
  const card = await (await svc({ as: 'ben', chat_id: 'dm-ben', text: `**Acme**: November flight (#51)\n\n${plan}\n\nSource: plaud:of_9`, client_id: 'appr-51',
    buttons: [[{ label: 'Approve', data: 'a|51|h', style: 'primary' }, { label: 'Decline', data: 'n|51|h', style: 'danger' }]] })).json();
  const before = store.botEventsAfter('ben', 0, 10000).length;
  const r = await fetch(`${base}/api/chats/dm-ben/messages`, json(cookie, { text: 'Why a $350 cap?', reply_to: card.id, client_id: 'ask-51' }));
  assert.equal(r.status, 200);
  const ev = store.botEventsAfter('ben', 0, 10000).slice(before).find((e) => e.kind === 'message');
  assert.ok(ev, 'Ben hears the question');
  assert.ok(ev.payload.message.reply_to.text.length > 280, 'the whole card, not 280 characters');
  assert.match(ev.payload.message.reply_to.text, /Source: plaud:of_9$/);
  assert.equal(store.message(card.id).resolved, null, 'the card still waits for his slide');
});

test('change it on a bot\'s own card sends its deny press first; a card with no way to say no is refused', async () => {
  const cookie = await signIn();
  const own = await (await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: 'Run the ad check?',
    buttons: [[{ label: 'Allow once', data: 'ea:1', style: 'primary' }, { label: 'Deny', data: 'ea:0', style: 'danger' }]] }))).json();
  const before = store.botEventsAfter('ben', 0, 10000).length;
  const r = await fetch(`${base}/api/messages/${own.id}/change`, json(cookie, { text: 'Start a Claude session for this instead.' }));
  assert.equal(r.status, 200);
  const evs = store.botEventsAfter('ben', 0, 10000).slice(before);
  assert.deepEqual(evs.map((e) => e.kind), ['press', 'message'], 'deny first, then his words');
  assert.equal(evs[0].payload.data, 'ea:0');
  const choice = await (await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: 'Which one?',
    buttons: [[{ label: 'Red', data: 'cl:red' }, { label: 'Blue', data: 'cl:blue' }]] }))).json();
  assert.equal((await fetch(`${base}/api/messages/${choice.id}/change`, json(cookie, { text: 'neither' }))).status, 400);
});

test('a card rings as its own notification; a two-hour-old card gets one reminder, outside quiet hours', async () => {
  const svc = (body, method = 'POST', path = '/svc/v1/messages') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  pushes.length = 0;
  const card = await (await svc({ as: 'ben', chat_id: 'dm-ben', text: '**Acme Pressure Washing**: confirm the end date (#41)\n\nText to Pat (ends 0120):\n"Hey Pat"', client_id: 'appr-41',
    buttons: [[{ label: 'Approve', data: 'a|41|h', style: 'primary' }, { label: 'Decline', data: 'n|41|h', style: 'danger' }]] })).json();
  await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: 'Put that up for you.' }));
  await new Promise((r) => setTimeout(r, 50));
  const ring = pushes.find((d) => d.message_id === card.id);
  assert.ok(ring, 'the card pushed');
  assert.equal(ring.tag, `card-${card.id}`, 'its own tag, so the next chat message never replaces it');
  assert.equal(ring.title, 'Ben needs you');
  assert.equal(ring.body, 'Acme Pressure Washing: confirm the end date\nText to Pat');
  assert.ok(Number.isFinite(ring.badge));
  const chat = pushes.find((d) => d.body === 'Put that up for you.');
  assert.equal(chat.tag, undefined, 'chat messages keep the chat tag');
  assert.deepEqual(cardLine('Approval needed: **Team**: Nudge Hugo (#104)\n\nHugo owes you'), { head: 'Team: Nudge Hugo', to: '' });
  // Reminder: find a time two hours on that is not quiet hours. Earlier tests' cards are answered first.
  store.db.prepare("UPDATE messages SET resolved = '{}' WHERE kind = 'card' AND resolved IS NULL AND id != ?").run(card.id);
  let at = card.message.at + 2 * 3600000 + 60000;
  while (quietHour(new Date(at))) at += 3600000;
  pushes.length = 0;
  const first = await app.remindWaiting(at);
  assert.ok(first, 'one reminder');
  assert.equal(first.route, '#/approvals');
  assert.match(first.body, /Ben: Acme Pressure Washing: confirm the end date/);
  assert.equal(pushes.length, 1);
  assert.equal(await app.remindWaiting(at + 60000), null, 'not again so soon');
  assert.equal(await app.remindWaiting(at + 3 * 3600000), null, 'and never twice for the same card');
  let night = at; while (!quietHour(new Date(night))) night += 3600000;
  store.metaSet('remind_last', 0); store.metaSet('remind_ids', []);
  assert.equal(await app.remindWaiting(night), null, 'quiet hours');
});

test('needs a human: link buttons open a page and cannot be pressed; a sealed value reaches only the service, once, and is never stored', async () => {
  const cookie = await signIn();
  const svc = (body, method = 'POST', path = '/svc/v1/messages') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  assert.equal((await svc({ as: 'ada', chat_id: 'dm-ada', text: 'x', buttons: [[{ label: 'Open', url: 'javascript:alert(1)' }]] })).status, 400, 'http(s) links only');
  const card = await (await svc({ as: 'ada', chat_id: 'dm-ada', client_id: 'appr-81',
    text: '**Team**: Google sign-in code (#81)\n\nGoogle wants the code sent to your phone.\n\nDetails:\nSealed: Google sign-in code',
    buttons: [[{ label: 'Open Google', url: 'https://accounts.google.com/' }], [{ label: 'Send it', data: 'a|81|h', style: 'primary' }, { label: "Can't now", data: 'n|81|h', style: 'danger' }]] })).json();
  assert.deepEqual(card.message.buttons[0][0], { label: 'Open Google', data: 'link', url: 'https://accounts.google.com/', style: '' });
  assert.equal((await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'link' }))).status, 400, 'a link is never a press');
  // Typing "send" does not slide a sealed card.
  const typed = await (await fetch(`${base}/api/chats/dm-ada/messages`, json(cookie, { text: 'send', client_id: 'typed-81' }))).json();
  assert.ok(typed.message);
  await svc(undefined, 'GET', '/svc/v1/updates?wait=0');
  const before = await (await svc(undefined, 'GET', '/svc/v1/updates?wait=0')).json();
  assert.ok(!before.events.some((e) => e.message_id === card.id), 'no press from the typed word');
  const r = await fetch(`${base}/api/messages/${card.id}/press`, json(cookie, { data: 'a|81|h', sealed: ' 482913 ' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).message.resolved.sealed, true);
  const got = await (await svc(undefined, 'GET', '/svc/v1/updates?wait=0')).json();
  const ev = got.events.find((e) => e.message_id === card.id);
  assert.equal(ev.sealed, '482913');
  const raw = store.db.prepare('SELECT payload FROM bot_events WHERE id = ?').get(ev.id).payload + JSON.stringify(store.db.prepare('SELECT * FROM messages WHERE id = ?').get(card.id));
  assert.ok(!raw.includes('482913'), 'never in the database');
  const after = await (await svc(undefined, 'GET', `/svc/v1/updates?offset=${ev.id + 1}&wait=0`)).json();
  assert.equal(after.events.length, 0);
  assert.equal(store.sealed.size, 0, 'confirmed events drop the value');
  // A card without a sealed field takes no sealed value.
  const plain = await (await svc({ as: 'ada', chat_id: 'dm-ada', client_id: 'appr-82', text: '**Team**: check (#82)', buttons: [[{ label: 'Done', data: 'a|82|h', style: 'primary' }]] })).json();
  assert.equal((await fetch(`${base}/api/messages/${plain.id}/press`, json(cookie, { data: 'a|82|h', sealed: 'x' }))).status, 400);
});

test('approvals service: card files upload as the service, at most ten, its own uploads only, kept through edits', async () => {
  const cookie = await signIn();
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const upload = (body, type = 'image/png', name = 'creative.png', token = APPROVALS, path = '/svc/v1/files') => fetch(`${base}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type, 'x-file-name': name }, body,
  });
  const svc = (body) => fetch(`${base}/svc/v1/messages`, botReq(APPROVALS, body));
  const cardWith = (attachments, extra = {}) => svc({ as: 'ben', chat_id: 'dm-ben', text: 'Approve the exact consultation image?', attachments,
    buttons: [[{ label: 'Approve', data: `a|img|${Math.random()}`, style: 'primary' }]], ...extra });

  assert.equal((await upload(PNG, 'image/png', 'x.png', SAM)).status, 401, 'bot tokens are not service tokens');
  const ups = [];
  for (let i = 0; i < 5; i++) {
    const r = await upload(PNG, i % 2 ? 'image/jpeg' : 'image/png', `creative-${i}.png`);
    assert.equal(r.status, 200);
    ups.push((await r.json()).file);
  }
  assert.match(ups[0].id, /^[a-f0-9]{32}$/);
  assert.equal(ups[0].name, 'creative-0.png', 'the name comes from X-File-Name');
  assert.equal(ups[1].type, 'image/jpeg');
  assert.equal(store.fileRecord(ups[0].id).sender, 'svc:approvals', 'recorded against the service');
  const got = await fetch(`${base}${ups[0].url}`, { headers: { cookie } });
  assert.equal(got.headers.get('content-type'), 'image/png', 'Alex can open it');

  const one = await (await cardWith([ups[0].id])).json();
  assert.deepEqual(one.message.attachments.map((a) => a.id), [ups[0].id]);
  const three = await (await cardWith(ups.slice(1, 4).map((f) => f.id))).json();
  assert.equal(three.message.attachments.length, 3);
  assert.equal(three.message.attachments[0].url, `/files/${ups[1].id}`);

  // Since 11-10 a card carries documents too, and up to ten files.
  assert.equal((await cardWith(ups.map((f) => f.id))).status, 200, 'five fit');
  const text = await (await upload(Buffer.from('hello'), 'text/plain', 'notes.txt')).json();
  assert.equal((await cardWith([text.file.id])).status, 200, 'a document rides on a card');
  const odd = await (await upload(Buffer.from('<svg/>'), 'image/svg+xml', 'x.svg')).json();
  assert.equal(odd.file.type, 'application/octet-stream', 'an unsafe type is stored as plain bytes');
  // Refusals: too many, unknown, someone else's upload, not a list, and the DM rule still holds.
  const many = [];
  for (let i = 0; i < 11; i++) many.push((await (await upload(PNG, 'image/png', `m-${i}.png`)).json()).file.id);
  assert.equal((await cardWith(many)).status, 400, 'eleven is too many');
  assert.equal((await cardWith(['0'.repeat(32)])).status, 400, 'unknown id');
  const mine = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, 'content-type': 'image/png', 'x-file-name': 'mine.png' }, body: PNG })).json();
  assert.equal((await cardWith([mine.file.id])).status, 400, 'only files this service uploaded');
  assert.equal((await cardWith(ups[4].id)).status, 400, 'a list, not a bare id');
  assert.equal((await cardWith([ups[4].id, ups[4].id])).status, 400, 'no duplicates');
  assert.equal((await cardWith([ups[4].id], { chat_id: 'room' })).status, 403, 'still never the room');

  // Edits change text, buttons and the outcome; the pictures stay.
  const patch = (body) => fetch(`${base}/svc/v1/messages/${three.id}`, botReq(APPROVALS, body, 'PATCH')).then((r) => r.json());
  assert.equal((await patch({ text: 'Approve these three?' })).message.attachments.length, 3);
  const done = await patch({ buttons: null, resolved: { label: 'Approve' } });
  assert.equal(done.message.resolved.label, 'Approve');
  assert.deepEqual(done.message.attachments.map((a) => a.id), ups.slice(1, 4).map((f) => f.id), 'resolved cards keep their images');
});

test('typing send to a waiting card slides it; a bare yes only as a reply; choices and chat stay chat', async () => {
  const cookie = await signIn();
  const svc = (body) => fetch(`${base}/svc/v1/messages`, botReq(APPROVALS, body));
  const say = (text, extra = {}) => fetch(`${base}/api/chats/dm-ben/messages`, json(cookie, { text, ...extra })).then((r) => r.json());
  const card = async (n, label = 'Approve') => (await (await svc({ as: 'ben', chat_id: 'dm-ben', text: `Card #${n}`,
    buttons: [[{ label, data: `a|${n}|h`, style: 'primary' }, { label: 'Decline', data: `n|${n}|h`, style: 'danger' }]] })).json()).message;
  const samMessages = () => store.botEventsAfter('ben', 0).filter((e) => e.kind === 'message').length;

  const c1 = await card(101);
  let before = samMessages();
  const sent = await say('Send');
  assert.equal(sent.message.text, 'Send', 'the words still show in the thread');
  assert.equal(store.message(c1.id).resolved.label, 'Approve', 'typed send approves the newest card');
  assert.equal(store.message(c1.id).resolved.by, 'alex');
  assert.equal(samMessages(), before, 'and does not wake the bot');

  const c2 = await card(102);
  await say('yes');
  assert.equal(store.message(c2.id).resolved, null, 'a bare yes that is not a reply does nothing to the card');
  await say('ok', { reply_to: c2.id });
  assert.equal(store.message(c2.id).resolved.label, 'Approve', 'a yes replying to the card approves it');

  const c3 = await card(103);
  await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: 'Want me to draft it?' }));
  before = samMessages();
  await say('send it');
  assert.equal(store.message(c3.id).resolved, null, 'send only counts when the card is the newest message');
  assert.equal(samMessages(), before + 1, 'then it is ordinary chat for the bot');
  await say('Send.', { reply_to: c3.id });
  assert.equal(store.message(c3.id).resolved.label, 'Approve', 'unless he replies to the card');

  const c4 = await card(104, 'Option A');
  await say('send');
  assert.equal(store.message(c4.id).resolved, null, 'a choice card is never answered by typing');
  const c5 = await card(105);
  await say('send it to Pat instead');
  assert.equal(store.message(c5.id).resolved, null, 'only the bare words count');
});

test('reactions, reads and uploads', async () => {
  const cookie = await signIn();
  const m = await (await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: 'photo next' }))).json();
  const r = await (await fetch(`${base}/api/messages/${m.id}/react`, json(cookie, { emoji: '❤️' }))).json();
  assert.deepEqual(r.message.reactions, [{ member_id: 'alex', emoji: '❤️' }]);
  assert.equal((await fetch(`${base}/api/messages/${m.id}/react`, json(cookie, { emoji: '🍕' }))).status, 400);
  await fetch(`${base}/api/chats/dm-ben/read`, json(cookie, { last_id: m.id }));
  const b = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal(b.chats.find((c) => c.id === 'dm-ben').unread, 0);

  const up = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, 'content-type': 'image/png', 'x-file-name': 'shot.png' }, body: Buffer.from('89504e47', 'hex') })).json();
  assert.match(up.file.id, /^[a-f0-9]{32}$/);
  const got = await fetch(`${base}${up.file.url}`, { headers: { cookie } });
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}${up.file.url}`)).status, 401);
  const withPic = await (await fetch(`${base}/api/chats/dm-ben/messages`, json(cookie, { text: '', attachments: [up.file.id], client_id: 'pic-1' }))).json();
  assert.equal(withPic.message.attachments[0].name, 'shot.png');
});

test('the sign-in code works once when pasted into the app (whole link or bare code)', async () => {
  const token = store.mintLoginToken();
  const ok = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `http://x/login?t=${token}` }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).status, 200);
  const again = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: token }) });
  assert.equal(again.status, 403);
});

test('cross-origin posts are refused', async () => {
  const cookie = await signIn();
  const r = await fetch(`${base}/api/chats/dm-ben/messages`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"text":"x"}' });
  assert.equal(r.status, 403);
});

test('the page carries the release id', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html, /__BUILD__/);
  assert.match(html, /name="holler-build" content="[^"]+"/);
});

test('static files cannot escape the web folder', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status, 404);
});

test('push payload decrypts with the subscriber keys (RFC 8291)', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const body = encryptPayload('{"title":"Ben"}', keys);
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const h = (k, d) => createHmac('sha256', k).update(d).digest();
  const shared = ua.computeSecret(asPublic);
  const ikm = h(h(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(out.subarray(0, out.length - 1).toString(), '{"title":"Ben"}');
  assert.equal(out[out.length - 1], 2);
  assert.match(vapidAuthHeader('https://web.push.apple.com/abc', { ...generateVapidKeys(), subject: 'https://example.com' }), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

test('later: a bot files his reminder off the chat; it lists, rings once when due, and he can move, finish and undo it', async () => {
  const cookie = await signIn();
  const svc = (body, method = 'POST', path = '/svc/v1/later') => fetch(`${base}${path}`, botReq(APPROVALS, body, method));
  const api = (path, body, method = 'POST') => fetch(`${base}${path}`, json(cookie, body, method));
  store.addPushSub({ endpoint: 'https://push.example/later', keys: { p256dh: 'x', auth: 'y' } });
  const before = (await (await fetch(`${base}/api/later`, { headers: { cookie } })).json()).items.length;

  // Refusals: no bot, no words, a bad time, another bot's thread.
  assert.equal((await svc({ text: 'Do the pictures' })).status, 400);
  assert.equal((await svc({ as: 'ben', text: '  ' })).status, 400);
  assert.equal((await svc({ as: 'ben', text: 'Do the pictures', due_at: 'Thursday' })).status, 400);
  assert.equal((await svc({ as: 'ben', text: 'Do the pictures', chat_id: 'dm-ada' })).status, 403);
  const other = await (await fetch(`${base}/bot/v1/messages`, botReq(DARLENE, { chat_id: 'dm-ada', text: 'Ada here' }))).json();
  assert.equal((await svc({ as: 'ben', text: 'Do the pictures', reply_to: other.id })).status, 400, 'reply_to must be in the bot\'s own thread');

  // Ben files "do the pictures Thursday" under Alex's ask.
  const ask = await (await api('/api/chats/dm-ben/messages', { text: 'remind me to do the pictures on Thursday', client_id: 'later-ask-1' })).json();
  const due = Date.now() + 3600000;
  const r1 = await (await svc({ as: 'ben', text: 'Do the pictures for Hal', client: 'Birch Mechanical', reply_to: ask.message.id, due_at: new Date(due).toISOString() })).json();
  assert.equal(r1.item.chat_id, 'dm-ben');
  assert.equal(r1.item.message_id, ask.message.id);
  assert.equal(r1.item.by, 'ben');
  assert.equal(r1.item.due_at, due);
  // A park with no date, in Ben's DM by default.
  const r2 = await (await svc({ as: 'ben', text: 'Look at the gas logs idea' })).json();
  assert.equal(r2.item.due_at, null);
  assert.equal(r2.item.chat_id, 'dm-ben');
  // Asked twice: the one item moves, no second one.
  const again = await (await svc({ as: 'ben', text: 'do the pictures for hal', due_at: due + 60000 })).json();
  assert.equal(again.item.id, r1.item.id);
  assert.equal(again.item.due_at, due + 60000);

  const list = (await (await fetch(`${base}/api/later`, { headers: { cookie } })).json()).items;
  assert.equal(list.length, before + 2);
  const mine = list.filter((x) => [r1.item.id, r2.item.id].includes(x.id)).map((x) => x.id);
  assert.deepEqual(mine, [r1.item.id, r2.item.id], 'dated first, undated after');
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  assert.ok(boot.later.some((x) => x.id === r1.item.id), 'bootstrap carries the list');

  // The app hears changes live.
  const ev = readEvents(`${base}/api/events`, { cookie }, 1);
  await new Promise((r) => setTimeout(r, 80));
  await api(`/api/later/${r2.item.id}`, { due_at: due + 7200000 }, 'PATCH');
  const got = await ev;
  assert.equal(got[0].event, 'later');
  assert.ok(got[0].data.items.some((x) => x.id === r2.item.id && x.due_at === due + 7200000));

  // Rings once when due, pointing home.
  pushes.length = 0;
  assert.equal((await app.ringLater(due - 1000)).length, 0, 'not before it is due');
  const rang = await app.ringLater(due + 61000);
  assert.deepEqual(rang.map((x) => x.id), [r1.item.id]);
  const push = pushes.find((d) => d.tag === `later-${r1.item.id}`);
  assert.equal(push.title, 'Reminder');
  assert.equal(push.body, 'Do the pictures for Hal\nBirch Mechanical · from Ben');
  assert.equal(push.route, '#/later');
  assert.equal((await app.ringLater(due + 120000)).length, 0, 'never twice');
  // Snoozing makes it ring again at the new time.
  await api(`/api/later/${r1.item.id}`, { due_at: due + 86400000 }, 'PATCH');
  assert.deepEqual((await app.ringLater(due + 86400000 + 1)).map((x) => x.id), [r2.item.id, r1.item.id], 'both due by then, in due order, each once');

  // He finishes it (and Undo puts it back), parks his own from a message, and deletes one.
  const done = await (await api(`/api/later/${r1.item.id}`, { done: true }, 'PATCH')).json();
  assert.ok(done.item.done_at);
  assert.ok(!(await (await fetch(`${base}/api/later`, { headers: { cookie } })).json()).items.some((x) => x.id === r1.item.id));
  await api(`/api/later/${r1.item.id}`, { done: false }, 'PATCH');
  assert.ok((await (await fetch(`${base}/api/later`, { headers: { cookie } })).json()).items.some((x) => x.id === r1.item.id));
  const own = await (await api('/api/later', { text: 'Call Hal back', message_id: ask.message.id })).json();
  assert.equal(own.item.by, 'alex');
  assert.equal(own.item.chat_id, 'dm-ben');
  assert.equal((await api(`/api/later/${own.item.id}`, {}, 'DELETE')).status, 200);
  assert.equal((await api(`/api/later/${own.item.id}`, {}, 'DELETE')).status, 404);
  // A bot can mark one done when it sees he did it.
  const bdone = await (await svc({ done: true }, 'PATCH', `/svc/v1/later/${r2.item.id}`)).json();
  assert.ok(bdone.item.done_at);
  assert.equal((await fetch(`${base}/api/later`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"text":"x"}' })).status, 403, 'same origin only');
});

// A real PNG of random pixels (does not compress), w x h, RGB.
function noisePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i++) raw[i] = (i % (w * 3 + 1)) === 0 ? 0 : (Math.random() * 256) | 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('pictures: the app gets each one\'s shape and a small preview; the original stays a tap away; a push carries the previews', async () => {
  const { sizeOf } = await import('../server/media.mjs');
  const cookie = await signIn();
  const big = noisePng(1170, 1960);
  assert.ok(big.length > 2_000_000);
  const up = await (await fetch(`${base}/bot/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${SAM}`, 'content-type': 'image/png', 'x-file-name': 'Phone 4 - The math.png' }, body: big })).json();
  assert.equal(up.file.width, 1170);
  assert.equal(up.file.height, 1960);
  assert.equal(up.file.preview, `/files/${up.file.id}/p`);
  pushes.length = 0;
  const posted = await (await fetch(`${base}/bot/v1/messages`, botReq(SAM, { chat_id: 'dm-ben', text: 'The four pages.', attachments: [up.file.id] }))).json();
  const att = posted.message?.attachments?.[0] || store.message(posted.id).attachments[0];
  assert.deepEqual([att.width, att.height, att.preview], [1170, 1960, `/files/${up.file.id}/p`], 'messages carry the shape and the preview');
  await new Promise((r) => setTimeout(r, 80));
  const ring = pushes.find((d) => d.body === 'The four pages.');
  assert.deepEqual(ring?.images, [`/files/${up.file.id}/p`], 'the push names the previews so the phone can fetch them first');

  const pv = await fetch(`${base}${up.file.preview}`, { headers: { cookie } });
  assert.equal(pv.status, 200);
  assert.equal(pv.headers.get('content-type'), 'image/jpeg');
  assert.match(pv.headers.get('cache-control'), /immutable/);
  const pvBytes = Buffer.from(await pv.arrayBuffer());
  const d = sizeOf(pvBytes);
  assert.ok(d.w <= 840 && d.h <= 1400 && Math.abs(d.w / d.h - 1170 / 1960) < 0.01, `preview fits 840 x 1400 at the same shape (${d.w} x ${d.h})`);
  assert.ok(pvBytes.length < big.length / 2, `preview is much smaller (${pvBytes.length} vs ${big.length})`);
  const orig = await fetch(`${base}${up.file.url}`, { headers: { cookie } });
  assert.equal(Buffer.from(await orig.arrayBuffer()).length, big.length, 'the original is untouched');
  assert.equal((await fetch(`${base}/files/${up.file.id}/x`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}${up.file.preview}`)).status, 401, 'previews need sign-in like files');

  // A small picture that already fits is sent as it is.
  const small = noisePng(200, 150);
  const s2 = await (await fetch(`${base}/bot/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${SAM}`, 'content-type': 'image/png', 'x-file-name': 'tiny.png' }, body: small })).json();
  assert.equal(s2.file.preview, s2.file.url);

  // Pictures stored before today get their shape and preview.
  store.setFileSize(up.file.id, null, null);
  const warm = await app.warmPreviews();
  assert.ok(warm.sized >= 1);
  assert.equal(store.file(up.file.id).width, 1170);

  // Shape reader: a phone photo stored on its side (EXIF orientation 6) reads as the browser shows it.
  const exif = Buffer.from('4d4d002a00000008000101120003000000010006000000000000', 'hex');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 8]), Buffer.from('Exif\0\0'), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(16)]);
  assert.deepEqual(sizeOf(jpeg), { w: 100, h: 200, alpha: false });
  assert.deepEqual(sizeOf(Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(16)])), { w: 200, h: 100, alpha: false });
});

test('said: the approvals service reads one of his messages by id or as his last in a thread (11-11)', async () => {
  const cookie = await signIn();
  const svc = (path) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${APPROVALS}` } });
  const mine = (await (await fetch(`${base}/api/chats/dm-eli/messages`, json(cookie, { text: 'Yeah, text that 11 works', client_id: 'said-1' }))).json()).message;
  const byId = await (await svc(`/svc/v1/said?id=${mine.id}&chat_id=dm-eli`)).json();
  assert.deepEqual(Object.keys(byId.message).sort(), ['at', 'chat_id', 'id', 'kind', 'sender', 'text']);
  assert.equal(byId.message.sender, 'alex');
  assert.equal(byId.message.chat_id, 'dm-eli');
  assert.equal(byId.message.text, 'Yeah, text that 11 works');
  store.postMessage({ chatId: 'dm-eli', sender: 'eli', text: 'On it.' });
  const last = await (await svc('/svc/v1/said?id=last&chat_id=dm-eli')).json();
  assert.equal(last.message.id, mine.id, 'last is his newest message, never the bot\'s');
  assert.equal((await svc('/svc/v1/said?id=last&chat_id=dm-cleo')).status, 404, 'nothing of his in that thread');
  assert.equal((await svc('/svc/v1/said?id=99999&chat_id=dm-eli')).status, 404);
  assert.equal((await svc('/svc/v1/said?id=abc&chat_id=dm-eli')).status, 404);
  assert.equal((await fetch(`${base}/svc/v1/said?id=last&chat_id=dm-ben`, { headers: { authorization: `Bearer ${SAM}` } })).status, 401, 'bots cannot read it');
});
