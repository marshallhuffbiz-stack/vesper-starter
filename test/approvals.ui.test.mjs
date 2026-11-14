// Approvals view in WebKit (Safari's engine) against a throwaway server with seeded bot cards.
// Opt-in, so `npm test` and the deploy gate stay fast:
//
//   HOLLER_UI=1 node --test test/approvals.ui.test.mjs      (screenshots in /tmp/holler-approvals)
//
// Browsers come from Holler's private folder (see tools/shots.mjs), never the shared cache.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { Store, sha256 } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { generateVapidKeys } from '../server/push.mjs';

const ON = process.env.HOLLER_UI === '1';
const PW = process.env.VESPER_PLAYWRIGHT || 'playwright-core'; // npm i -D playwright-core, or a path to its index.mjs
const OUT = process.env.HOLLER_SHOTS || '/tmp/holler-approvals';
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const SVC = 'approvals-ui-token-0123456789abcdef';
const TOKENS = { ben: 'ben-ui-token-0123456789abcdef', ada: 'ada-ui-token-0123456789abcdef', cleo: 'cleo-ui-token-0123456789abcdef' };
// iPhone 15 Pro safe areas, as in tools/shots.mjs.
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';

let dir, store, app, server, base, browser;

before(async () => {
  if (!ON) return;
  dir = mkdtempSync(join(tmpdir(), 'holler-ui-'));
  mkdirSync(join(dir, 'files'));
  mkdirSync(OUT, { recursive: true });
  store = new Store(join(dir, 'holler.db'));
  const botTokens = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, sha256(v)]));
  app = createApp({ store, config: { vapid: generateVapidKeys(), pushSubject: 'https://example.com', botTokens, serviceTokens: { approvals: sha256(SVC) } }, filesDir: join(dir, 'files'), staticDir: WEB, pushImpl: async () => ({ ok: true, status: 201 }) });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
  const { webkit } = await import(PW);
  browser = await webkit.launch();
});

after(async () => {
  if (!ON) return;
  await browser?.close();
  app.close(); server.closeAllConnections(); server.close(); store.close();
  rmSync(dir, { recursive: true, force: true });
});

const bot = (who, path, body, method = 'POST') => fetch(`${base}${path}`, {
  method, headers: { authorization: `Bearer ${TOKENS[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => { assert.ok(r.ok, `${method} ${path} -> ${r.status}`); return r.json(); });

const say = (who, chat_id, text) => bot(who, '/bot/v1/messages', { chat_id, text });
async function card(who, chat_id, text, { always = null, agoMs = 0 } = {}) {
  const row = [{ label: 'Approve', data: `a|${text.length}|${Math.random()}`, style: 'primary' }, { label: 'Decline', data: `n|${Math.random()}`, style: 'danger' }];
  if (always) row.push({ label: always, data: `al|${Math.random()}` });
  const r = await bot(who, '/bot/v1/messages', { chat_id, text, buttons: [row] });
  if (agoMs) store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - agoMs, r.id);
  return r.id;
}

// A small real PNG: a diagonal two-color gradient with a pale panel, so crops and letterboxing show.
function png(w, hgt, c1, c2) {
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / hgt) / 2;
      const panel = x > w * 0.12 && x < w * 0.88 && y > hgt * 0.62 && y < hgt * 0.86;
      for (let k = 0; k < 3; k++) raw[row + 1 + x * 3 + k] = panel ? 245 : Math.round(c1[k] + (c2[k] - c1[k]) * t);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The Approvals service's side of the contract: raw bytes plus X-File-Name, then attachments: [ids].
async function svcUpload(bytes, name) {
  const r = await fetch(`${base}/svc/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${SVC}`, 'content-type': 'image/png', 'x-file-name': name }, body: bytes });
  assert.equal(r.status, 200);
  return (await r.json()).file.id;
}
async function svcCard(as, text, attachments) {
  const r = await fetch(`${base}/svc/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${SVC}`, 'content-type': 'application/json' },
    body: JSON.stringify({ as, chat_id: `dm-${as}`, text, attachments, buttons: [[{ label: 'Approve', data: `a|${Math.random()}`, style: 'primary' }, { label: 'Decline', data: `n|${Math.random()}`, style: 'danger' }]] }) });
  assert.equal(r.status, 200);
  return (await r.json()).id;
}
const svcPatch = (id, body) => fetch(`${base}/svc/v1/messages/${id}`, { method: 'PATCH', headers: { authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const resolveLeftovers = () => {
  for (const row of store.db.prepare("SELECT id, buttons FROM messages WHERE kind = 'card' AND resolved IS NULL").all()) {
    store.press(row.id, 'alex', JSON.parse(row.buttons).flat()[0].data);
  }
};

async function page(viewport, { touch }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: touch ? 3 : 2, hasTouch: touch, isMobile: touch, colorScheme: 'light', reducedMotion: 'no-preference' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|access control/.test(m.text())) errs.push(m.text()); });
  if (touch) await p.addInitScript((css) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, SAFE);
  await p.goto(`${base}/login?t=${store.mintLoginToken()}`);
  await p.goto(`${base}/#/`);
  await p.waitForFunction(() => document.body.classList.contains('ready'));
  await p.waitForTimeout(400);
  return { p, ctx, errs };
}

const ids = (p) => p.evaluate(() => [...document.querySelectorAll('#msgs > .ap-item:not(.leaving)')].map((e) => Number(e.dataset.id)));
const waitIds = (p, want) => p.waitForFunction((w) => JSON.stringify([...document.querySelectorAll('#msgs > .ap-item:not(.leaving)')].map((e) => Number(e.dataset.id))) === JSON.stringify(w)
  && !document.querySelector('#msgs > .ap-item.leaving'), want, { timeout: 5000 });

// Drag a card's knob to the end of its track, the way a thumb would.
async function slide(p, id, scope = '#msgs') {
  const knob = p.locator(`${scope} .appr[data-id="${id}"] .appr-knob`);
  await knob.scrollIntoViewIfNeeded();
  const k = await knob.boundingBox();
  const track = await p.locator(`${scope} .appr[data-id="${id}"] .appr-track`).boundingBox();
  await p.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
  await p.mouse.down();
  await p.mouse.move(track.x + track.width + 10, k.y + k.height / 2, { steps: 12 });
  await p.mouse.up();
}

// No horizontal scroll and nothing poking out of the column.
const layout = (p) => p.evaluate(() => {
  const sc = document.querySelector('#scroller');
  const col = document.querySelector('#msgs').getBoundingClientRect();
  const out = [...document.querySelectorAll('.ap-item, .ap-ctx, .appr, .ap-media, .ap-att')].filter((e) => { const r = e.getBoundingClientRect(); return r.left < col.left - 0.5 || r.right > col.right + 0.5; }).length;
  const ctxH = [...document.querySelectorAll('.ap-ctx')].map((e) => Math.round(e.getBoundingClientRect().height));
  return { hscroll: sc.scrollWidth > sc.clientWidth, out, ctxH, width: innerWidth };
});

test('phone: the Needs you rows open Approvals; slide, Decline, Always, live arrivals and withdrawals', { skip: !ON && 'set HOLLER_UI=1' }, async () => {
  await say('ben', 'dm-ben', 'Morning. Two things for you today.');
  const room = await card('ada', 'room', 'Approval needed: send the **Gale weekly digest** to Gale now?', { agoMs: 26 * 3600000 });
  const long = await card('ben', 'dm-ben', `Approval needed: post the Cedar fall menu carousel to Instagram and Facebook.

**Plan**
1. Upload the six slides from the pick board (Lee approved them Tuesday).
2. Caption: "Fall on the porch. Pumpkin chai, apple cider donuts and the soup of the week, every Saturday through November."
3. Schedule for Thursday 11:30 AM, first comment with the hours and the address.
4. Boost nothing; the organic post only. I will check reach Friday and tell you how it did.`, { agoMs: 3 * 3600000 + 600000 });
  const always = await card('cleo', 'dm-cleo', 'Approval needed: reply to the Dune vendor who asked about Saturday load-in times?', { always: 'Always: Dune vendor replies', agoMs: 12 * 60000 });

  const { p, errs } = await page({ width: 390, height: 844 }, { touch: true });
  const pill = await p.locator('#waiting').innerText();
  assert.match(pill, /^Needs you/);
  assert.equal(await p.locator('#waiting .need').count(), 3, 'one row per waiting card');
  const marks = await p.locator('#waiting .need .appmark').count();
  assert.equal(marks, 3, 'each row shows the app it touches');
  const titles = await p.locator('#waiting .need-tx b').allTextContents();
  assert.ok(titles.every((t) => t.length <= 70 && !/#\d|`/.test(t)), `plain titles (${titles.join(' | ')})`);
  await p.screenshot({ path: `${OUT}/01-phone-list.png` });

  const hist = await p.evaluate(() => history.length);
  await p.locator('#waiting .need').first().click();
  await p.waitForFunction(() => document.body.classList.contains('thread-open') && document.querySelector('#thread-pane').classList.contains('appr-view'));
  await p.waitForTimeout(700);
  assert.equal(await p.evaluate(() => location.hash), '#/approvals');
  assert.equal(await p.evaluate(() => history.length), hist, 'touch replaces the route, never pushes (iOS back swipe)');
  assert.deepEqual(await ids(p), [always, long, room], 'newest first (11-11), from every bot');
  assert.equal(await p.locator('#head-name').innerText(), 'Approvals\n3 waiting');
  assert.equal(await p.locator('#composer').isVisible(), false, 'no composer');
  const ctx = await p.locator('.ap-ctx .ap-who').allTextContents();
  const links = await p.locator('.ap-ctx .ap-open').allInnerTexts();
  assert.match(ctx[2], /^Ada\u00a0· Team Room\u00a0· Yesterday \d/);
  const ageShown = await p.evaluate(() => { const a = document.querySelector('.ap-age'); return a.scrollWidth <= a.clientWidth + 0.5 && a.getBoundingClientRect().right <= a.closest('.ap-who').getBoundingClientRect().right + 0.5; });
  assert.ok(ageShown, 'the age is never cut off');
  assert.match(ctx[1], /^Ben\u00a0· 3 h/);
  assert.match(ctx[0], /^Cleo\u00a0· 12 min/);
  assert.deepEqual(links, ['Open chat', 'Open chat', 'Open chat']);
  const l1 = await layout(p);
  assert.equal(l1.hscroll, false);
  assert.equal(l1.out, 0, 'nothing pokes out of the column');
  assert.ok(l1.ctxH.every((hgt) => hgt <= 24), `context lines stay on one line (${l1.ctxH})`);
  await p.screenshot({ path: `${OUT}/02-phone-approvals.png` });

  // More opens the long plan in place, here like in the thread.
  await p.locator(`.ap-item[data-id="${long}"] .appr-more`).click();
  assert.equal(await p.locator(`.ap-item[data-id="${long}"] .appr-more`).getAttribute('aria-expanded'), 'true');
  await p.locator(`.ap-item[data-id="${long}"] .appr-more`).click();
  assert.equal(await p.locator(`.ap-item[data-id="${long}"] .appr-more`).getAttribute('aria-expanded'), 'false');

  // Slide the middle card: that card resolves on the server, eases out, the next moves up.
  await slide(p, long);
  await waitIds(p, [always, room]);
  assert.equal(store.message(long).resolved?.label, 'Approve', 'the slid card is the one approved');
  assert.equal(store.message(room).resolved, null);
  assert.equal(store.message(always).resolved, null);
  assert.equal(await p.locator('#head-name').innerText(), 'Approvals\n2 waiting');
  await p.waitForTimeout(550);
  await p.screenshot({ path: `${OUT}/03-phone-after-slide.png` });

  // A new card on the live stream appears without a reload; one the bot withdraws disappears.
  const fresh = await card('ben', 'dm-ben', 'Approval needed: text Pat the Acme Saturday route?');
  await waitIds(p, [fresh, always, room]);
  await bot('ben', `/bot/v1/messages/${fresh}`, { text: 'Never mind, Pat already has it.', buttons: null }, 'PATCH');
  await waitIds(p, [always, room]);

  // Always and Decline work here too.
  await p.locator(`.appr[data-id="${always}"] .card-quiet.extra`).click();
  await waitIds(p, [room]);
  assert.equal(store.message(always).resolved?.label, 'Always: Dune vendor replies');
  await p.locator(`.appr[data-id="${room}"] .card-quiet.danger`).click();
  await waitIds(p, []);
  assert.equal(store.message(room).resolved?.label, 'Decline');
  await p.waitForSelector('.ap-empty');
  await p.waitForTimeout(500);
  assert.match(await p.locator('.ap-empty').innerText(), /All caught up/);
  assert.equal(await p.evaluate(() => location.hash), '#/approvals', 'the view stays open until he goes back');
  assert.equal(await p.locator('#head-name').innerText(), 'Approvals');
  await p.screenshot({ path: `${OUT}/04-phone-empty.png` });

  // Back returns to the list; the Waiting card is gone.
  await p.locator('#back-btn').click();
  await p.waitForFunction(() => !document.body.classList.contains('thread-open'));
  await p.waitForTimeout(600);
  assert.equal(await p.evaluate(() => document.querySelector('#waiting-wrap').classList.contains('on')), false);

  // Open chat goes to that card in its thread, and the thread's own card still slides.
  const inThread = await card('ben', 'dm-ben', 'Approval needed: pause the Acme lighting ads for the weekend?');
  await p.waitForFunction(() => document.querySelector('#waiting-wrap').classList.contains('on'));
  await p.locator('#waiting .need').first().click();
  await waitIds(p, [inThread]);
  await p.locator(`.ap-item[data-id="${inThread}"] .ap-open`).click();
  await p.waitForFunction(() => location.hash === '#/chat/dm-ben' && !document.querySelector('#thread-pane').classList.contains('appr-view'));
  await p.waitForSelector(`.row[data-key="m:${inThread}"] .appr`);
  assert.equal(await p.locator('#composer').isVisible(), true, 'the composer is back in the thread');
  await p.waitForTimeout(600);
  await slide(p, inThread);
  await p.waitForSelector(`.row[data-key="m:${inThread}"] .card-resolved`);
  assert.equal(store.message(inThread).resolved?.label, 'Approve', 'thread cards still slide normally');
  await p.screenshot({ path: `${OUT}/05-phone-thread-after-slide.png` });
  assert.deepEqual(errs, []);
});

// 11-11: a card carries its own context (agent-team approvals/service.py card_text): Why, the message a reply
// answers, what the slide does, the cost, and who prepared it; the working plan stays behind Details.
test('plain card: why, what a reply answers, what the slide does, the cost and who prepared it', { skip: !ON && 'set HOLLER_UI=1' }, async () => {
  resolveLeftovers();
  const plan = await svcCard('ben', `**Acme Pressure Washing**: get the gutter ads ready, paused (#901)

Why: Pat said in today's meeting he wants gutters pushed through Thanksgiving, and 10% off instead of $100 off.

If you slide: Claude builds two gutter ads in Meta, paused. Nothing goes live; you get one more card with the pictures first.

Cost: No cost now. Later $140 a week, same as today.

Prepared by Claude.

Details:
Ad 1: gutter guards, 10% off. Ad 2: gutter cleaning before the leaves.`);
  const reply = await svcCard('ben', `**Acme Pressure Washing**: keep the weekly ads at 140 (#902)

Replying to Pat, 2:51 PM: \u201cHow much are we spending a week on the ads now?\u201d

Text to Pat Barlow (ends 0100):
"Hey Pat, it's $20 a day right now, about $140 a week."`);
  const { p, ctx, errs } = await page({ width: 390, height: 844 }, { touch: true });
  await p.locator('#waiting .need').first().click();
  await waitIds(p, [reply, plan]);
  await p.waitForTimeout(700);
  const pc = p.locator(`.appr[data-id="${plan}"]`);
  const title = await pc.locator('.ap-title').innerText();
  assert.match(title, /^Get the gutter ads ready, paused$/, title);
  assert.match(await pc.locator('.tk-note').innerText(), /^Pat said in today's meeting he wants gutters pushed/);
  assert.deepEqual(await pc.locator('.pc-k').allInnerTexts(), ['When you slide', 'Cost']);
  const vals = await pc.locator('.pc-v').allInnerTexts();
  assert.match(vals[0], /^Claude builds two gutter ads in Meta, paused/);
  assert.equal(vals[1], 'No cost now. Later $140 a week, same as today.');
  assert.equal(await pc.locator('.pc-by').innerText(), 'Prepared by Claude');
  assert.equal(await pc.locator('.appr-more').innerText(), 'Details');
  const rc = p.locator(`.appr[data-id="${reply}"]`);
  assert.match(await rc.locator('.pc-ans .heard-q').innerText(), /How much are we spending a week/);
  assert.equal(await rc.locator('.pc-ans .heard-w').innerText(), 'Pat · 2:51 PM');
  assert.match(await rc.locator('.tk-bub').innerText(), /^Hey Pat/);
  assert.equal(await rc.locator('.pc').count(), 0, 'a text has no slide rows');
  const l = await layout(p);
  assert.equal(l.hscroll, false);
  assert.equal(l.out, 0);
  await p.screenshot({ path: `${OUT}/05-plain-cards.png` });
  await pc.scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/05b-plain-plan-card.png` });
  await pc.locator('.appr-more').click();
  assert.equal(await pc.locator('.pc').count(), 0, 'Details shows the whole text instead');
  assert.match(await pc.locator('.appr-q').innerText(), /Ad 1: gutter guards/);
  assert.deepEqual(errs, []);
  await ctx.close();
  resolveLeftovers();
});

test('desktop: Approvals sits in the thread pane beside the list', { skip: !ON && 'set HOLLER_UI=1' }, async () => {
  // Start clean even if the phone test stopped partway.
  for (const row of store.db.prepare("SELECT id, buttons FROM messages WHERE kind = 'card' AND resolved IS NULL").all()) {
    store.press(row.id, 'alex', JSON.parse(row.buttons).flat()[0].data);
  }
  const a = await card('ada', 'room', 'Approval needed: move the Birch card pick to Friday and tell Hal?', { agoMs: 50 * 60000 });
  const b = await card('ben', 'dm-ben', `Approval needed: launch the Birch Mechanical six-ad test.

Budget stays inside the monthly cap: **$12 a day** for seven days, three headlines against two photos, Riverside ad set only. I paused the old reach ad so nothing doubles up, and I will send you the first read Tuesday morning before anything changes.`, { agoMs: 20 * 60000 });
  const c = await card('cleo', 'dm-cleo', 'Approval needed: post the Ember Custom wrap reel?', { always: 'Always: Ember reels', agoMs: 2 * 60000 });
  const { p, errs } = await page({ width: 1440, height: 900 }, { touch: false });
  const hist = await p.evaluate(() => history.length);
  await p.locator('#waiting .need').first().click();
  await p.waitForFunction(() => document.querySelector('#thread-pane').classList.contains('appr-view'));
  await p.waitForTimeout(700);
  assert.equal(await p.evaluate(() => history.length), hist + 1, 'desktop pushes the route');
  assert.deepEqual(await ids(p), [c, b, a], 'newest first');
  const l = await layout(p);
  assert.equal(l.hscroll, false);
  assert.equal(l.out, 0);
  await p.screenshot({ path: `${OUT}/06-desktop-approvals.png` });
  await slide(p, c);
  await waitIds(p, [b, a]);
  assert.equal(store.message(c).resolved?.label, 'Approve');
  // A chat picked from the list replaces the view in the pane.
  await p.locator('.chat-row[data-chat="dm-cleo"]').click();
  await p.waitForFunction(() => location.hash === '#/chat/dm-cleo' && !document.querySelector('#thread-pane').classList.contains('appr-view'));
  assert.deepEqual(errs, []);
  assert.ok(existsSync(`${OUT}/06-desktop-approvals.png`));
});

test('card images: one full width, three as an even grid, tap opens the viewer; threads keep them', { skip: !ON && 'set HOLLER_UI=1' }, async () => {
  resolveLeftovers();
  const single = await svcUpload(png(540, 675, [214, 240, 58], [14, 143, 214]), 'consultation-ad.png');
  const triple = [await svcUpload(png(600, 600, [255, 181, 71], [255, 106, 61]), 'square.png'),
    await svcUpload(png(540, 960, [177, 92, 255], [110, 59, 255]), 'story.png'),
    await svcUpload(png(800, 420, [123, 224, 122], [31, 166, 90]), 'banner.png')];
  const one = await svcCard('cleo', 'Approval needed: approve the exact consultation image for the Ember ad?', [single]);

  const { p, errs } = await page({ width: 390, height: 844 }, { touch: true });
  await p.locator('#waiting .need').first().click();
  await p.waitForFunction(() => document.querySelector('#thread-pane').classList.contains('appr-view'));
  await waitIds(p, [one]);
  // A card with three creatives arrives on the live stream while the view is open.
  const three = await svcCard('ben', 'Approval needed: post these three Cedar creatives (feed, story, banner)?', triple);
  await waitIds(p, [three, one]);
  await p.waitForFunction(() => [...document.querySelectorAll('.ap-img')].every((i) => i.complete && i.naturalWidth > 0));
  await p.waitForTimeout(600);
  const m = await p.evaluate(({ one, three }) => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const tiles = [...document.querySelectorAll(`.ap-item[data-id="${three}"] .ap-att`)].map((e) => e.getBoundingClientRect());
    const single = box(`.ap-item[data-id="${one}"] .ap-img`);
    return {
      oneCount: document.querySelectorAll(`.ap-item[data-id="${one}"] .ap-att`).length,
      itemW: Math.round(box(`.ap-item[data-id="${one}"]`).width), singleW: Math.round(single.width), singleH: Math.round(single.height),
      tiles: tiles.map((r) => [Math.round(r.width), Math.round(r.height), Math.round(r.top)]),
      order: [...document.querySelector(`.ap-item[data-id="${one}"]`).children].map((e) => e.className.split(' ')[0]),
    };
  }, { one, three });
  assert.equal(m.oneCount, 1);
  assert.deepEqual(m.order, ['ap-ctx', 'ap-media', 'appr'], 'pictures sit under the context line, above the card');
  assert.equal(m.singleW, m.itemW, 'one image fills the column');
  assert.ok(Math.abs(m.singleH - m.singleW * 1.25) <= 2, `and keeps its 4:5 shape (${m.singleW}x${m.singleH})`);
  assert.equal(m.tiles.length, 3);
  assert.ok(m.tiles.every(([w, hh, top]) => Math.abs(w - m.tiles[0][0]) <= 1 && Math.abs(w - hh) <= 1 && top === m.tiles[0][2]), `three even squares in one row (${JSON.stringify(m.tiles)})`);
  const l = await layout(p);
  assert.equal(l.hscroll, false, 'no horizontal scroll at 390');
  assert.equal(l.out, 0, 'no picture pokes out of the column');
  await p.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
  await p.screenshot({ path: `${OUT}/img-01-phone-approvals.png` });
  await p.locator(`.ap-item[data-id="${three}"]`).scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/img-02-phone-approvals-grid.png` });

  // Tap a picture: the photo viewer opens on it; tap again closes it and the view is still there.
  await p.locator(`.ap-item[data-id="${three}"] .ap-att`).nth(1).click();
  await p.waitForSelector('.viewer.show');
  assert.equal(await p.locator('.viewer img').getAttribute('src'), `/files/${triple[1]}`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/img-03-phone-viewer.png` });
  await p.locator('.viewer').click();
  await p.waitForFunction(() => !document.querySelector('.viewer'));
  assert.equal(await p.evaluate(() => location.hash), '#/approvals');

  // In the thread the waiting card shows its pictures above it; after the slide they stay.
  await p.locator(`.ap-item[data-id="${three}"] .ap-open`).click();
  await p.waitForFunction(() => location.hash === '#/chat/dm-ben');
  const row = `.row[data-key="m:${three}"]`;
  await p.waitForSelector(`${row} .appr`);
  assert.equal(await p.locator(`${row} .att`).count(), 3, 'waiting card in the thread shows its images');
  const above = await p.evaluate((sel) => { const r = document.querySelector(sel); return r.querySelector('.att').getBoundingClientRect().bottom <= r.querySelector('.appr').getBoundingClientRect().top + 1; }, row);
  assert.ok(above, 'images sit above the card');
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/img-04-phone-thread-waiting.png` });
  await slide(p, three);
  await p.waitForSelector(`${row} .card-resolved`);
  assert.equal(store.message(three).resolved?.label, 'Approve');
  assert.equal(await p.locator(`${row} .att`).count(), 3, 'a resolved card keeps its images');
  await p.screenshot({ path: `${OUT}/img-05-phone-thread-resolved.png` });

  // A card the service withdraws keeps its picture in the thread.
  await (await svcPatch(one, { text: 'Withdrawn: Cleo found a newer version.', buttons: null })).json();
  await p.locator('#back-btn').click();
  await p.waitForFunction(() => !document.body.classList.contains('thread-open'));
  await p.waitForTimeout(600);
  await p.locator('.chat-row[data-chat="dm-cleo"]').click();
  await p.waitForSelector(`.row[data-key="m:${one}"] .att`);
  assert.equal(await p.locator(`.row[data-key="m:${one}"] .appr`).count(), 0, 'no longer a waiting card');

  // A bot sends a plain photo the way the Hermes plugin's send_image_file does: raw bytes to
  // /bot/v1/files with X-File-Name, then a message with attachments [id]. Never run in production yet.
  const up = await fetch(`${base}/bot/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${TOKENS.ada}`, 'content-type': 'image/png', 'x-file-name': 'gale-digest-preview.png' }, body: png(720, 540, [177, 92, 255], [47, 211, 198]) });
  assert.equal(up.status, 200);
  const file = (await up.json()).file;
  assert.equal(file.type, 'image/png');
  const sent = await bot('ada', '/bot/v1/messages', { chat_id: 'dm-ada', text: 'Here is the digest preview.', attachments: [file.id] });
  assert.equal(sent.message.attachments[0].id, file.id);
  await p.locator('#back-btn').click();
  await p.waitForFunction(() => !document.body.classList.contains('thread-open'));
  await p.waitForTimeout(600);
  await p.locator('.chat-row[data-chat="dm-ada"]').click();
  const photo = `.row[data-key="m:${sent.id}"] .att[data-view="/files/${file.id}"]`;
  await p.waitForSelector(photo);
  await p.waitForFunction((sel) => { const i = document.querySelector(`${sel} img`); return i && i.complete && i.naturalWidth > 0; }, photo);
  await p.waitForTimeout(500);
  const fit = await p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const sc = document.querySelector('#scroller');
    // The thread hides its drag-left timestamps past the right edge (overflow-x: hidden), so check the page.
    return { w: Math.round(r.width), h: Math.round(r.height), left: r.left, right: r.right, hs: document.documentElement.scrollWidth > innerWidth || getComputedStyle(sc).overflowX !== 'hidden' }; }, photo);
  assert.ok(fit.left >= 0 && fit.right <= 390 && !fit.hs && fit.w >= 200, `bot photo fits the phone (${JSON.stringify(fit)})`);
  await p.screenshot({ path: `${OUT}/img-bot-thread.png` });
  await p.locator(photo).click();
  await p.waitForSelector('.viewer.show');
  assert.equal(await p.locator('.viewer img').getAttribute('src'), `/files/${file.id}`);
  await p.locator('.viewer').click();
  await p.waitForFunction(() => !document.querySelector('.viewer'));
  assert.deepEqual(errs, []);
});
