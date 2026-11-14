// 11-11 UI checks in WebKit at iPhone size, light and dark, on the real server code (tools/clienthome-demo.mjs starts
// a throwaway Vesper with its own outbox): the Clients group on home, a client's page with Needs you, In motion and
// Done today, Approvals grouped by client before and after one group slide (one card left out, one press failing),
// the System sheet with bot errors, and threads where error bubbles used to land.
//
//   node tools/clienthome-shots.mjs <out-dir>
process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
const { webkit } = await import(process.env.VESPER_PLAYWRIGHT || 'playwright-core');
import { mkdirSync } from 'node:fs';
import { startDemo } from './clienthome-demo.mjs';

const out = process.argv[2] || 'tmp/clienthome-shots';
mkdirSync(out, { recursive: true });
const browser = await webkit.launch();
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';

// No horizontal scroll and nothing poking out of the column.
const layout = (p) => p.evaluate(() => {
  const sc = document.querySelector('#scroller');
  const col = document.querySelector('#msgs').getBoundingClientRect();
  const out = [...document.querySelectorAll('.ap-item, .ap-block, .appr, .ap-ctx')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.left < col.left - 0.5 || r.right > col.right + 0.5); }).length;
  return { hscroll: sc.scrollWidth > sc.clientWidth + 1, out };
});
async function slideGroup(p, key) {
  const knob = p.locator(`.appr[data-group="${key}"] .appr-knob`);
  await knob.scrollIntoViewIfNeeded();
  const k = await knob.boundingBox();
  const track = await p.locator(`.appr[data-group="${key}"] .appr-track`).boundingBox();
  await p.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
  await p.mouse.down();
  await p.mouse.move(track.x + track.width + 10, k.y + k.height / 2, { steps: 12 });
  await p.mouse.up();
}
// Put an element just under the thread header (the header's fade covers the top 200 px).
const under = (p, sel) => p.evaluate((s) => { const sc = document.querySelector('#scroller'); const e = document.querySelector(s); if (e) sc.scrollTop += e.getBoundingClientRect().top - 210; }, sel);
const scrollTo = (p, sel, block = 'start') => p.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ block: b }), [sel, block]);

for (const scheme of ['light', 'dark']) {
  const demo = await startDemo();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, colorScheme: scheme, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|api\/presence due to access control/.test(m.text()) && errs.push(m.text()));
  await p.addInitScript((css) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, SAFE);
  try {
    await p.goto(demo.login());
    await p.waitForSelector('#clients-wrap.on', { timeout: 8000 });
    await p.waitForTimeout(700);

    // ── home ──
    const home = await p.evaluate(() => ({
      label: document.querySelector('#clients .sec-label')?.textContent,
      rows: [...document.querySelectorAll('#clients .cl-row')].map((r) => ({ key: r.dataset.client, name: r.querySelector('b').textContent, line: r.querySelector('.need-tx span').textContent,
        count: r.querySelector('.cl-count')?.textContent || '', logo: !!r.querySelector('.clmark') })),
      needs: document.querySelectorAll('#waiting .need:not(.more)').length,
      order: [...document.querySelectorAll('.list-inner > *')].filter((e) => !e.hidden && e.offsetHeight).map((e) => e.id || e.className.split(' ')[0]),
    }));
    const by = Object.fromEntries(home.rows.map((r) => [r.key, r]));
    check(home.label === 'Clients' && home.rows.every((r) => r.logo), `${scheme}: home has a Clients group, every row with its logo (${home.rows.map((r) => r.key).join(', ')})`);
    check(by.acme?.count === '6' && /^6 need you · Claude working on Gutter Check cheat sheet/.test(by.acme.line), `${scheme}: Acme says what needs him and what Claude is doing (${by.acme?.count}: ${by.acme?.line})`);
    check(by.leads?.name === 'Leads' && by.leads.count === '1', `${scheme}: Eli's lead cards are one row, Leads (${by.leads?.line})`);
    check(by['cedar'] && !by['cedar'].count && /^Sends unless you tap Stop: Text Lee/.test(by['cedar'].line), `${scheme}: a send in its Stop window is in motion, not a count (${by['cedar']?.line})`);
    check(by.fjord && /1 needs you/.test(by.fjord.line) && /2 done today|1 needs you/.test(by.fjord.line), `${scheme}: Fjord reads its count in words (${by.fjord?.line})`);
    check(!by.dune && !by.birch && !by.gale, `${scheme}: clients with nothing today stay off home`);
    check(home.order.indexOf('waiting-wrap') < home.order.indexOf('clients-wrap') && home.order.indexOf('clients-wrap') < home.order.indexOf('rows'), `${scheme}: Needs you, then Clients, then the chats (${home.order.join(' > ')})`);
    await p.screenshot({ path: `${out}/${scheme}-1-home.png` });
    await scrollTo(p, '#clients-wrap', 'center');
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/${scheme}-2-home-clients.png` });

    // ── a client's page ──
    await p.locator('#clients .cl-row[data-client="acme"]').click();
    await p.waitForSelector('.client-view .ap-sec', { timeout: 5000 });
    await p.waitForTimeout(600);
    const cp = await p.evaluate(() => ({
      hash: location.hash, head: document.querySelector('#head-name')?.textContent,
      secs: [...document.querySelectorAll('#msgs > .ap-sec')].map((e) => e.textContent),
      cards: [...document.querySelectorAll('#msgs > .ap-item')].map((e) => ({ id: Number(e.dataset.id), sweep: e.classList.contains('in-sweep') })),
      slide: document.querySelector('.ap-gslide .appr-hint')?.textContent,
      motion: [...document.querySelectorAll('.cp-cells:not(.cp-open) .cp-row:not(.done) .cp-tx b')].map((e) => e.textContent),
      done: [...document.querySelectorAll('.cp-row.done')].map((e) => e.textContent),
      open: document.querySelector('.cp-open b')?.textContent,
    }));
    check(cp.hash === '#/client/acme' && /^Acme Pressure Washing6 need you$/.test(cp.head), `${scheme}: the Acme row opens its own page (${cp.hash}, "${cp.head}")`);
    check(cp.secs.join() === 'Needs you,In motion,Done today', `${scheme}: the page has Needs you, In motion and Done today (${cp.secs.join(', ')})`);
    check(cp.cards.length === 6 && cp.cards.filter((c) => c.sweep).length === 5 && !cp.cards.find((c) => c.id === demo.ids[706]).sweep && cp.slide === 'slide to approve 5',
      `${scheme}: five plain sliders share one slide, the sign-in card stays on its own (${cp.slide})`);
    check(cp.motion.join() === 'Gutter Check cheat sheet for Pat,Rebuild the winter landing page', `${scheme}: In motion has the Claude job and the approved plan (${cp.motion.join(' | ')})`);
    check(cp.done.length === 2 && /Text Pat the payment linkSent/.test(cp.done.join()), `${scheme}: Done today, newest first, one line each (${cp.done.join(' | ')})`);
    check(cp.open === 'Open Ben’s thread', `${scheme}: a row opens the owning bot's thread (${cp.open})`);
    const l1 = await layout(p);
    check(!l1.hscroll && l1.out === 0, `${scheme}: the client page fits the column (${JSON.stringify(l1)})`);
    await p.screenshot({ path: `${out}/${scheme}-3-client-top.png` });
    await scrollTo(p, '.ap-gs', 'center');
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/${scheme}-4-client-slide.png` });
    await scrollTo(p, '#msgs > .ap-sec:nth-last-of-type(1)', 'start');
    await p.evaluate(() => { const s = document.querySelector('#scroller'); s.scrollTop = s.scrollHeight; });
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/${scheme}-5-client-motion-done.png` });

    // ── Approvals, grouped ──
    await p.evaluate(() => { location.hash = '#/approvals'; });
    await p.waitForSelector('.ap-ghead', { timeout: 5000 });
    await p.waitForTimeout(600);
    const ap = await p.evaluate(() => ({
      heads: [...document.querySelectorAll('#msgs > .ap-ghead')].map((e) => `${e.querySelector('.gh-name').textContent}:${e.querySelector('.gh-count').textContent}`),
      slides: [...document.querySelectorAll('.ap-gslide')].map((e) => e.dataset.group),
      stopPick: !!document.querySelector('#msgs > .ap-item.in-sweep .appr-hint')?.textContent.includes('stop'),
      head: document.querySelector('#head-name')?.textContent,
    }));
    check(ap.heads.includes('Acme Pressure Washing:6') && ap.heads[0] === 'Cedar Boutique:1' && ap.heads.includes('Leads:1') && ap.heads.includes('Cedar Boutique:1') && ap.slides.join() === 'acme',
      `${scheme}: Approvals groups cards under each client (the group with the newest card first), one group slide where two or more plain sliders sit (${ap.heads.join(', ')}; slides ${ap.slides.join()})`);
    check(!ap.stopPick, `${scheme}: a Stop card is never swept into a group slide`);
    const l2 = await layout(p);
    check(!l2.hscroll && l2.out === 0, `${scheme}: Approvals fits the column (${JSON.stringify(l2)})`);
    await p.screenshot({ path: `${out}/${scheme}-6-approvals-before.png` });
    // Leave one card out; a card changed on the server under him will fail its press.
    await p.locator(`.ap-item[data-id="${demo.ids[705]}"] .ap-pick`).click();
    await p.waitForTimeout(200);
    const four = await p.evaluate(() => document.querySelector('.ap-gslide .appr-hint')?.textContent);
    check(four === 'slide to approve 4', `${scheme}: leaving a card out says so on the slide (${four})`);
    demo.store.db.prepare('UPDATE messages SET buttons = ? WHERE id = ?').run(JSON.stringify([[{ label: 'Approve', data: 'a|703|changed', style: 'primary' }]]), demo.ids[703]);
    await under(p, '.ap-ghead[data-open-client="acme"]');
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/${scheme}-7a-approvals-acme-group.png` });
    await scrollTo(p, '.ap-gs', 'center');
    await p.waitForTimeout(200);
    await p.screenshot({ path: `${out}/${scheme}-7-approvals-one-left-out.png` });
    await slideGroup(p, 'acme');
    await p.waitForSelector('.gs-err', { timeout: 8000 });
    await p.waitForTimeout(900);
    const after = await p.evaluate(() => ({
      acme: [...document.querySelectorAll('#msgs > .ap-item:not(.leaving)')].map((e) => Number(e.dataset.id)),
      err: document.querySelector('.appr-err')?.textContent, errOn: Number(document.querySelector('.appr-err')?.closest('.ap-item')?.dataset.id),
      gs: document.querySelector('.gs-err')?.textContent, head: document.querySelector('#msgs > .ap-ghead .gh-count')?.textContent,
    }));
    const resolved = [701, 702, 704].map((k) => demo.store.message(demo.ids[k]).resolved?.label);
    check(resolved.every((x) => x === 'Approve') && !demo.store.message(demo.ids[705]).resolved && !demo.store.message(demo.ids[703]).resolved,
      `${scheme}: one slide pressed each checked card through its own press; the left-out card and the failed one wait (${resolved.join(',')})`);
    check(after.errOn === demo.ids[703] && /did not go through/.test(after.err) && /1 card did not go through/.test(after.gs) && after.acme.includes(demo.ids[705]) && after.acme.includes(demo.ids[706]),
      `${scheme}: the failed card stays with what went wrong, the rest went (${after.err} / ${after.gs})`);
    await under(p, '.ap-ghead[data-open-client="acme"]');
    await p.waitForTimeout(2600); // the toast has said its piece
    await p.screenshot({ path: `${out}/${scheme}-8-approvals-after.png` });
    await under(p, '.ap-gs');
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/${scheme}-8b-approvals-after-slide.png` });

    // ── System with bot errors ──
    await p.evaluate(() => { location.hash = '#/'; });
    await p.waitForTimeout(700);
    await scrollTo(p, '#system-line', 'center');
    await p.locator('#system-line').click();
    await p.waitForSelector('.sys-err', { timeout: 5000 });
    await p.waitForTimeout(400);
    await p.locator('.sys-err .sys-raw summary').first().click();
    await p.waitForTimeout(200);
    const sys = await p.evaluate(() => ({
      label: [...document.querySelectorAll('.sys-body .sec-label')].map((e) => e.textContent),
      rows: [...document.querySelectorAll('.sys-err .sys-tx b')].map((e) => e.textContent),
      subs: [...document.querySelectorAll('.sys-err .sys-tx > span.num')].map((e) => e.textContent),
      raw: document.querySelector('.sys-err .sys-raw[open] pre')?.textContent || '',
    }));
    check(sys.label.includes('3 bot errors today') && sys.rows.filter((r) => r === 'The bots are paused: the shared ChatGPT plan hit its sharing limit.').length === 1 && sys.subs.some((x) => /^Cleo \u00b7 2 times, last at /.test(x)) && sys.rows.some((r) => /^Ben could not answer your message/.test(r)),
      `${scheme}: System lists today's bot errors in plain words, a repeat as one row (${sys.rows.join(' | ')}; ${sys.subs.join(' | ')})`);
    check(/^⚠️ /.test(sys.raw), `${scheme}: what Hermes wrote sits behind a disclosure (${sys.raw.slice(0, 40)}...)`);
    await p.screenshot({ path: `${out}/${scheme}-9a-system-top.png` });
    await p.evaluate(() => document.querySelector('.sys-body .sys-err')?.closest('.cells')?.previousElementSibling?.scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(300);
    const fit = await p.evaluate(() => { const b = document.querySelector('.sys-body'); const l = document.querySelector('.sys-sheet .lt-links').getBoundingClientRect(); return b.getBoundingClientRect().bottom <= l.top + 1; });
    check(fit, `${scheme}: the System list scrolls inside its sheet and never runs under Check again`);
    await p.screenshot({ path: `${out}/${scheme}-9-system-bot-errors.png` });
    await p.locator('.sys-sheet [data-close]').click();
    await p.waitForTimeout(400);

    // ── threads where error bubbles used to land ──
    await p.evaluate(() => { location.hash = '#/chat/dm-ben'; });
    await p.waitForTimeout(1000);
    const ben = await p.evaluate(() => ({ warn: [...document.querySelectorAll('#msgs .bubble')].some((b) => /⚠/.test(b.textContent)), note: document.querySelector('.dlv-note')?.textContent }));
    check(!ben.warn && /^Ben did not answer this\.Send again$/.test(ben.note || ''), `${scheme}: Ben's thread has no error bubble; his unanswered message says so with Send again (${ben.note})`);
    await p.screenshot({ path: `${out}/${scheme}-10-thread-ben.png` });
    await p.evaluate(() => { location.hash = '#/chat/dm-cleo'; });
    await p.waitForTimeout(1000);
    const lor = await p.evaluate(() => [...document.querySelectorAll('#msgs .bubble')].map((b) => b.textContent));
    check(!lor.some((t) => /Cron|sharing limit/.test(t)) && lor.some((t) => /^⚠️ Heads up: Ember/.test(t)), `${scheme}: Cleo's thread drops the plan errors and keeps her own warning`);
    await p.screenshot({ path: `${out}/${scheme}-11-thread-cleo.png` });
    check(errs.length === 0, `${scheme}: no console errors${errs.length ? `: ${errs.join(' | ')}` : ''}`);
  } catch (e) {
    check(false, `${scheme}: ${e.message.split('\n')[0]}`);
    await p.screenshot({ path: `${out}/${scheme}-error.png` }).catch(() => {});
  } finally {
    await ctx.close();
    demo.close();
  }
}
await browser.close();
console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
