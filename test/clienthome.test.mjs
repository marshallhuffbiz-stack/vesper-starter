// 11-11: home by client (GET /api/clients/home and the live 'clients' event) and harness errors kept out of the
// threads (system notes on the System sheet; the silence marker marks his message as not answered).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, sha256 } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createTeamOps } from '../server/teamops.mjs';
import { clientBoard, keyOfCard } from '../server/clienthome.mjs';
import { harnessError, plainError } from '../server/harness.mjs';
import { generateVapidKeys } from '../server/push.mjs';

// 2026-11-11 2:00 PM Eastern
let clock = Date.parse('2026-11-11T19:00:00Z');
let dir, store, app, server, base, cookie, outboxFile;
const pushes = [];
const SAM = 'ben-token-0123456789abcdef';
const APPROVALS = 'approvals-token-0123456789abcdef';
const H = 3600;

function makeOutbox(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`create table if not exists actions (id integer primary key, created real, bot text, ask text, kind text, client_id integer, client_name text,
    contact_name text, status text, auto integer default 0, result text, decided_at real, target text, target_display text, card_message_id integer, card_where text)`);
  db.exec('delete from actions');
  const ins = db.prepare(`insert into actions (id, created, bot, ask, kind, client_id, client_name, contact_name, status, auto, decided_at, target, target_display, card_message_id, card_where)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) ins.run(r.id, r.created ?? clock / 1000 - 2 * H, r.bot ?? 'ben', r.ask, r.kind ?? 'task', r.client_id ?? null, r.client ?? null, r.contact ?? null,
    r.status, r.auto ?? 0, r.decided ?? null, 'plan', '', r.card ?? null, r.card ? 'holler' : null);
  db.close();
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vesper-clienthome-'));
  mkdirSync(join(dir, 'files')); mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Vesper</title>');
  outboxFile = join(dir, 'outbox.db');
  store = new Store(join(dir, 'holler.db'), { now: () => clock });
  const teamops = createTeamOps({ outboxDb: outboxFile, now: () => clock });
  const config = { vapid: generateVapidKeys(), pushSubject: 'https://example.com', botTokens: { ben: sha256(SAM) }, serviceTokens: { approvals: sha256(APPROVALS) } };
  app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(dir, 'web'), teamops, log: () => {},
    pushImpl: async (sub, data) => { pushes.push(data); return { ok: true, status: 201 }; }, system: () => [] });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/login?t=${store.mintLoginToken()}`);
  cookie = res.headers.get('set-cookie').split(';')[0];
  store.addPushSub({ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }, 'test');
});
after(() => { app.close(); server.closeAllConnections(); server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const svc = (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${APPROVALS}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const bot = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${SAM}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const human = (path, body, method = body ? 'POST' : 'GET') => fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const card = (id, client, ask, buttons) => svc('/svc/v1/messages', { as: 'ben', chat_id: 'dm-ben', text: `**${client}**: ${ask} (#${id})\n\nWhy: it is time.`, buttons: buttons || [[{ label: 'Approve', data: `a|${id}|h${id}`, style: 'primary' }, { label: 'Decline', data: `n|${id}|h${id}`, style: 'danger' }]] });

test('the client board groups waiting cards, Claude work and the outbox by client, and leaves quiet clients out', async () => {
  const a = (await card(501, 'Acme Pressure Washing', 'Keep weekly ads at $140')).message;
  const b = (await card(502, 'Acme Pressure Washing', 'Swap the coupon to 10%')).message;
  const lead = (await card(503, 'Lead: Northside Mobile Welding', 'Text back about the quote')).message;
  const stop = (await card(504, 'Cedar Boutique', 'Text Lee the new hours', [[{ label: 'Stop', data: 's|504|h', style: 'danger' }]])).message;
  const work = (await svc('/svc/v1/messages', { as: 'ben', chat_id: 'dm-ben', work: { job: 'j-cheat', title: 'Gutter Check cheat sheet', client: 'Acme', state: 'working', steps: [{ text: 'Read the recording', done: true }, { text: 'Building the two pages' }] } })).message;
  await svc('/svc/v1/messages', { as: 'ben', chat_id: 'dm-ben', work: { job: 'j-old', title: 'Birch flyer', client: 'Birch Mechanical', state: 'done', finished_at: clock - 3 * 86400000 } });
  makeOutbox(outboxFile, [
    { id: 501, ask: 'Acme: Keep weekly ads at $140', client_id: 2, client: 'Acme Pressure Washing', status: 'posted', card: a.id },
    { id: 502, ask: 'Acme: Swap the coupon to 10%', client_id: 2, client: 'Acme Pressure Washing', status: 'posted', card: b.id },
    { id: 510, ask: 'Acme: Stage the gutter ads', client_id: 2, client: 'Acme Pressure Washing', status: 'doing', decided: clock / 1000 - H },
    { id: 511, bot: 'dora', ask: 'Fjord: add 12 negatives', client_id: 9, client: 'Fjord Garage Doors', status: 'done', decided: clock / 1000 - 2 * H },
    { id: 512, bot: 'dora', kind: 'text', ask: 'Fjord: text Ron the recap', client_id: 9, client: 'Fjord Garage Doors', status: 'done', decided: clock / 1000 - H },
    { id: 513, bot: 'cleo', ask: 'Dune: yesterday thing', client_id: 10, client: 'Dune Eats', status: 'done', decided: clock / 1000 - 30 * H, created: clock / 1000 - 31 * H },
  ]);
  const out = await human('/api/clients/home');
  assert.equal(out.outbox, true);
  const by = Object.fromEntries(out.clients.map((c) => [c.key, c]));
  assert.deepEqual(out.clients.map((c) => c.key), ['acme', 'leads', 'cedar', 'fjord'], 'need first, then motion, then done; Dune (yesterday) and Birch (old job) stay out');
  assert.deepEqual(by.acme.need, [a.id, b.id]);
  assert.equal(by.acme.name, 'Acme Pressure Washing');
  assert.equal(by.acme.owner, 'ben');
  assert.deepEqual(by.acme.motion.map((x) => [x.kind, x.title, x.word]), [['work', 'Gutter Check cheat sheet', 'Working'], ['action', 'Stage the gutter ads', 'Working']]);
  assert.equal(by.acme.motion[0].step, 'Building the two pages');
  assert.equal(by.acme.motion[0].message_id, work.id);
  assert.equal(by.acme.line, 'Claude working on Gutter Check cheat sheet');
  assert.deepEqual(by.leads.need, [lead.id]);
  assert.equal(by.leads.owner, 'eli');
  assert.deepEqual(by['cedar'].need, [], 'a send in its Stop window is In motion, not Needs you');
  assert.equal(by['cedar'].motion[0].kind, 'stop');
  assert.equal(by['cedar'].motion[0].message_id, stop.id);
  assert.deepEqual(by.fjord.done.map((x) => [x.title, x.word]), [['Text Ron the recap', 'Sent'], ['Add 12 negatives', 'Done']], 'newest first; a text that went reads Sent');
  assert.equal(by.fjord.done_line, '2 done today');
  assert.equal(out.map[a.id], 'acme');
  assert.equal(out.map[lead.id], 'leads');
});

test('the board works without an outbox, and its card reading matches the app', () => {
  const fake = { clientActions: () => null };
  const out = clientBoard({ store, teamops: fake, now: clock });
  assert.equal(out.outbox, false);
  assert.ok(out.clients.find((c) => c.key === 'acme').need.length >= 2, 'need still comes from the threads');
  assert.equal(clientBoard({ store, teamops: {}, now: clock }).outbox, false);
  assert.equal(keyOfCard('Doing: **Dune Eats**: post the flyer (#4)'), 'dune');
  assert.equal(keyOfCard('**Lead: Pat Smith**: call back (#5)'), 'leads');
  assert.equal(keyOfCard('**Birch County Schools**: a stranger (#6)'), null);
  assert.equal(keyOfCard('Approval needed: run `ls`'), null);
});

test('the board rides the live stream when a card changes', async () => {
  const ctrl = new AbortController();
  const got = [];
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctrl.signal });
  const reading = (async () => { let buf = ''; try { for await (const c of res.body) { buf += Buffer.from(c).toString('utf8'); for (const m of buf.matchAll(/event: clients\ndata: (.*)\n\n/g)) got.push(JSON.parse(m[1])); buf = buf.slice(buf.lastIndexOf('\n\n') + 2); } } catch { /* closed */ } })();
  await new Promise((r) => setTimeout(r, 50));
  const c = (await card(520, 'Fjord', 'Add a Saturday call window')).message;
  await card(521, 'Fjord', 'Raise the budget $5');
  await new Promise((r) => setTimeout(r, 1000));
  ctrl.abort(); await reading;
  assert.equal(got.length, 1, 'one board per burst of changes');
  assert.ok(got[0].clients.find((x) => x.key === 'fjord').need.includes(c.id));
});

// ── harness errors ──────────────────────────────────────────────────────────

const SILENCE = '⚠️ The model returned only a silence marker for a message that needed a reply. Try again or rephrase.';
const PLAN = "⚠️ Cron '[bot:cleo] Client watch' failed: ChatGPT plan sharing limit reached. Manage usage at https://chatgpt.com/#settings/Usage or wait for it to reset. To use Nous credits, pause plan sharing in your Nous settings fi.... See the full run with `hermes cron runs a6998b6365ed` (output saved under ~/";

test('the classifier knows the harness shapes and leaves a bot’s own warning alone', () => {
  assert.equal(harnessError(SILENCE).kind, 'silence');
  assert.equal(harnessError(SILENCE).noAnswer, true);
  const plan = harnessError(PLAN);
  assert.equal(plan.kind, 'cron');
  assert.equal(plan.plan, true);
  assert.equal(plan.noAnswer, false);
  assert.equal(plainError(plan, 'Cleo'), 'The bots are paused: the shared ChatGPT plan hit its sharing limit.');
  assert.equal(plainError(harnessError("⚠️ Cron '[bot:ada] Gale watch' failed: AppFolio signed out. See the full run with `hermes cron runs abc123` (output saved under ~/x)"), 'Ada'),
    "Ada's routine “Gale watch” did not finish: AppFolio signed out.");
  assert.equal(harnessError("⚠️ Something went wrong and I couldn't finish this reply. Use /retry to try again").kind, 'turn');
  assert.equal(harnessError('⚠️ The AI model service kept failing. Use /retry to try again').kind, 'model');
  assert.equal(harnessError('⚠️ Hermes is restarting — your current task will be interrupted. Send any message after the restart').kind, 'gateway');
  // Not harness errors: a bot's own warning, the shape without the sign, Hermes's command card, a file.
  assert.equal(harnessError("⚠️ Heads up: Acme's ad budget runs out tomorrow. Want me to top it up?"), null);
  assert.equal(harnessError('⚠️ The model for the Acme ads is wrong, I fixed the audience.'), null);
  assert.equal(harnessError('The model returned only a silence marker for a message that needed a reply.'), null);
  assert.equal(harnessError("Ben said: ⚠️ Cron 'x' failed: y"), null);
  assert.equal(harnessError('⚠️ Hermes wants to run a command that needs your OK', { buttons: [[{ label: 'Approve once', data: 'ea:1' }]] }), null);
  assert.equal(harnessError(SILENCE, { files: 1 }), null);
});

test('a harness error is no bubble, no push and no unread; it is a system note, and a bot’s own warning still shows', async () => {
  pushes.length = 0;
  const unread0 = store.summary('dm-ben', 'alex').unread;
  const e = await bot('/bot/v1/messages', { chat_id: 'dm-ben', text: PLAN });
  assert.equal(e.message.kind, 'error');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pushes.length, 0, 'no push');
  assert.equal(store.summary('dm-ben', 'alex').unread, unread0, 'not unread');
  const page = await human('/api/chats/dm-ben/messages');
  assert.ok(!page.messages.some((m) => m.id === e.id), 'not in the thread');
  assert.ok(!store.search('alex', { q: 'sharing limit' }).length, 'not in search');
  const sys = await human('/api/system');
  const chk = sys.checks.find((c) => c.key === 'bot-errors');
  assert.equal(chk.level, 'bad');
  assert.equal(chk.detail, 'The bots are paused: the shared ChatGPT plan hit its sharing limit.');
  assert.equal(chk.items[0].raw, PLAN);
  assert.equal(chk.items[0].name, 'Ben');
  // A bot's own warning is a message like any other.
  const own = await bot('/bot/v1/messages', { chat_id: 'dm-ben', text: "⚠️ Heads up: Acme's budget runs out tomorrow." });
  assert.equal(own.message.kind, 'text');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pushes.length, 1, 'it pushes as usual');
  assert.equal(store.summary('dm-ben', 'alex').last.id, own.id);
  // Later in the day, with the plan error three hours old, it is a quiet count.
  clock += 4 * 3600 * 1000;
  const later = (await human('/api/system')).checks.find((c) => c.key === 'bot-errors');
  assert.equal(later.level, 'warn');
  assert.equal(later.detail, '1 bot error today');
  clock -= 4 * 3600 * 1000;
});

test('the silence marker marks his message as not answered, even when the gateway then says done; Send again works', async () => {
  const mine = await human('/api/chats/dm-ben/messages', { text: 'Did Pat pay?' });
  await bot('/bot/v1/receipt', { message_id: mine.message.id, state: 'working' });
  const e = await bot('/bot/v1/messages', { chat_id: 'dm-ben', text: SILENCE });
  assert.equal(e.message.kind, 'error');
  await bot('/bot/v1/receipt', { message_id: mine.message.id, state: 'done' });
  const page = await human('/api/chats/dm-ben/messages');
  const his = page.messages.find((m) => m.id === mine.message.id);
  assert.deepEqual(his.delivery, { state: 'failed', bot: 'ben', tries: 0, why: 'no_answer' });
  const again = await human(`/api/messages/${mine.message.id}/redeliver`, {});
  assert.equal(again.message.delivery, undefined, 'sent again, nothing to flag');
  // A cron failure while he waits on an answer does not touch his message.
  const next = await human('/api/chats/dm-ben/messages', { text: 'And the Acme ads?' });
  await bot('/bot/v1/messages', { chat_id: 'dm-ben', text: "⚠️ Cron '[bot:ben] Client watch' failed: timed out. See the full run with `hermes cron runs ab12`" });
  assert.equal(store.message(next.message.id).delivery, undefined);
});

test('error bubbles from before this release are hidden when the store opens', () => {
  const file = join(dir, 'old.db');
  const old = new Store(file, { now: () => clock });
  const ins = old.db.prepare(`INSERT INTO messages (chat_id, sender, text, kind, created_at) VALUES (?, ?, ?, 'text', ?)`);
  ins.run('dm-cleo', 'cleo', PLAN, clock);
  ins.run('dm-cleo', 'cleo', "⚠️ Heads up: Dune truck count changed.", clock);
  ins.run('dm-cleo', 'alex', SILENCE, clock);
  old.close();
  const again = new Store(file, { now: () => clock });
  const kinds = again.db.prepare('SELECT sender, kind FROM messages ORDER BY id').all().map((r) => `${r.sender}:${r.kind}`);
  assert.deepEqual(kinds, ['cleo:error', 'cleo:text', 'alex:text'], 'only the bot’s harness error; his own words never');
  assert.equal(again.messages('dm-cleo').messages.length, 2);
  assert.equal(again.botErrors(0)[0].plain, 'The bots are paused: the shared ChatGPT plan hit its sharing limit.');
  again.close();
});
