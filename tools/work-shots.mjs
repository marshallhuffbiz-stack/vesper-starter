// Work cards (11-11), in WebKit at iPhone 15 Pro size against the mock server: queued, working, done (with a file),
// needs_you, after a reply (his bubble "Sent to the same session", the card back to working with Earlier), the
// chat list line and the live line under the wordmark. Each state is one card changing in place.
//
//   node tools/mock-server.mjs --port 8793 &
//   node tools/work-shots.mjs <out-dir>
process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
const { webkit } = await import(process.env.VESPER_PLAYWRIGHT || 'playwright-core');

const out = process.argv[2] || 'tmp/work-shots';
const BASE = process.env.HOLLER_BASE || 'http://127.0.0.1:8793';
const browser = await webkit.launch();
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const now = Date.now();
const JOB = {
  job: '1111-1612-ab12', title: 'Gutter Check cheat sheet for Pat', client: 'Acme Pressure Washing', by: 'Ben', state: 'queued',
  ask: 'A 1 to 2 page sheet Pat can follow in his notebook, with a speaking script.', url: 'https://claude.ai/code/session_mock',
};
const STEPS = ['Read the Nov 11 meeting recording', 'Took screenshots from the live app', 'Building the two pages', 'Visual check'];

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: scheme, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|api\/presence due to access control/.test(m.text()) && errs.push(m.text()));
  await p.addInitScript((css) => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); });
  }, SAFE);
  await p.goto(`${BASE}/mock/signin`);
  await p.goto(`${BASE}/#/chat/dm-ben`);
  await p.waitForTimeout(1200);

  const card = await post('/mock/work', { chat_id: 'dm-ben', work: { ...JOB, job: `${JOB.job}-${scheme}`, started_at: now - 9 * 60000 } });
  const id = card.message.id;
  await p.evaluate((x) => { window.__wk = x; }, id);
  const W = `.wc[data-id="${id}"]`;
  await p.waitForTimeout(500);
  const bubbles = async () => p.evaluate(() => document.querySelectorAll('#msgs .row').length);
  const n0 = await bubbles();
  await p.screenshot({ path: `${out}/${scheme}-1-queued.png` });

  // Working: two ticks, the third in progress.
  await post('/mock/work', { id, work: { state: 'working', active_at: now - 2 * 60000, started_at: now - 9 * 60000, steps: STEPS.map((text, i) => ({ text, done: i < 2 })) } });
  await p.waitForTimeout(500);
  const working = await p.evaluate(() => {
    const c = document.querySelector(`.wc[data-id="${window.__wk}"]`);
    return { by: c?.querySelector('.wc-by')?.textContent, ticks: c?.querySelectorAll('.wc-tick').length, spin: c?.querySelectorAll('.wc-spin').length,
      bar: c?.querySelector('.wc-bar > i')?.style.width, open: c?.querySelector('.wc-open')?.textContent, ask: c?.querySelector('.wc-ask')?.textContent };
  });
  check(working.by === 'Claude · started by Ben · Acme' && working.ticks === 2 && working.spin === 1 && working.bar === '50%' && working.open === 'Open session' && /^You asked: /.test(working.ask || ''),
    `${scheme}: working card reads right (${JSON.stringify(working)})`);
  check(await bubbles() === n0, `${scheme}: progress adds no bubble (${n0})`);
  await p.screenshot({ path: `${out}/${scheme}-2-working.png` });

  // Scroll up a little, tick a step: what he reads stays put.
  if (scheme === 'light') {
    await p.evaluate(() => { const sc = document.querySelector('#scroller'); sc.scrollTop = Math.max(0, sc.scrollTop - 260); });
    await p.waitForTimeout(300);
    const before = await p.evaluate(() => document.querySelector('#scroller').scrollTop);
    const topRow = await p.evaluate(() => { const r = [...document.querySelectorAll('#msgs .row')].find((x) => x.getBoundingClientRect().bottom > 120); return r ? [r.dataset.key, Math.round(r.getBoundingClientRect().top)] : null; });
    await post('/mock/work', { id, work: { steps: STEPS.map((text, i) => ({ text, done: i < 3 })), note: 'Checking both pages on a phone screen before handing them over' } });
    await p.waitForTimeout(500);
    const after = await p.evaluate((k) => { const r = document.querySelector(`#msgs .row[data-key="${k}"]`); return r ? Math.round(r.getBoundingClientRect().top) : null; }, topRow?.[0]);
    check(topRow && Math.abs(after - topRow[1]) <= 1, `light: an update while scrolled up does not move what he reads (${topRow?.[1]} -> ${after}, scrollTop ${before})`);
    await p.evaluate(() => { const sc = document.querySelector('#scroller'); sc.scrollTop = sc.scrollHeight; });
    await p.waitForTimeout(300);
  }

  // Done with a file.
  await post('/mock/work', { id, pdf: 'Gutter Check cheat sheet.pdf', work: { state: 'done', finished_at: now, note: null,
    steps: STEPS.map((text) => ({ text, done: true })),
    result: 'The two page sheet is done and checked against the recording. Pat can read the script as written.\n\nOne thing for you: the price line says $49; say if it should be $39 like the flyer.' } });
  await p.waitForTimeout(600);
  const done = await p.evaluate(() => {
    const c = document.querySelector(`.wc[data-id="${window.__wk}"]`);
    return { by: c?.querySelector('.wc-by')?.textContent, result: c?.querySelector('.wc-result')?.textContent.slice(0, 40), files: c?.querySelectorAll('.fcell').length,
      btns: [...c.querySelectorAll('.wc-btn')].map((b) => b.textContent), steps: c?.querySelectorAll('.wc-step').length };
  });
  check(/^Claude · finished \d{1,2}:\d\d [AP]M · 9 min$/.test(done.by || '') && done.files === 1 && done.btns.join('|') === 'Reply to Claude|Looks good' && done.steps === 0,
    `${scheme}: finished card shows the result, the file and two buttons (${JSON.stringify(done)})`);
  check(await bubbles() === n0, `${scheme}: still one card`);
  await p.screenshot({ path: `${out}/${scheme}-3-done.png` });

  // Home: the chat list line and the live line.
  if (scheme === 'light') {
    await post('/mock/work', { id, work: { state: 'working', finished_at: null } });
    await p.goto(`${BASE}/#/`);
    await p.waitForTimeout(900);
    const home = await p.evaluate(() => ({
      live: document.querySelector('#live')?.textContent,
      prev: [...document.querySelectorAll('.chat-row')].map((r) => r.querySelector('.rc-prev')?.textContent).find((t) => /^Claude:/.test(t || '')),
    }));
    check(/^Claude is working for Ben · /.test(home.live || '') && home.prev === 'Claude: Gutter Check cheat sheet for Pat · working', `light: home says Claude is working (${JSON.stringify(home)})`);
    await p.screenshot({ path: `${out}/light-home-working.png` });
    await post('/mock/work', { id, work: { state: 'done', finished_at: now } });
    await p.goto(`${BASE}/#/chat/dm-ben`);
    await p.waitForTimeout(900);
  }

  // Looks good (light) / needs_you (dark).
  if (scheme === 'light') {
    await p.locator(`${W} [data-work-ack]`).click();
    await p.waitForTimeout(500);
    const acked = await p.evaluate(() => document.querySelector(`.wc[data-id="${window.__wk}"] .wc-acked`)?.textContent);
    check(/^Looks good · \d/.test(acked || ''), `light: Looks good marks the card (${acked})`);
    await p.screenshot({ path: `${out}/light-4-looks-good.png` });
  } else {
    await post('/mock/work', { id, work: { state: 'needs_you', result: 'The sheet is ready except the price. The flyer says $39 and the recording says $49; tell me which and I will finish it.' } });
    await p.waitForTimeout(500);
    const ny = await p.evaluate(() => ({ by: document.querySelector(`.wc[data-id="${window.__wk}"] .wc-by`)?.textContent, btns: [...document.querySelectorAll(`.wc[data-id="${window.__wk}"] .wc-btn`)].map((b) => b.textContent) }));
    check(/^Claude · needs you/.test(ny.by || '') && ny.btns.join('|') === 'Reply to Claude', `dark: needs_you reads plainly and keeps Reply to Claude (${JSON.stringify(ny)})`);
    await p.screenshot({ path: `${out}/dark-4-needs-you.png` });
  }

  // Reply to Claude: the composer in reply mode, his bubble, then the card back to working with Earlier.
  await p.locator(`${W} [data-work-reply]`).click();
  await p.waitForTimeout(300);
  const bar = await p.evaluate(() => document.querySelector('#reply-bar .rb-title')?.textContent);
  check(bar === 'Replying to Claude · same session', `${scheme}: the composer says the reply goes to Claude (${bar})`);
  await p.keyboard.type('Make the price $39 like the flyer');
  // A DOM tap: Playwright's own click scrolls the pane sideways to bring the button "into view" (a test artifact).
  await p.evaluate(() => document.querySelector('#send-btn').click());
  await p.waitForTimeout(800);
  const prevResult = scheme === 'light' ? 'The two page sheet is done and checked against the recording.' : 'The sheet is ready except the price.';
  await post('/mock/work', { id, work: { state: 'working', round: 2, result: null, finished_at: null, active_at: Date.now(), started_at: Date.now() - 60000,
    steps: [{ text: 'Change the price to $39', done: false }, { text: 'Check both pages again', done: false }],
    rounds: [{ result: prevResult, reply: 'Make the price $39 like the flyer', finished_at: now }] } });
  await p.waitForTimeout(700);
  const after = await p.evaluate(() => ({
    sent: [...document.querySelectorAll('.wc-sent')].at(-1)?.textContent, replied: document.querySelector(`.wc[data-id="${window.__wk}"] .wc-replied`)?.textContent,
    quote: [...document.querySelectorAll('.row.out .quote .q-name')].at(-1)?.textContent, receipt: !!document.querySelector('#msgs .receipt'),
  }));
  check(after.sent === 'Sent to the same session · working' && after.quote === 'Claude' && !after.receipt && /^You replied: Make the price/.test(after.replied || ''),
    `${scheme}: after a reply (${JSON.stringify(after)})`);
  const paneLeft = await p.evaluate(() => Math.round(document.querySelector('#thread-pane').getBoundingClientRect().left));
  check(paneLeft === 0, `${scheme}: the thread stays in place after sending (${paneLeft})`);
  await p.screenshot({ path: `${out}/${scheme}-5-after-reply.png` });
  // Round two finishes: Earlier holds the first result.
  await post('/mock/work', { id, work: { state: 'done', finished_at: Date.now(), result: 'Price changed to $39 on both pages and checked on a phone screen.', steps: null } });
  await p.waitForTimeout(500);
  await p.locator(`${W} [data-work-earlier]`).click();
  await p.waitForTimeout(300);
  const earlier = await p.evaluate(() => [...document.querySelectorAll(`.wc[data-id="${window.__wk}"] .wc-round`)].map((r) => r.textContent.slice(0, 30)));
  check(earlier.length === 1, `${scheme}: Earlier opens the first round (${JSON.stringify(earlier)})`);
  await p.screenshot({ path: `${out}/${scheme}-6-round-two-done.png` });
  check(!errs.length, `${scheme}: no page errors (${errs.join(' | ')})`);
  await ctx.close();
}

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
