// 11-10 UI checks in WebKit at iPhone size, on the real server code with real files (tools/docs-demo.mjs starts a
// throwaway Vesper): the Deliverables row on home, the Deliverables screen, the viewer (PDF pages, zoom, several
// files, a web page that runs no script, a table, notes), a document on a waiting card, and files in threads.
//
//   node tools/docs-shots.mjs <out-dir>
process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
const { webkit } = await import(process.env.VESPER_PLAYWRIGHT || 'playwright-core');
import { mkdirSync } from 'node:fs';
import { startDemo } from './docs-demo.mjs';

const out = process.argv[2] || 'tmp/docs-shots';
mkdirSync(out, { recursive: true });
const demo = await startDemo();
const BASE = demo.base;
const browser = await webkit.launch();
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';

async function page(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, colorScheme: scheme, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|api\/presence due to access control|Blocked script execution/.test(m.text()) && errs.push(m.text()));
  await p.addInitScript((css) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, SAFE);
  await p.goto(demo.login());
  await p.waitForTimeout(1500);
  return { ctx, p, errs };
}
const noSideScroll = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e.scrollWidth <= e.clientWidth + 1; }, sel);

try {
  const { ctx, p, errs } = await page('light');

  // ── home row ──
  const home = await p.evaluate(() => { const r = document.querySelector('#docs-row'); return { shown: r && !r.hidden, title: r?.querySelector('b')?.textContent, line: r?.querySelector('.need-tx span')?.textContent, blue: r?.querySelector('em.new')?.textContent }; });
  check(home.shown && home.title === 'Deliverables' && home.blue === '5 new' && /Pat visit prep for tomorrow 2:30 PM/.test(home.line), `home has a Deliverables row with what is new and what is coming up ("${home.line}")`);
  await p.screenshot({ path: `${out}/home.png` });

  // ── Deliverables screen ──
  await p.locator('#docs-row').click();
  await p.waitForTimeout(900);
  const list = await p.evaluate(() => {
    const el = document.querySelector('#docs-pane');
    return { open: document.body.classList.contains('docs-open'), hash: location.hash, labels: [...el.querySelectorAll('.sec-label')].map((x) => x.textContent),
      rows: [...el.querySelectorAll('.dr')].map((r) => ({ t: r.querySelector('b').textContent, s: r.querySelector('.dr-sub').textContent, isNew: r.classList.contains('new'), cut: r.querySelector('.dr-sub').scrollWidth > r.querySelector('.dr-sub').clientWidth + 1 })),
      thumbs: [...el.querySelectorAll('.dr .ft img')].filter((i) => i.complete && i.naturalWidth > 0).length, sub: el.querySelector('.rn-sub').textContent };
  });
  check(list.open && list.hash === '#/files' && list.labels.join('|') === 'Coming up|Waiting on your OK|Today', `Deliverables opens with what is coming up, what waits on him, then by day (${list.labels.join(', ')})`);
  check(list.rows[0]?.t === 'Pat visit prep' && list.rows[0].s === 'Tomorrow 2:30 PM · Meeting prep' && !list.rows[0].cut, `the meeting prep leads and says when it is for, in full ("${list.rows[0]?.s}")`);
  check(list.rows[1]?.t === 'Post the first two ads' && /^Waiting on your OK · 3 files$/.test(list.rows[1].s), `a card's files sit under Waiting on your OK ("${list.rows[1]?.t}": ${list.rows[1]?.s})`);
  check(list.rows.length === 5 && list.rows.every((r) => r.isNew) && list.sub === '5 new' && list.thumbs >= 4, `five rows, all new, with first-page pictures (${list.thumbs} thumbnails drawn)`);
  check(await noSideScroll(p, '#docs-pane .rn-scroll'), 'the list never scrolls sideways');
  await p.screenshot({ path: `${out}/deliverables.png` });

  // ── viewer: a PDF ──
  await p.locator('.dr').first().click();
  await p.waitForTimeout(1500);
  const v1 = await p.evaluate(() => {
    const b = document.querySelector('.dv-body'); const pgs = [...document.querySelectorAll('.dv-pg')];
    return { open: !!document.querySelector('.dv.show'), title: document.querySelector('.dv-title b').textContent, sub: document.querySelector('.dv-title span').textContent, pages: pgs.length,
      first: pgs[0]?.querySelector('img').naturalWidth, ready: pgs[0]?.classList.contains('ready'), ratio: pgs[0] ? (pgs[0].getBoundingClientRect().height / pgs[0].getBoundingClientRect().width).toFixed(2) : '',
      foot: document.querySelector('.dv-answer')?.textContent, side: b.scrollWidth <= b.clientWidth + 1 };
  });
  check(v1.open && v1.title === 'Pat visit prep' && v1.sub === 'Page 1 of 3' && v1.pages === 3, `a PDF opens inside the app, page by page ("${v1.title}", ${v1.sub})`);
  check(v1.ready && v1.first === 1400 && v1.ratio === '1.29' && v1.side, `each page is a sharp picture at the paper's shape (${v1.first}px wide, ${v1.ratio})`);
  await p.screenshot({ path: `${out}/viewer-pdf.png` });
  await p.evaluate(() => { document.querySelector('.dv-body').scrollTop = 1200; });
  await p.waitForTimeout(700);
  const v2 = await p.evaluate(() => ({ sub: document.querySelector('.dv-title span').textContent, loaded: [...document.querySelectorAll('.dv-pg')].filter((x) => x.classList.contains('ready')).length }));
  check(v2.sub === 'Page 3 of 3' && v2.loaded === 3, `scrolling loads the later pages and says where he is (${v2.sub})`);
  await p.evaluate(() => { document.querySelector('.dv-body').scrollTop = 0; });
  const box = await p.locator('.dv-pg').first().boundingBox();
  await p.touchscreen.tap(box.x + 120, box.y + 160); await p.waitForTimeout(90); await p.touchscreen.tap(box.x + 120, box.y + 160);
  await p.waitForTimeout(500);
  const z = await p.evaluate(() => ({ zoomed: document.querySelector('.dv-body').classList.contains('zoomed'), w: Math.round(document.querySelector('.dv-pages').getBoundingClientRect().width) }));
  check(z.zoomed && z.w > 900, `a double tap zooms in on the page (${z.w}px wide)`);
  await p.screenshot({ path: `${out}/viewer-zoom.png` });
  await p.locator('.dv-btn[aria-label="Close"]').click();
  await p.waitForTimeout(600);
  const seen = await p.evaluate(() => ({ gone: !document.querySelector('.dv'), news: document.querySelectorAll('.dr.new').length, sub: document.querySelector('#docs-pane .rn-sub').textContent }));
  check(seen.gone && seen.news === 4 && seen.sub === '4 new', `closing returns to the list and the opened one is no longer new (${seen.sub})`);

  // ── several files: a PDF and a web page that runs nothing ──
  await p.locator('.dr', { hasText: 'Mark winter test plan' }).click();
  await p.waitForTimeout(1200);
  const chips = await p.evaluate(() => [...document.querySelectorAll('.dv-chip')].map((c) => `${c.textContent}${c.classList.contains('on') ? '*' : ''}`));
  check(chips.length === 2 && /Winter Test Plan\.pdf\*$/.test(chips[0]), `two files in one handover switch from a strip at the bottom (${chips.join(' | ')})`);
  await p.screenshot({ path: `${out}/viewer-two-files.png` });
  await p.locator('.dv-chip').nth(1).click();
  await p.waitForTimeout(1500);
  const frame = p.frames().find((f) => /\/files\/[a-f0-9]{32}\/v$/.test(f.url()));
  const ftext = frame ? await frame.evaluate(() => ({ h: document.querySelector('h1')?.textContent, js: document.getElementById('js')?.textContent })).catch((e) => ({ err: String(e) })) : null;
  check(ftext?.h === 'Cover email' && ftext.js === 'No script ran.', `a web page shows in a frame and its script never runs (${JSON.stringify(ftext)})`);
  await p.screenshot({ path: `${out}/viewer-html.png` });
  await p.locator('.dv-btn[aria-label="Close"]').click();
  await p.waitForTimeout(500);

  // ── a table and notes ──
  await p.locator('.dr', { hasText: 'Sunday lineup recap' }).click();
  await p.waitForTimeout(1200);
  const table = await p.evaluate(() => ({ head: [...document.querySelectorAll('.dv-table th')].map((x) => x.textContent).join(','), rows: document.querySelectorAll('.dv-table tbody tr').length }));
  check(table.head === 'Truck,Sales,Tickets' && table.rows === 3, `a CSV opens as a table (${table.head}; ${table.rows} rows)`);
  await p.screenshot({ path: `${out}/viewer-table.png` });
  await p.locator('.dv-chip').nth(1).click();
  await p.waitForTimeout(900);
  const md = await p.evaluate(() => ({ h: document.querySelector('.dv-md h1, .dv-md h2, .dv-md h3, .dv-md strong')?.textContent, li: document.querySelectorAll('.dv-md li').length }));
  check(!!md.h && md.li === 2, `notes open as formatted text ("${md.h}", ${md.li} bullets)`);
  await p.screenshot({ path: `${out}/viewer-notes.png` });
  await p.locator('.dv-btn[aria-label="Close"]').click();
  await p.waitForTimeout(500);

  // ── a document on a waiting card: read it, then go answer ──
  await p.locator('.dr', { hasText: 'Post the first two ads' }).click();
  await p.waitForTimeout(1200);
  const card = await p.evaluate(() => ({ chips: document.querySelectorAll('.dv-chip').length, answer: document.querySelector('.dv-answer')?.textContent, quiet: document.querySelector('.dv-answer')?.classList.contains('quiet') }));
  check(card.chips === 3 && card.answer === 'Answer Ben' && !card.quiet, `a waiting card's files open with a button back to the card (${card.answer})`);
  await p.screenshot({ path: `${out}/viewer-card.png` });
  await p.locator('.dv-answer').click();
  await p.waitForTimeout(1300);
  const landed = await p.evaluate(() => ({ hash: location.hash, viewer: !!document.querySelector('.dv'), docs: document.body.classList.contains('docs-open'), card: !!document.querySelector('#msgs .appr'),
    tiles: document.querySelectorAll('#msgs .fcell').length, pics: document.querySelectorAll('#msgs .att-img').length }));
  check(landed.hash === '#/chat/dm-ben' && !landed.viewer && !landed.docs && landed.card, `Answer lands on the card in Ben's thread (${landed.hash})`);
  check(landed.tiles === 2 && landed.pics === 2, `in the thread, a card's pictures and its document sit with it, and a plain PDF from a bot is a tile (${landed.tiles} tiles, ${landed.pics} pictures)`);
  await p.screenshot({ path: `${out}/thread-card.png` });

  // ── a handover in its thread ──
  await p.evaluate(() => { location.hash = '#/chat/dm-eli'; });
  await p.waitForTimeout(1200);
  const th = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#msgs .dl')];
    const last = cards.at(-1);
    return { n: cards.length, title: last?.querySelector('.dl-head b')?.textContent, sub: last?.querySelector('.dl-sub')?.textContent, files: last?.querySelectorAll('.fcell').length,
      meta: last?.querySelector('.fcell-tx span')?.textContent, note: [...document.querySelectorAll('#msgs .bubble.in .btext')].at(-1)?.textContent, links: document.querySelectorAll('#msgs a.bubble.file').length,
      side: [...document.querySelectorAll('#msgs .dl, #msgs .fcell, #msgs .bubble')].every((e) => e.getBoundingClientRect().right <= innerWidth && e.getBoundingClientRect().left >= 0) };
  });
  check(th.n === 2 && th.title === 'Pat visit prep' && /Meeting prep · for tomorrow 2:30 PM$/.test(th.sub) && th.files === 1 && /^PDF · 3 pages · /.test(th.meta), `a handover shows in the bot's thread as one card ("${th.title}": ${th.sub}; ${th.meta})`);
  check(/^Your promises and questions/.test(th.note || '') && th.links === 0 && th.side, `its note reads as a normal message under it, and no file is a link that leaves the app (${JSON.stringify([th.note, th.links, th.side])})`);
  await p.screenshot({ path: `${out}/thread-handover.png` });
  await p.locator('#msgs .dl').last().locator('.fcell').click();
  await p.waitForTimeout(1000);
  check(await p.evaluate(() => document.querySelector('.dv-title b')?.textContent === 'Pat visit prep'), 'tapping the file in the thread opens the same viewer');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);

  // ── Approvals screen carries the documents too ──
  await p.evaluate(() => { location.hash = '#/approvals'; });
  await p.waitForTimeout(1200);
  const ap = await p.evaluate(() => ({ docs: document.querySelectorAll('.ap-item .ap-docs .fcell').length, pics: document.querySelectorAll('.ap-item .ap-media img').length, name: document.querySelector('.ap-item .ap-docs .fcell b')?.textContent }));
  check(ap.docs === 1 && ap.pics === 2 && ap.name === 'Cedar ads plan.pdf', `the Approvals screen shows a card's document under its pictures (${ap.name})`);
  await p.screenshot({ path: `${out}/approvals.png` });
  check(errs.length === 0, `no page errors${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  await ctx.close();

  // ── dark ──
  const d = await page('dark');
  await d.p.evaluate(() => { location.hash = '#/files'; });
  await d.p.waitForTimeout(1100);
  await d.p.screenshot({ path: `${out}/deliverables-dark.png` });
  await d.p.locator('.dr').first().click();
  await d.p.waitForTimeout(1300);
  const dk = await d.p.evaluate(() => ({ bg: getComputedStyle(document.querySelector('.dv')).backgroundColor, page: getComputedStyle(document.querySelector('.dv-pg')).backgroundColor }));
  check(dk.page === 'rgb(255, 255, 255)' && dk.bg !== 'rgb(242, 242, 247)', `in dark mode the app goes dark and the paper stays white (${dk.bg})`);
  await d.p.screenshot({ path: `${out}/viewer-dark.png` });
  check(d.errs.length === 0, `no page errors in dark${d.errs.length ? `: ${d.errs.slice(0, 3).join(' | ')}` : ''}`);
  await d.ctx.close();
} catch (e) {
  results.push(`FAIL the run stopped: ${e?.stack || e}`);
} finally {
  await browser.close();
  demo.close();
}
console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('ok')).length} ok, ${results.filter((r) => r.startsWith('FAIL')).length} failed; screenshots in ${out}`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
