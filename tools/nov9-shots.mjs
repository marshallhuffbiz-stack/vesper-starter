// 11-09 UI checks in WebKit at iPhone size, against the mock server: the short catch-up and the Activity sheet,
// the System line and sheet, a message a bot never picked up (Send again), Stop on a working bot, saved drafts,
// sending a file, Claude sessions on home and Runs, finished one-time routines, Start fresh.
//
//   node tools/mock-server.mjs --port 8790 &
//   node tools/nov9-shots.mjs <out-dir>
process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
const { webkit } = await import(process.env.VESPER_PLAYWRIGHT || 'playwright-core');

const out = process.argv[2] || 'tmp/nov9-shots';
const BASE = process.env.HOLLER_BASE || 'http://127.0.0.1:8790';
const browser = await webkit.launch();
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';
const mock = (path, body) => fetch(`${BASE}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function page(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, colorScheme: scheme, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|api\/presence due to access control/.test(m.text()) && errs.push(m.text()));
  await p.addInitScript((css) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, SAFE);
  return { ctx, p, errs };
}

await mock('/mock/system', {});
await mock('/mock/claude', {});
const { ctx, p, errs } = await page('light');
await p.goto(`${BASE}/mock/signin`);
await p.goto(`${BASE}/#/`);
await p.waitForTimeout(1200);

// ── home: short catch-up and the System line ──
const home = await p.evaluate(() => {
  const c = document.querySelector('#catchup'); const s = document.querySelector('#system-line');
  return { cuH: Math.round(c.getBoundingClientRect().height), head: c.querySelector('.cu-h')?.textContent, line: c.querySelector('.cu-l')?.textContent, chev: !!c.querySelector(':scope > .ic'),
    sys: s && !s.hidden ? s.textContent : null, sysCls: s?.className, dot: s ? getComputedStyle(s.querySelector('.sys-dot')).backgroundColor : '' };
});
check(home.cuH <= 92 && home.head === 'Catch me up · since 9:10 AM' && /^2 done · 2 sent on their own/.test(home.line) && home.chev, `catch-up is a head and one line of counts (${home.cuH}px tall: "${home.line}")`);
check(home.sys === 'Everything is running' && /\bok\b/.test(home.sysCls), `a quiet System line sits under the chats ("${home.sys}")`);
await p.screenshot({ path: `${out}/home.png` });
await p.evaluate(() => { const s = document.querySelector('#list-scroll'); s.scrollTop = s.scrollHeight; });
await p.waitForTimeout(300);
await p.screenshot({ path: `${out}/home-bottom.png` });
await p.evaluate(() => { document.querySelector('#list-scroll').scrollTop = 0; });

// ── Activity sheet ──
await p.locator('#catchup').click();
await p.waitForTimeout(700);
const act = await p.evaluate(() => {
  const sh = document.querySelector('.act-sheet');
  return { open: !!sh, labels: [...(sh?.querySelectorAll('.sec-label') || [])].map((x) => x.textContent), rows: sh?.querySelectorAll('.act-row').length, seg: [...(sh?.querySelectorAll('.act-seg button') || [])].map((b) => `${b.textContent}${b.classList.contains('on') ? '*' : ''}`).join('|'),
    sum: sh?.querySelector('.act-sum')?.textContent, first: sh?.querySelector('.act-row b')?.textContent, firstSt: sh?.querySelector('.act-row .act-st')?.textContent, marks: sh?.querySelectorAll('.act-row > .appmark').length,
    wide: sh ? [...sh.querySelectorAll('.act-row')].every((r) => r.scrollWidth <= r.clientWidth + 1) : false };
});
check(act.open && act.labels[0] === 'Worth a look' && act.rows === 4 && act.marks === 4, `catch-up opens the Activity sheet with today's actions as rows (${act.rows} rows; ${act.labels.join(', ')})`);
check(act.first === 'Add 12 negatives' && act.firstSt === 'Failed' && /1 failed/.test(act.sum) && act.wide, `what failed leads, and the counts sit on top ("${act.sum}")`);
check(/Since you left\*\|Today\|7 days/.test(act.seg) || /Today\*\|7 days/.test(act.seg), `it can show since he left, today or the week (${act.seg})`);
await p.screenshot({ path: `${out}/activity.png` });
await p.locator('.act-seg button', { hasText: '7 days' }).click();
await p.waitForTimeout(400);
const wk = await p.evaluate(() => [...document.querySelectorAll('.act-sheet .sec-label')].map((x) => x.textContent));
check(wk.includes('Yesterday') && await p.evaluate(() => document.querySelectorAll('.act-sheet .act-row').length === 5), `the week view adds earlier days, grouped by day (${wk.join(', ')})`);
await p.locator('.act-sheet .ed-done').click();
await p.waitForTimeout(450);
check(await p.evaluate(() => !document.querySelector('.act-sheet')), 'Done closes it');

// ── System: something wrong ──
await mock('/mock/system', { level: 'bad', headline: 'Eli: Not connected since 2:10 PM', checks: [
  { key: 'server', label: 'Vesper', level: 'ok', detail: 'Running since 8:02 AM' },
  { key: 'bot:ben', label: 'Ben', level: 'ok', detail: 'Connected since 8:02 AM' },
  { key: 'bot:eli', label: 'Eli', level: 'bad', detail: 'Not connected since 2:10 PM' },
  { key: 'disk', label: 'Mac disk', level: 'warn', detail: '6.2 GB free. Under 8 GB the Mac slows down and can freeze.' }] });
await p.evaluate(() => { document.querySelector('#list-scroll').scrollTop = 99999; });
await p.locator('#system-line').click();
await p.waitForTimeout(900);
const sys = await p.evaluate(() => {
  const sh = document.querySelector('.sys-sheet'); const line = document.querySelector('#system-line');
  return { big: sh?.querySelector('.sys-big')?.textContent, why: sh?.querySelector('.sys-why')?.textContent, rows: [...(sh?.querySelectorAll('.sys-row') || [])].map((r) => `${r.querySelector('b').textContent}:${r.querySelector('.sys-st').textContent}`).join(','),
    faces: sh?.querySelectorAll('.sys-row .av').length, line: line.textContent, lineCls: line.className, color: getComputedStyle(line).color };
});
check(sys.big === 'Something needs attention' && sys.why === 'Eli: Not connected since 2:10 PM' && sys.rows === 'Ben:OK,Eli:Problem,Vesper:OK,Mac disk:Check' && sys.faces === 2, `the System sheet says what is wrong in plain words (${sys.rows})`);
check(sys.line === 'Eli: Not connected since 2:10 PM' && /\bbad\b/.test(sys.lineCls) && sys.color === 'rgb(255, 59, 48)', `and the line on home turns red with the same words ("${sys.line}")`);
await p.screenshot({ path: `${out}/system.png` });
await mock('/mock/system', {});
await p.locator('.sys-sheet .lt-link').click();
await p.waitForTimeout(800);
check(await p.evaluate(() => document.querySelector('.sys-sheet .sys-big')?.textContent === 'Everything is running' && document.querySelectorAll('.sys-sheet .sys-row').length >= 8), 'Check again reads it fresh');
await p.screenshot({ path: `${out}/system-ok.png` });
await p.locator('.sys-sheet .ed-done').click();
await p.waitForTimeout(450);

// ── a message the bot never picked up ──
await p.goto(`${BASE}/#/chat/dm-dora`);
await p.waitForTimeout(800);
await p.locator('#input').fill('How did the Fjord calls go this week?');
await p.locator('#send-btn').click();
await p.waitForTimeout(700);
await mock('/mock/stall', { chat_id: 'dm-dora' });
await p.waitForTimeout(500);
const st = await p.evaluate(() => { const n = document.querySelector('.dlv-note'); return { text: n?.querySelector('span')?.textContent, btn: n?.querySelector('.dlv-again')?.textContent, color: n ? getComputedStyle(n).color : '', receipt: !!document.querySelector('.receipt') && document.querySelector('.msgs').lastElementChild.classList.contains('receipt') }; });
check(st.text === 'Dora has not picked this up.' && st.btn === 'Send again' && st.color === 'rgb(255, 59, 48)', `a message no bot took says so under it, with Send again ("${st.text}")`);
await p.screenshot({ path: `${out}/stalled.png` });
await p.locator('.dlv-again').click();
await p.waitForTimeout(600);
check(await p.evaluate(() => !document.querySelector('.dlv-note')), 'Send again clears the note once it is on its way');
await mock('/mock/stall', { chat_id: 'dm-dora', state: 'failed' });
await p.waitForTimeout(400);
check(await p.evaluate(() => document.querySelector('.dlv-note span')?.textContent === 'Dora hit a problem with this.'), 'a turn that failed reads differently');
await p.locator('.dlv-again').click();
await p.waitForTimeout(3200);

// ── Stop a working bot ──
await mock('/mock/inject', { chat_id: 'dm-dora', sender: 'dora', text: 'Report is ready.', typing_ms: 6000, status: 'Pulling Fjord numbers' });
await p.waitForTimeout(900);
const wk2 = await p.evaluate(() => { const w = document.querySelector('.typing-row .work'); const b = w?.querySelector('.work-stop'); const r = b?.getBoundingClientRect(); return { label: w?.querySelector('.work-tx')?.textContent, stop: b?.textContent, h: r ? Math.round(r.height) : 0, inside: r ? r.right <= 393 : false }; });
check(wk2.label === 'Dora · Pulling Fjord numbers' && wk2.stop === 'Stop' && wk2.inside, `a working bot's line carries Stop ("${wk2.label}", ${wk2.h}px)`);
await p.screenshot({ path: `${out}/stop.png` });
await p.locator('.work-stop').click();
await p.waitForTimeout(900);
const cmds = (await mock('/mock/commands')).commands;
check(cmds.some((c) => c.command === 'stop' && c.bot === 'dora' && c.chat_id === 'dm-dora') && await p.evaluate(() => !document.querySelector('.typing-row')), 'Stop reaches the bot and the working line goes');
await p.waitForTimeout(5500);

// ── a file ──
await p.locator('#plus-btn').click();
await p.waitForTimeout(520);
const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.locator('.pm-row[data-act="file"]').click()]);
await chooser.setFiles({ name: 'Fjord quote.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 mock quote') });
await p.waitForTimeout(1100);
const tray = await p.evaluate(() => { const t = document.querySelector('.thumb.doc'); return { ext: t?.querySelector('.thumb-ext')?.textContent, name: t?.querySelector('.thumb-name')?.textContent, done: t?.classList.contains('done'), send: !document.querySelector('#send-btn').disabled }; });
check(tray.ext === 'PDF' && tray.name === 'Fjord quote.pdf' && tray.done && tray.send, `a PDF waits in the tray as a file chip (${tray.ext} ${tray.name})`);
await p.screenshot({ path: `${out}/file-tray.png` });
await p.locator('#send-btn').click();
await p.waitForTimeout(900);
check(await p.evaluate(() => [...document.querySelectorAll('.row.out .fcell .fcell-tx b')].some((x) => x.textContent === 'Fjord quote.pdf')) && await p.evaluate(() => !document.querySelector('#msgs a.bubble.file')), 'and sends as a file tile that opens inside the app (11-10: never a link out)');

// ── drafts survive a relaunch and show in the list ──
await p.goto(`${BASE}/#/chat/dm-cleo`);
await p.waitForTimeout(700);
await p.locator('#input').fill('Ask Destiny about the Sunday');
await p.waitForTimeout(500);
await p.locator('#back-btn').click();
await p.waitForTimeout(700);
const dr = await p.evaluate(() => document.querySelector('.chat-row[data-chat="dm-cleo"] .rc-prev')?.textContent);
check(dr === 'Draft: Ask Destiny about the Sunday', `unsent words show as a draft on the chat's row ("${dr}")`);
await p.reload();
await p.waitForTimeout(1200);
await p.goto(`${BASE}/#/chat/dm-cleo`);
await p.waitForTimeout(800);
check(await p.evaluate(() => document.querySelector('#input').value === 'Ask Destiny about the Sunday'), 'and are still in the field after the app is closed and opened');
await p.locator('#input').fill('');
await p.waitForTimeout(500);

// ── Claude sessions on home and Runs, finished one-time routines ──
await mock('/mock/claude', { running: [{ job: 'a', bot: 'ben', who: 'Ben', title: 'Acme: fix the landing page', started: Date.now() - 12 * 60000, created: null, url: null }],
  queued: [{ job: 'b', bot: 'cleo', who: 'Cleo', title: 'Dune: Sunday flyer', started: null, created: Date.now() - 3 * 60000, url: null }] });
await p.goto(`${BASE}/#/`);
await p.reload();
await p.waitForTimeout(3600);
const live = await p.evaluate(() => ({ live: document.querySelector('#live').textContent, on: document.querySelector('#live').classList.contains('on'), runs: document.querySelector('#runs-row .need-tx span')?.textContent }));
check(live.live === 'Claude is working for Ben · Acme: fix the landing page' && live.on && /^1 Claude session working/.test(live.runs), `home says a Claude session is working for a bot ("${live.live}"; Runs: "${live.runs}")`);
await p.screenshot({ path: `${out}/home-claude.png` });
await p.goto(`${BASE}/#/runs`);
await p.waitForTimeout(1000);
const rn = await p.evaluate(() => {
  const labels = [...document.querySelectorAll('#runs-pane .sec-label')].map((x) => x.textContent);
  const cl = [...document.querySelectorAll('.rn-claude .rn-ev')].map((r) => `${r.querySelector('b').textContent} / ${r.querySelector('.rn-tx span').textContent}`);
  const fin = document.querySelector('.rn-fin'); const names = [...document.querySelectorAll('.rn-job .rn-tx b')].map((b) => b.textContent);
  return { labels, cl, fin: fin?.textContent, herb: names.some((n) => /Hal/.test(n)) };
});
check(rn.labels.includes('Claude sessions') && /^Acme: fix the landing page \/ Ben · working 12 min$/.test(rn.cl[0]) && /^Dune: Sunday flyer \/ Cleo · waiting for a slot 3 min$/.test(rn.cl[1]), `Runs lists Claude sessions working and waiting (${rn.cl.join(' | ')})`);
check(rn.fin === '1 finished one-time routine' && !rn.herb, `a one-time routine that already ran is folded away (${rn.fin})`);
await p.screenshot({ path: `${out}/runs-claude.png` });
await p.locator('.rn-fin').scrollIntoViewIfNeeded();
await p.locator('.rn-fin').click();
await p.waitForTimeout(300);
const fin2 = await p.evaluate(() => { const r = [...document.querySelectorAll('.rn-job')].find((x) => /Hal/.test(x.textContent)); return r?.querySelector('.rn-tx span')?.textContent; });
check(/^Once, .* at 9:00 AM · Ran$/.test(fin2 || ''), `unfolded, it reads as a day and "Ran", never "Paused" (${fin2})`);
await mock('/mock/claude', {});

// ── Start fresh ──
await p.goto(`${BASE}/#/chat/dm-eli`);
await p.waitForTimeout(700);
await p.locator('#head-name').click();
await p.waitForTimeout(1100);
const fr = p.locator('#details .dt-link', { hasText: 'Start a fresh conversation' });
await fr.scrollIntoViewIfNeeded();
await p.screenshot({ path: `${out}/details-fresh.png` });
await fr.click();
await p.waitForTimeout(200);
const armed = await p.evaluate(() => [...document.querySelectorAll('#details .dt-link')].some((b) => b.textContent === 'Tap again to start fresh'));
await p.locator('#details .dt-link', { hasText: 'Tap again to start fresh' }).click();
await p.waitForTimeout(500);
const cmds2 = (await mock('/mock/commands')).commands;
check(armed && cmds2.some((c) => c.command === 'fresh' && c.bot === 'eli'), 'Start a fresh conversation takes two taps and reaches the bot');

check(errs.length === 0, `no console errors${errs.length ? `: ${errs.join(' | ')}` : ''}`);
await ctx.close();

// ── dark ──
{
  const { ctx: c2, p: d } = await page('dark');
  await d.goto(`${BASE}/mock/signin`);
  await d.goto(`${BASE}/#/`);
  await d.waitForTimeout(1200);
  await d.screenshot({ path: `${out}/home-dark.png` });
  await d.locator('#catchup').click();
  await d.waitForTimeout(700);
  await d.screenshot({ path: `${out}/activity-dark.png` });
  const bg = await d.evaluate(() => getComputedStyle(document.querySelector('.act-sheet .cells')).backgroundColor);
  check(bg !== 'rgb(255, 255, 255)', `dark mode: the sheet's rows follow the theme (${bg})`);
  await c2.close();
}

await browser.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
