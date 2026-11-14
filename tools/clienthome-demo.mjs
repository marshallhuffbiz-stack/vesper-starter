#!/usr/bin/env node
// A throwaway Vesper on real server code for the 11-11 changes (home by client, grouped Approvals, bot errors out of
// the threads): its own database and its own team outbox in a temp folder, removed on exit. Never reads the live team.
//
//   node tools/clienthome-demo.mjs [--port 8792]
//
// Seeds tonight's shape: six Acme cards in Ben's thread (one is a sign-in link, so it is never swept), a Claude job
// working for Acme, a Stop-window text for Cedar, single cards for Fjord, Ember and a lead, what settled today in
// the outbox, a silence-marker error after one of Alex's messages, and two plan-limit errors in Cleo's thread.
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store, sha256 } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createTeamOps } from '../server/teamops.mjs';
import { dayStart } from '../server/clienthome.mjs';

const MIN = 60000;
const BUTTONS = (id) => [[{ label: 'Approve', data: `a|${id}|h${id}`, style: 'primary' }, { label: 'Decline', data: `n|${id}|h${id}`, style: 'danger' }]];
const A1_CARDS = [
  [701, 'Keep weekly ads at $140', 'Pat asked in today’s meeting to hold the budget through the holidays.', 'The weekly cap stays at $140 in Meta.', 'No change'],
  [702, 'Stage gutter and lighting ads, 10% off', 'From the finished budget review. Nothing launches without a second look.', 'Claude builds the two ads in Meta, paused.', 'No cost now'],
  [703, 'Stage gutter check and hiring ads', 'The gutter check offer and the applicant campaign come back for the winter.', 'Claude builds both ads, paused.', 'No cost now'],
  [704, 'Swap the coupon to 10%', 'Pat wants one coupon everywhere, 10% off.', 'The website banner and the Facebook offer change to 10%.', 'No cost'],
  [705, 'Remove auto booking from the Page', 'Two jobs booked themselves on days Pat is off.', 'The Book Now button on the Page turns into Call Now.', 'No cost'],
];

export async function startDemo({ port = 0, log = () => {} } = {}) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'vesper-clienthome-demo-'));
  mkdirSync(join(dir, 'files'));
  let fixed = Date.now() - 5 * 60 * MIN;
  const store = new Store(join(dir, 'holler.db'), { now: () => fixed ?? Date.now() });
  // What settled "today" stays today whenever this runs (just after midnight too): times are squeezed into the day so far.
  const sinceMidnight = (Date.now() - dayStart(Date.now())) / MIN;
  const td = (minsAgo) => (sinceMidnight > 330 ? minsAgo : Math.max(1, Math.round((sinceMidnight - 2) * minsAgo / 330)));
  const at = (minsAgo) => { fixed = Date.now() - td(minsAgo) * MIN; };
  const outboxDb = join(dir, 'outbox.db');
  const SVC = 'demo-service-token-0123456789';
  const BOT = (id) => `demo-${id}-token-0123456789`;
  const bots = ['ada', 'ben', 'cleo', 'dora', 'eli'];
  const config = { botTokens: Object.fromEntries(bots.map((b) => [b, sha256(BOT(b))])), serviceTokens: { approvals: sha256(SVC) } };
  const hermes = { runs: () => ({ bots: [] }), agent: () => ({}), searchMemory: () => [] };
  const real = createTeamOps({ outboxDb, pausedFile: join(dir, 'paused.json'), teamDir: dir, backupLog: join(dir, 'backup.log') });
  const teamops = { ...real, catchup: () => ({ since: Date.now() - 3600e3, when: '9:10 AM', paused: [], summary: '4 done · 1 sent on its own', note: null, failed: 0, lines: ['4 done'] }), claudeJobs: () => null };
  const app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(ROOT, 'web'), log, hermes, teamops, system: () => [] });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const say = (body) => call('/svc/v1/messages', SVC, body);
  const bot = (id, body) => call('/bot/v1/messages', BOT(id), body);
  const card = (as, id, client, ask, why, slide, cost, buttons = BUTTONS(id)) => say({ as, chat_id: `dm-${as}`, buttons,
    text: `**${client}**: ${ask} (#${id})\n\nWhy: ${why}\n\nIf you slide: ${slide}\n\nCost: ${cost}.` });

  // Earlier today.
  at(300); await bot('ben', { chat_id: 'dm-ben', text: 'Morning. Acme and Birch were quiet overnight; Cedar had two new followers.' });
  at(260); await bot('cleo', { chat_id: 'dm-cleo', text: 'Dune lineup for Sunday is confirmed: 6 trucks.' });
  at(250); await bot('cleo', { chat_id: 'dm-cleo', text: '⚠️ Heads up: Ember’s card on file expires Friday. Want me to ask Nina for a new one?' });
  // The plan-limit errors Hermes wrote into Cleo's thread (they leave the thread for System).
  at(95); await bot('cleo', { chat_id: 'dm-cleo', text: "⚠️ Cron '[bot:cleo] Client watch' failed: ChatGPT plan sharing limit reached. Manage usage at https://chatgpt.com/#settings/Usage or wait for it to reset. To use Nous credits, pause plan sharing in your Nous settings fi.... See the full run with `hermes cron runs a6998b6365ed` (output saved under ~/" });
  at(90); await bot('cleo', { chat_id: 'dm-cleo', text: "⚠️ Cron '[bot:cleo] Client watch' failed: ChatGPT plan sharing limit reached. Manage usage at https://chatgpt.com/#settings/Usage or wait for it to reset. See the full run with `hermes cron runs a6998b6365ed` (output saved under ~/" });
  // Tonight's Acme cards, a sign-in link card (never swept), the Claude job, the Stop-window text and the singles.
  const ids = {};
  for (const [k, c] of A1_CARDS.entries()) { at(70 - k * 4); ids[c[0]] = (await card('ben', ...c.slice(0, 1), 'Acme Pressure Washing', ...c.slice(1))).message.id; }
  at(44); ids[706] = (await say({ as: 'ben', chat_id: 'dm-ben', text: '**Acme Pressure Washing**: Sign in to Meta so the ad bill can be paid (#706)\n\nWhy: Meta signed the ad account out; the overdue bill is $168.89.',
    buttons: [[{ label: 'Open Meta', url: 'https://business.facebook.com/' }], [{ label: 'Done, I signed in', data: 'a|706|h706', style: 'primary' }]] })).message.id;
  at(40); const job = (await say({ as: 'ben', chat_id: 'dm-ben', work: { job: 'j-water', title: 'Gutter Check cheat sheet for Pat', client: 'Acme', state: 'working', ask: 'A 1 to 2 page sheet Pat can follow in his notebook.',
    steps: [{ text: 'Read the Nov 11 meeting recording', done: true }, { text: 'Took screenshots from the live app', done: true }, { text: 'Building the two pages' }, { text: 'Visual check' }], started_at: Date.now() - 40 * MIN } })).message.id;
  at(30); ids[720] = (await card('dora', 720, 'Fjord Garage Doors', 'Same-day wording fix on the repair page', 'Ron said the page promises same-day on Sundays.', 'The repair page says "same-day, Monday to Saturday".', 'No cost')).message.id;
  at(26); ids[730] = (await card('cleo', 730, 'Ember Custom', 'Post the revised tint ad', 'Nina approved the new wheel photo.', 'The ad goes live on Facebook and Instagram at $10 a day.', '$10 a day')).message.id;
  at(20); ids[740] = (await card('eli', 740, 'Lead: Northside Mobile Welding', 'Text back about the quote', 'He asked for a quote at 6:40 PM from the website form.', 'Eli texts him the checkup offer.', 'No cost')).message.id;
  at(8); ids[750] = (await say({ as: 'ben', chat_id: 'dm-ben', text: '**Cedar Boutique**: Text Lee the new holiday hours (#750)\n\nText to Lee (ends 0122):\n"Hi Lee, the holiday hours are on the site and the Google listing now."\n\nSending in 8 min unless you tap Stop.',
    buttons: [[{ label: 'Stop', data: 's|750|h750', style: 'danger' }]] })).message.id;
  // A message of his that met the silence marker: it shows as not answered, and no error bubble lands.
  at(6); const asked = store.postMessage({ chatId: 'dm-ben', sender: 'alex', text: 'Did Pat pay the invoice yet?' });
  await call('/bot/v1/receipt', BOT('ben'), { message_id: asked.id, state: 'working' });
  at(5); await bot('ben', { chat_id: 'dm-ben', text: '\u26a0\ufe0f The model returned only a silence marker for a message that needed a reply. Try again or rephrase.' });
  await call('/bot/v1/receipt', BOT('ben'), { message_id: asked.id, state: 'done' });
  const db = new DatabaseSync(outboxDb);
  db.exec(`create table actions (id integer primary key, created real, bot text, ask text, kind text, client_id integer, client_name text, contact_name text, status text, auto integer default 0,
    result text, decided_at real, target text, target_display text, card_message_id integer, card_where text)`);
  const ins = db.prepare(`insert into actions (id, created, bot, ask, kind, client_id, client_name, contact_name, status, auto, decided_at, target, target_display, card_message_id, card_where)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const s = (minsAgo) => (Date.now() - minsAgo * MIN) / 1000;
  const t = (minsAgo) => s(td(minsAgo));
  for (const c of A1_CARDS) ins.run(c[0], s(80), 'ben', `Acme: ${c[1]}`, 'task', 2, 'Acme Pressure Washing', null, 'posted', 0, null, 'plan', '', ids[c[0]], 'holler');
  ins.run(706, s(44), 'ben', 'Acme: Sign in to Meta', 'task', 2, 'Acme Pressure Washing', null, 'posted', 0, null, 'plan', '', ids[706], 'holler');
  ins.run(708, s(200), 'ben', 'Acme: Rebuild the winter landing page', 'task', 2, 'Acme Pressure Washing', null, 'doing', 0, s(150), 'plan', '', null, null);
  ins.run(709, t(240), 'ben', 'Acme: Text Pat the payment link', 'text', 2, 'Acme Pressure Washing', 'Pat', 'done', 0, t(230), 'sms', 'Pat', null, null);
  ins.run(710, t(220), 'ben', 'Acme: Post the Sunday before and after', 'task', 2, 'Acme Pressure Washing', null, 'done', 1, t(180), 'plan', '', null, null);
  ins.run(711, t(260), 'dora', 'Fjord: Add 12 negatives', 'task', 9, 'Fjord Garage Doors', null, 'done', 0, t(200), 'plan', '', null, null);
  ins.run(712, t(300), 'dora', 'Fjord: Email Ron the weekly report', 'email', 9, 'Fjord Garage Doors', 'Ron', 'done', 0, t(250), 'email', 'Ron', null, null);
  ins.run(713, t(210), 'eli', 'Lead: Roofing meeting prep', 'task', null, 'Lead: Summit Roofing', null, 'done', 0, t(120), 'plan', '', null, null);
  ins.run(714, s(1700), 'cleo', 'Dune: Halloween captions', 'task', 10, 'Dune Eats', null, 'done', 0, s(1650), 'plan', '', null, null);
  ins.run(720, s(30), 'dora', 'Fjord: Same-day wording fix', 'task', 9, 'Fjord Garage Doors', null, 'posted', 0, null, 'plan', '', ids[720], 'holler');
  ins.run(730, s(26), 'cleo', 'Ember: Post the revised tint ad', 'task', 11, 'Ember Custom', null, 'posted', 0, null, 'plan', '', ids[730], 'holler');
  ins.run(740, s(20), 'eli', 'Lead: Text back about the quote', 'text', null, 'Lead: Northside Mobile Welding', 'Northside', 'posted', 0, null, 'sms', '', ids[740], 'holler');
  ins.run(750, s(9), 'ben', 'Cedar: Text Lee the new holiday hours', 'text', 13, 'Cedar Boutique', 'Lee', 'grace', 1, null, 'sms', '', ids[750], 'holler');
  db.close();
  // Ember's Claude job finished this afternoon.
  at(130); await say({ as: 'cleo', chat_id: 'dm-cleo', work: { job: 'j-tint', title: 'Ember: tint and wheels ads', client: 'Ember', state: 'done', result: 'Six images and the ad copy are done and checked.', finished_at: Date.now() - td(120) * MIN, started_at: Date.now() - td(136) * MIN } });
  fixed = null;
  return { base, dir, store, ids, job, asked: asked.id, close, login: () => `${base}/login?t=${store.mintLoginToken()}`, BOT, SVC };

  function close() { app.close(); server.closeAllConnections(); server.close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--port');
  const demo = await startDemo({ port: pi >= 0 ? Number(args[pi + 1]) : 8792, log: (...a) => console.log('[vesper]', ...a) });
  console.log(`\nVesper demo: ${demo.login().replace('127.0.0.1', 'localhost')}\n(temp data in ${demo.dir}; Ctrl-C removes it)`);
  const bye = () => { demo.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
