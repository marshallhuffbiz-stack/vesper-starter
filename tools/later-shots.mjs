// Later list and the stuck keyboard height (11-06), in WebKit at iPhone 15 Pro size against the mock server.
//
//   node tools/mock-server.mjs --port 8791 --later &
//   node tools/later-shots.mjs <out-dir>
process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
const { webkit } = await import(process.env.VESPER_PLAYWRIGHT || 'playwright-core');

const out = process.argv[2] || 'tmp/later-shots';
const BASE = process.env.HOLLER_BASE || 'http://127.0.0.1:8791';
const browser = await webkit.launch();
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';

const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|api\/presence due to access control/.test(m.text()) && errs.push(m.text()));
// A Home Screen app, as on his phone.
await p.addInitScript((css) => {
  Object.defineProperty(navigator, 'standalone', { get: () => true });
  document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); });
}, SAFE);
await p.goto(`${BASE}/mock/signin`);
await p.goto(`${BASE}/#/`);
await p.waitForTimeout(1200);

// Home: the due reminder leads Needs you; the rest sit under Later.
const home = await p.evaluate(() => {
  const due = [...document.querySelectorAll('#waiting .need.lt')].map((n) => ({ t: n.querySelector('.need-tx b').textContent, sub: n.querySelector('.need-tx span').textContent, ring: getComputedStyle(n.querySelector('.lt-ring')).boxShadow }));
  const first = document.querySelector('#waiting .cells > *');
  const later = [...document.querySelectorAll('#later .need.lt')].map((n) => ({ t: n.querySelector('.need-tx b').textContent, sub: n.querySelector('.need-tx span').textContent }));
  const label = document.querySelector('#later .sec-label')?.textContent;
  const textLeft = Math.round(document.querySelector('#later .need.lt .need-tx')?.getBoundingClientRect().left || 0);
  const cardLeft = Math.round(document.querySelector('#waiting .need:not(.lt) .need-tx')?.getBoundingClientRect().left || 0);
  return { due, firstIsLt: first?.classList.contains('lt'), later, label, textLeft, cardLeft };
});
check(home.due.length === 1 && home.firstIsLt && home.due[0].t === 'Do the pictures for Hal' && home.due[0].sub === 'Reminder · from Ben',
  `the due reminder is first in Needs you (${JSON.stringify(home.due)})`);
check(/245, 135, 46|rgb\(245/.test(home.due[0]?.ring || ''), `a due reminder has the orange ring (${home.due[0]?.ring})`);
check(home.label === 'Later' && home.later.length === 3 && /^Tomorrow \d/.test(home.later[0].sub) && home.later[2].sub === 'No date',
  `Later lists what is coming up, then the undated one (${home.later.map((x) => `${x.t} [${x.sub}]`).join(' | ')})`);
check(home.cardLeft === 0 || home.textLeft === home.cardLeft, `Later words line up with the card rows (${home.textLeft} vs ${home.cardLeft})`);
await p.screenshot({ path: `${out}/home-later.png` });

// Finish one with the circle; Undo puts it back.
await p.locator('#later .need.lt').first().locator('.lt-check').click();
await p.waitForTimeout(150);
const ringDone = await p.evaluate(() => getComputedStyle(document.querySelector('#later .need.lt.done .lt-ring')).backgroundColor);
await p.waitForTimeout(700);
const afterDone = await p.evaluate(() => ({ n: document.querySelectorAll('#later .need.lt').length, undo: !!document.querySelector('#lt-undo.show') }));
check(/0, 136, 255/.test(ringDone) && afterDone.n === 2 && afterDone.undo, `the circle fills blue, the row leaves and Undo shows (${ringDone}, ${afterDone.n} left)`);
await p.screenshot({ path: `${out}/done-undo.png` });
await p.locator('#lt-undo button').click();
await p.waitForTimeout(600);
const back = await p.evaluate(() => document.querySelectorAll('#later .need.lt').length);
check(back === 3, `Undo brings it back (${back} rows)`);

// Open a row: the sheet, then move it to Tomorrow.
await p.locator('#later .need.lt').nth(1).locator('.lt-open').click();
await p.waitForTimeout(450);
const sh = await p.evaluate(() => {
  const s = document.querySelector('.lt-ov .ed-sheet');
  const r = s?.getBoundingClientRect();
  return { title: s?.querySelector('.lt-title')?.textContent, due: s?.querySelector('.lt-due')?.textContent, meta: s?.querySelector('.lt-meta')?.textContent,
    chips: [...(s?.querySelectorAll('.ch-start') || [])].map((b) => b.textContent), bottom: Math.round(r?.bottom || 0), open: !!s?.querySelector('.lt-link') };
});
check(sh.title === 'Look at the gas logs lead ads budget' && /^Reminds you /.test(sh.due) && /from Ada/.test(sh.meta) && sh.chips.includes('Tomorrow') && sh.chips.includes('No date') && sh.open && sh.bottom <= 852,
  `a Later row opens its sheet (${sh.title} / ${sh.due} / ${sh.meta} / ${sh.chips.join(', ')})`);
await p.screenshot({ path: `${out}/item-sheet.png` });
await p.locator('.lt-ov .ch-start[data-key="tomorrow"]').click();
await p.waitForTimeout(600);
const moved = await p.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, subs: [...document.querySelectorAll('#later .need.lt .need-tx span')].map((s) => s.textContent), sheet: !!document.querySelector('.lt-ov') }));
check(/^Moved to Tomorrow 9 AM/.test(moved.toast) && moved.subs.filter((s) => /^Tomorrow 9 AM/.test(s)).length >= 1 && !moved.sheet, `Tomorrow moves it and says so (${moved.toast}; ${moved.subs.join(' | ')})`);

// The due reminder's sheet says Due and offers Remind me again.
await p.locator('#waiting .need.lt .lt-open').click();
await p.waitForTimeout(450);
const dsh = await p.evaluate(() => ({ head: document.querySelector('.lt-ov .ed-top b')?.textContent, due: document.querySelector('.lt-ov .lt-due')?.textContent, lab: document.querySelector('.lt-ov .lt-lab')?.textContent, note: document.querySelector('.lt-ov .lt-note')?.textContent }));
check(dsh.head === 'Reminder' && /^Due Today/.test(dsh.due) && dsh.lab === 'Remind me again' && /office computer/.test(dsh.note || ''), `a due reminder's sheet (${JSON.stringify(dsh)})`);
await p.locator('.lt-ov .ed-cancel').click();
await p.waitForTimeout(350);

// Long press a message in a chat: Remind me, then Add to Later lands it on home.
await p.goto(`${BASE}/#/chat/dm-ben`);
await p.waitForTimeout(900);
const held = await p.evaluate(async () => {
  const b = [...document.querySelectorAll('.bubble.in')].pop();
  const r = b.getBoundingClientRect();
  const opt = { pointerId: 9, pointerType: 'touch', clientX: r.left + 20, clientY: r.top + 10, bubbles: true, isPrimary: true, button: 0 };
  b.dispatchEvent(new PointerEvent('pointerdown', opt));
  await new Promise((res) => setTimeout(res, 560));
  b.dispatchEvent(new PointerEvent('pointerup', opt));
  return { remind: !!document.querySelector('.lp [data-act="remind"]'), text: b.textContent.slice(0, 60) };
});
check(held.remind, `holding a message offers Remind me (${held.text})`);
await p.waitForTimeout(400);
await p.screenshot({ path: `${out}/hold-menu.png` });
await p.locator('.lp [data-act="remind"]').click();
await p.waitForTimeout(450);
const rs = await p.evaluate(() => ({ head: document.querySelector('.lt-ov .ed-top b')?.textContent, text: document.querySelector('.lt-ov .lt-field')?.value, on: document.querySelector('.lt-ov .ch-start.on')?.textContent }));
check(rs.head === 'Remind me' && rs.text.length > 0 && rs.on === 'Tomorrow', `Remind me opens prefilled, Tomorrow picked (${rs.text} / ${rs.on})`);
await p.locator('.lt-ov .lt-field').fill('Check Ben’s budget note');
await p.locator('.lt-ov .ch-start[data-key="none"]').click();
await p.screenshot({ path: `${out}/remind-sheet.png` });
await p.locator('.lt-ov .ed-send').click();
await p.waitForTimeout(600);
await p.goto(`${BASE}/#/`);
await p.waitForTimeout(900);
const added = await p.evaluate(() => [...document.querySelectorAll('#later .need.lt .need-tx b')].map((b) => b.textContent));
check(added.includes('Check Ben’s budget note'), `the parked message is on home under Later (${added.join(' | ')})`);

// A reminder coming due while the app is open moves up into Needs you on its own.
await p.evaluate(async () => {
  const r = await fetch('/api/later', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Call Hal back', due_at: Date.now() + 1500 }) });
  return r.ok;
});
await p.waitForTimeout(600);
const before = await p.evaluate(() => [...document.querySelectorAll('#later .need-tx b')].some((b) => b.textContent === 'Call Hal back'));
await p.waitForTimeout(1800);
const nowDue = await p.evaluate(() => [...document.querySelectorAll('#waiting .need.lt .need-tx b')].some((b) => b.textContent === 'Call Hal back'));
check(before && nowDue, `a reminder moves from Later into Needs you when it comes due (${before} -> ${nowDue})`);

// The stuck keyboard height: the search field had the keyboard up, then lost focus while the browser still
// reported the short height (back from a call). The app must fill the screen again with the search bar at the bottom.
await p.locator('#search-input').focus();
await p.setViewportSize({ width: 393, height: 520 });
await p.waitForTimeout(400);
const kb = await p.evaluate(() => ({ open: document.documentElement.classList.contains('kb-open'), h: getComputedStyle(document.documentElement).getPropertyValue('--app-h') }));
await p.evaluate(() => document.querySelector('#search-input').blur());
await p.waitForTimeout(900);
const stuck = await p.evaluate(() => ({ open: document.documentElement.classList.contains('kb-open'), h: getComputedStyle(document.documentElement).getPropertyValue('--app-h'), bar: Math.round(document.querySelector('.list-search .search').getBoundingClientRect().bottom) }));
check(kb.open && kb.h === '520px', `with the field focused and the screen short, the keyboard counts as up (${kb.h})`);
check(!stuck.open && stuck.h === '852px' && stuck.bar > 780, `once nothing is focused the app fills the screen again, search bar at the bottom (${stuck.h}, bar bottom ${stuck.bar})`);
await p.setViewportSize({ width: 393, height: 852 });
await p.waitForTimeout(300);
// Coming back to the app re-checks the height.
await p.evaluate(() => { document.documentElement.style.setProperty('--app-h', '500px'); document.dispatchEvent(new Event('visibilitychange')); });
await p.waitForTimeout(900);
const resumed = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h'));
check(resumed === '852px', `returning to the app puts the full height back (${resumed})`);
await p.screenshot({ path: `${out}/home-after.png` });

// Pictures (11-06): nothing downloads at launch; a chat shows the small preview in a box sized before it loads;
// tapping opens the viewer on the preview and switches to the original when it arrives.
const pic = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
const q = await pic.newPage();
await q.addInitScript((css) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, SAFE);
await q.goto(`${BASE}/mock/signin`);
await fetch(`${BASE}/mock/file-hits?reset=1`);
await q.goto(`${BASE}/#/`);
await q.waitForTimeout(1800);
const atLaunch = await (await fetch(`${BASE}/mock/file-hits`)).json();
check(atLaunch.originals === 0 && atLaunch.previews === 0, `opening the app downloads no pictures (${JSON.stringify(atLaunch)})`);
await q.goto(`${BASE}/#/chat/room`);
await q.waitForTimeout(250);
const box = await q.evaluate(() => { const i = document.querySelector('.att-img'); return i ? { src: i.getAttribute('src'), sized: i.classList.contains('sized'), w: i.style.width, h: i.style.height } : null; });
await q.waitForTimeout(900);
const inRoom = await (await fetch(`${BASE}/mock/file-hits`)).json();
check(box && /\/files\/[a-f0-9]{32}\/p$/.test(box.src) && box.sized && box.w && box.h, `a chat picture is the preview, its box sized before it loads (${JSON.stringify(box)})`);
check(inRoom.previews >= 1 && inRoom.originals === 0, `opening the chat fetches only previews (${JSON.stringify(inRoom)})`);
await q.locator('.att').first().click();
const first = await q.evaluate(() => document.querySelector('.viewer img')?.getAttribute('src'));
await q.waitForTimeout(800);
const then = await q.evaluate(() => document.querySelector('.viewer img')?.getAttribute('src'));
check(/\/p$/.test(first || '') && /\/files\/[a-f0-9]{32}$/.test(then || ''), `the viewer opens on the preview, then shows the original (${first} -> ${then})`);
await pic.close();

// Notification tap (11-06: he tapped a notification and the chat did not show it). The app was in the background
// with a silently dead connection; a message lands; he taps the notification. The chat must show that message at
// once (without waiting for the live connection, slow here on purpose), lit, and say "Updating…" while it fetches.
const net = (o) => fetch(`${BASE}/mock/net`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
const nt = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
const n = await nt.newPage();
const nErrs = [];
n.on('pageerror', (e) => nErrs.push(e.message));
await n.addInitScript((css) => {
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
  window.__setVis = (v) => { vis = v; document.dispatchEvent(new Event('visibilitychange')); };
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew; window.__skew = (ms) => { skew += ms; };
  document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); });
}, SAFE);
const away = async (text) => {
  await n.evaluate(() => window.__setVis('hidden'));
  await fetch(`${BASE}/mock/mute`);
  await fetch(`${BASE}/mock/inject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 'dm-cleo', sender: 'cleo', typing_ms: 0, text }) });
  await new Promise((r) => setTimeout(r, 150));
  const id = (await (await fetch(`${BASE}/api/chats/dm-cleo/messages?limit=1`)).json()).messages.at(-1).id;
  await n.evaluate(() => window.__skew(25 * 60 * 1000));
  return id;
};
const tapIt = (id) => n.evaluate((id) => {
  const ev = new MessageEvent('message', { data: { type: 'open-chat', chat_id: 'dm-cleo', message_id: id } });
  if (navigator.serviceWorker) navigator.serviceWorker.dispatchEvent(ev); else location.hash = '#/chat/dm-cleo';
  window.__setVis('visible');
  return !!navigator.serviceWorker;
}, id);
const state = (text) => n.evaluate((text) => {
  const row = [...document.querySelectorAll('.row')].find((r) => r.textContent.includes(text));
  const sync = document.querySelector('#thread-sync');
  return { chat: location.hash, shown: !!row, lit: !!row?.classList.contains('flash'), sync: sync && !sync.hidden ? sync.textContent : '' };
}, text);
await n.goto(`${BASE}/mock/signin`);
await n.goto(`${BASE}/#/chat/dm-ben`);
await n.waitForTimeout(1200);

// 1. The live connection takes 8 s to come back: the chat still shows the message within a second, lit.
let id = await away('Nina 11:06 text: she hopes to get the invoice paid Monday.');
await net({ eventsDelay: 8000 });
const viaSw = await tapIt(id);
await n.waitForTimeout(900);
const t1 = await state('Nina 11:06 text');
check(t1.chat === '#/chat/dm-cleo' && t1.shown && t1.lit && !t1.sync, `a notification tap opens the chat on that message within a second, lit (${JSON.stringify(t1)}, via ${viaSw ? 'service worker message' : 'hash'})`);
await n.screenshot({ path: `${out}/notif-tap.png` });

// 2. A slow fetch: "Updating…" shows under the header until the message is there.
await net({});
id = await away('Second text: Nina moved the sit-down to Tuesday.');
await net({ messagesDelay: 1600, eventsDelay: 8000 });
await tapIt(id);
await n.waitForTimeout(900);
const t2a = await state('Second text');
await n.screenshot({ path: `${out}/notif-updating.png` });
await n.waitForTimeout(1300);
const t2b = await state('Second text');
check(!t2a.shown && /Updating/.test(t2a.sync) && t2b.shown && !t2b.sync, `while the fetch is slow it says Updating, then shows the message (${t2a.sync || 'none'} -> shown ${t2b.shown})`);

// 3. The first two fetches fail (network waking): it retries on its own and gets there.
await net({});
id = await away('Third text: Nina paid.');
await net({ messagesFail: 2, eventsDelay: 8000 });
await tapIt(id);
await n.waitForTimeout(7000);
const t3 = await state('Third text');
check(t3.shown && !t3.sync, `two failed fetches are retried until the message shows (${JSON.stringify(t3)})`);

// 4. It cannot reach the Mac at all: it says so, with Retry, instead of passing the old view off as current.
await net({});
id = await away('Fourth text: never arrives.');
await net({ messagesFail: 50, eventsDelay: 30000 });
await tapIt(id);
await n.waitForTimeout(16000);
const t4 = await state('Fourth text');
await n.screenshot({ path: `${out}/notif-failed.png` });
await net({});
await n.locator('#thread-sync [data-retry]').click().catch(() => {});
await n.waitForTimeout(1200);
const t4b = await state('Fourth text');
check(!t4.shown && /Couldn.t reach the Mac/.test(t4.sync) && t4b.shown && !t4b.sync, `when the Mac cannot be reached it says so, and Retry fetches it (${t4.sync} -> shown ${t4b.shown})`);
check(nErrs.length === 0, `no page errors during the notification checks (${nErrs.join(' / ')})`);
await nt.close();
await net({});

// Dark mode look.
const dark = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true });
const d = await dark.newPage();
await d.addInitScript((css) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, SAFE);
await d.goto(`${BASE}/mock/signin`);
await d.goto(`${BASE}/#/`);
await d.waitForTimeout(1200);
await d.screenshot({ path: `${out}/home-later-dark.png` });

check(errs.length === 0, `no page errors (${errs.join(' / ')})`);
await browser.close();
console.log(results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('ok')).length} ok, ${results.filter((r) => r.startsWith('FAIL')).length} FAIL`);
