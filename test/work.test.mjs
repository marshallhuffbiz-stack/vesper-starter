// 11-11: work cards. A service posts one card per Claude job into the starting bot's thread and keeps it current
// in place; it rings once when it finishes; "Looks good" marks it and wakes nobody; his reply under it goes to the
// service as a work_reply event (never to the bot as a chat turn) and is marked stalled if nobody takes it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sha256, validWork, WORK_REPLY_STALL_MS } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { generateVapidKeys } from '../server/push.mjs';

let dir, store, app, server, base, cookie;
let clock = Date.UTC(2026, 10, 11, 18, 0, 0);
const pushes = [];
const SVC = 'approvals-token-0123456789abcdef';
const SAM = 'ben-token-0123456789abcdef';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vesper-work-'));
  mkdirSync(join(dir, 'files')); mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Vesper</title>');
  store = new Store(join(dir, 'holler.db'), { now: () => clock });
  const config = { vapid: generateVapidKeys(), pushSubject: 'https://example.com', botTokens: { ben: sha256(SAM) }, serviceTokens: { approvals: sha256(SVC) } };
  app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(dir, 'web'), log: () => {},
    pushImpl: async (sub, data) => { pushes.push(data); return { ok: true, status: 201 }; } });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/login?t=${store.mintLoginToken()}`);
  cookie = res.headers.get('set-cookie').split(';')[0];
  store.addPushSub({ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }, 'test');
});

after(() => { app.close(); server.closeAllConnections(); server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const svc = (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const human = (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const eventsFor = (b) => store.db.prepare('SELECT id, kind, payload FROM bot_events WHERE bot = ? ORDER BY id').all(b).map((r) => ({ id: r.id, kind: r.kind, ...JSON.parse(r.payload) }));
const settle = () => new Promise((r) => setTimeout(r, 40));
const START = { job: '1111-1400-ab12', title: 'Gutter Check cheat sheet for Pat', client: 'Acme Pressure Washing', by: 'Ben', state: 'queued',
  ask: 'A 1 to 2 page sheet Pat can follow in his notebook, with a speaking script.', started_at: clock };

let cardId;

test('validWork cleans what a service sends and refuses what makes no sense', () => {
  const w = validWork({ ...START, state: 'working', steps: [{ text: ' Read the recording ', done: true }, 'Build the pages', { text: '' }], url: 'javascript:x', result: 'a\n\n\n\nb', extra: 1 });
  assert.deepEqual(w.steps, [{ text: 'Read the recording', done: true }, { text: 'Build the pages', done: false }]);
  assert.equal(w.url, undefined, 'only http(s) links');
  assert.equal(w.result, 'a\n\nb');
  assert.equal(w.extra, undefined);
  assert.throws(() => validWork({ ...START, state: 'busy' }), /work.state/);
  assert.throws(() => validWork({ ...START, job: 'no spaces allowed' }), /work.job/);
  assert.throws(() => validWork('x'), /object/);
  // acked_at belongs to the server: a service cannot set it, and a new round clears it.
  assert.equal(validWork({ ...START, state: 'done', acked_at: 5 }).acked_at, undefined);
  const acked = { ...validWork({ ...START, state: 'done' }), acked_at: clock };
  assert.equal(validWork({ note: 'x' }, acked).acked_at, clock, 'kept while it stays finished');
  assert.equal(validWork({ state: 'working', round: 2 }, acked).acked_at, undefined, 'a reply round starts fresh');
});

test('a service posts the card quietly into the bot thread, and only a service may', async () => {
  pushes.length = 0;
  const r = await svc('/svc/v1/messages', { as: 'ben', chat_id: 'dm-ben', work: START, client_id: `work-${START.job}` });
  assert.equal(r.status, 200);
  const { message } = await r.json();
  cardId = message.id;
  assert.equal(message.kind, 'work');
  assert.equal(message.work.state, 'queued');
  assert.match(message.text, /^Claude: Gutter Check cheat sheet for Pat \(Acme Pressure Washing\)\nWaiting to start/);
  await settle();
  assert.equal(pushes.length, 0, 'going up never rings');
  const again = await (await svc('/svc/v1/messages', { as: 'ben', chat_id: 'dm-ben', work: START, client_id: `work-${START.job}` })).json();
  assert.equal(again.id, cardId, 'the same job key never posts twice');
  const list = await (await human('/api/bootstrap', null, 'GET')).json();
  assert.equal(list.chats.find((c) => c.id === 'dm-ben').last.work.job, START.job, 'the chat list sees the card data, not raw JSON');
  // A bot cannot post a work card itself (they come from the service that runs the jobs).
  const asBot = await fetch(`${base}/bot/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${SAM}`, 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 'dm-ben', text: 'x', work: START }) });
  assert.equal((await asBot.json()).message?.kind, 'text', 'the bot route ignores work');
});

test('progress changes the one message in place, with no new bubble and no push', async () => {
  pushes.length = 0;
  const seen = [];
  const onMsg = (m) => seen.push(['message', m.id]);
  const onUpd = (m) => seen.push(['update', m.id]);
  store.on('message', onMsg); store.on('update', onUpd);
  const before = store.latestId('dm-ben');
  for (const steps of [[{ text: 'Read the Nov 11 meeting recording', done: false }], [{ text: 'Read the Nov 11 meeting recording', done: true }, { text: 'Build the two pages', done: false }]]) {
    const r = await svc(`/svc/v1/messages/${cardId}`, { work: { state: 'working', steps, active_at: clock, url: 'https://claude.ai/code/session_x' } }, 'PATCH');
    assert.equal(r.status, 200);
  }
  store.off('message', onMsg); store.off('update', onUpd);
  await settle();
  assert.equal(store.latestId('dm-ben'), before, 'no new message');
  assert.deepEqual(seen, [['update', cardId], ['update', cardId]]);
  assert.equal(pushes.length, 0);
  const m = store.message(cardId);
  assert.equal(m.work.steps.length, 2);
  assert.equal(m.work.ask, START.ask, 'fields not sent stay as they were');
  assert.equal(m.work.url, 'https://claude.ai/code/session_x');
  const hit = await (await human('/api/search?q=cheat%20sheet', null, 'GET')).json();
  assert.ok(hit.messages.some((x) => x.id === cardId), 'search finds it by its words');
  assert.equal((await svc(`/svc/v1/messages/${cardId}`, { work: { job: 'other-job' } }, 'PATCH')).status, 400, 'a card stays with its job');
});

test('finishing rings once with its job tag; the files ride on the card', async () => {
  pushes.length = 0;
  const up = await fetch(`${base}/svc/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${SVC}`, 'content-type': 'application/pdf', 'x-file-name': 'Gutter Check.pdf' }, body: Buffer.from('%PDF-1.4\n%%EOF\n') });
  const file = (await up.json()).file;
  const done = { state: 'done', finished_at: clock + 16 * 60000, result: 'The two page sheet is done and checked against the recording.', steps: [{ text: 'Read', done: true }] };
  let r = await svc(`/svc/v1/messages/${cardId}`, { work: done, attachments: [file.id], doc: { title: 'Gutter Check cheat sheet', kind: 'Claude session' } }, 'PATCH');
  assert.equal(r.status, 200);
  const m = (await r.json()).message;
  assert.equal(m.attachments.length, 1);
  assert.equal(m.doc.title, 'Gutter Check cheat sheet');
  await settle();
  assert.equal(pushes.length, 1);
  assert.deepEqual({ title: pushes[0].title, tag: pushes[0].tag }, { title: 'Claude finished', tag: `work-${START.job}` });
  assert.match(pushes[0].body, /^Gutter Check cheat sheet for Pat\nThe two page sheet is done/);
  r = await svc(`/svc/v1/messages/${cardId}`, { work: { ...done, note: 'same state again' } }, 'PATCH');
  await settle();
  assert.equal(pushes.length, 1, 'the same finished state never rings twice');
  assert.equal((await svc(`/svc/v1/messages/${cardId}`, { attachments: ['nope'] }, 'PATCH')).status, 400, 'only files this service uploaded');
  const items = (await (await human('/api/deliverables', null, 'GET')).json()).items;
  assert.ok(items.some((d) => d.id === cardId), 'its files show under Deliverables too');
});

test('Looks good marks the card for every device and wakes nobody', async () => {
  const before = store.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n;
  const latest = store.latestId('dm-ben');
  const r = await human(`/api/messages/${cardId}/work`, { ack: true });
  assert.equal(r.status, 200);
  const m = (await r.json()).message;
  assert.equal(m.work.acked_at, clock);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n, before, 'no bot or service event');
  assert.equal(store.latestId('dm-ben'), latest, 'no new message');
  assert.equal((await human(`/api/messages/${cardId}/work`, {})).status, 400);
  assert.equal((await svc(`/svc/v1/messages/${cardId}`, { work: { note: 'x' } }, 'PATCH').then((x) => x.json())).message.work.acked_at, clock, 'a later edit keeps it');
});

test('his reply under the card goes to the service as work_reply, never to the bot', async () => {
  const before = eventsFor('ben').length;
  const r = await human('/api/chats/dm-ben/messages', { text: 'Make the price smaller on image 3', reply_to: cardId });
  const m = (await r.json()).message;
  assert.equal(m.to_claude, true, 'the app shows "Sent to the same session"');
  assert.equal(m.reply_to.work, true);
  assert.equal(eventsFor('ben').length, before, 'the bot is not woken with it');
  const ev = eventsFor('svc:approvals').filter((e) => e.kind === 'work_reply').at(-1);
  assert.deepEqual({ job: ev.job, text: ev.text, message_id: ev.message_id, card_id: ev.card_id }, { job: START.job, text: 'Make the price smaller on image 3', message_id: m.id, card_id: cardId });
  // The service long poll hands it over with the presses.
  const polled = await (await svc('/svc/v1/updates?offset=0&wait=0', null, 'GET')).json();
  assert.ok(polled.events.some((e) => e.kind === 'work_reply' && e.message_id === m.id));
  // Taken: the service says so, and it never reads as stalled.
  assert.equal((await (await svc('/svc/v1/receipt', { message_id: m.id, state: 'done' })).json()).known, true);
  clock += WORK_REPLY_STALL_MS + 1000;
  const out = await app.sweepDeliveries(clock);
  assert.equal(out.stalled.length, 0);
  assert.equal(store.message(m.id).delivery, undefined);
  // The bot hears about the card (not his words as a request) with his next ordinary message.
  const next = (await (await human('/api/chats/dm-ben/messages', { text: 'Anything else today?' })).json()).message;
  const ctx = eventsFor('ben').filter((e) => e.kind === 'message' && e.message.id === next.id)[0].context || '';
  assert.match(ctx, /Claude job card "Gutter Check cheat sheet for Pat": Finished, Alex marked it looks good/);
});

test('a reply nobody takes in two minutes is stalled; Send again hands the same event over again', async () => {
  pushes.length = 0;
  const m = (await (await human('/api/chats/dm-ben/messages', { text: 'Also the logo bigger', reply_to: cardId })).json()).message;
  let out = await app.sweepDeliveries(clock + 60 * 1000);
  assert.equal(out.stalled.length, 0, 'too soon');
  clock += WORK_REPLY_STALL_MS + 1000;
  out = await app.sweepDeliveries(clock);
  assert.equal(out.stalled.length, 1);
  assert.equal(out.stalled[0].claude, true);
  assert.deepEqual(store.message(m.id).delivery, { state: 'stalled', bot: 'ben', tries: 0, claude: true });
  assert.equal(pushes.at(-1)?.title, 'Your reply has not reached Claude');
  const n = eventsFor('svc:approvals').filter((e) => e.kind === 'work_reply' && e.message_id === m.id).length;
  const r = await human(`/api/messages/${m.id}/redeliver`);
  assert.equal(r.status, 200);
  const evs = eventsFor('svc:approvals').filter((e) => e.kind === 'work_reply' && e.message_id === m.id);
  assert.equal(evs.length, n + 1);
  assert.equal(evs.at(-1).redelivery, 1);
  assert.equal(store.message(m.id).delivery, undefined, 'on its way again');
  await svc('/svc/v1/receipt', { message_id: m.id, state: 'failed' });
  assert.equal(store.message(m.id).delivery.state, 'failed', 'a reply the job could not take shows the failed note');
});

test('a reply round: back to working without a push, then the next finish rings again and needs_you says so', async () => {
  pushes.length = 0;
  let r = await svc(`/svc/v1/messages/${cardId}`, { work: { state: 'working', round: 2, steps: [], result: null, finished_at: null,
    rounds: [{ result: 'The two page sheet is done.', reply: 'Make the price smaller on image 3', finished_at: clock - 60000 }] } }, 'PATCH');
  const m = (await r.json()).message;
  assert.equal(m.work.acked_at, undefined, 'a new round needs a new Looks good');
  assert.equal(m.work.result, undefined);
  assert.equal(m.work.rounds.length, 1);
  assert.equal((await human(`/api/messages/${cardId}/work`, { ack: true })).status, 409, 'not while it works');
  await settle();
  assert.equal(pushes.length, 0);
  r = await svc(`/svc/v1/messages/${cardId}`, { work: { state: 'needs_you', result: 'One thing for you: which logo file?' } }, 'PATCH');
  await settle();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Claude needs you');
  assert.equal(pushes[0].tag, `work-${START.job}`);
});

test('a tapback on a work card never wakes the bot', async () => {
  await human(`/api/messages/${cardId}/react`, { emoji: '❓' });
  const ev = eventsFor('ben').filter((e) => e.kind === 'reaction').at(-1);
  assert.equal(ev.wake, false);
});

test('a job that finishes overnight does not buzz him; the card is there in the morning', async () => {
  const day = clock;
  clock = Date.UTC(2026, 10, 12, 4, 30, 0); // 11:30 PM Eastern
  pushes.length = 0;
  let r = await svc('/svc/v1/messages', { chat_id: 'dm-ben', as: 'ben', text: '', work: { ...START, job: '1111-2330-cd34', state: 'working', started_at: clock } });
  assert.equal(r.status, 200);
  const id = (await r.json()).message.id;
  r = await svc(`/svc/v1/messages/${id}`, { work: { state: 'done', finished_at: clock + 60000, result: 'Done overnight.' } }, 'PATCH');
  assert.equal(r.status, 200);
  await settle();
  assert.equal(pushes.length, 0, 'no push in quiet hours');
  clock = day;
});
