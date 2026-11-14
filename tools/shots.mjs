// Screenshots and gesture checks in WebKit (Safari's engine) at iPhone 15 Pro size, against the
// mock server. Browsers live in a Holler-private folder so the shared Playwright cache is never
// touched (a separate browsers folder, so other Playwright installs are left alone).
//
//   node tools/mock-server.mjs --port 8790 &
//   node tools/shots.mjs <out-dir> [light|dark|both]
process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
const { webkit } = await import(process.env.VESPER_PLAYWRIGHT || 'playwright-core');

const out = process.argv[2] || 'tmp/shots';
const schemes = (process.argv[3] || 'both') === 'both' ? ['light', 'dark'] : [process.argv[3]];
const BASE = process.env.HOLLER_BASE || 'http://127.0.0.1:8790';
const browser = await webkit.launch();
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
// iPhone 15 Pro safe areas (59pt top, 34pt bottom) so shots line up with a real phone.
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';
const inject = (body) => fetch(`${BASE}/mock/inject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

for (const scheme of schemes) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, colorScheme: scheme, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|api\/presence due to access control/.test(m.text()) && errs.push(m.text()));
  await p.addInitScript((css) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, SAFE);
  await p.goto(`${BASE}/mock/signin`);
  await p.goto(`${BASE}/#/`);
  await p.waitForTimeout(900);
  // A bot starts working: the line under the wordmark names it, and its mark gets the thin ring.
  await inject({ chat_id: 'dm-ben', sender: 'ben', text: 'Meta budget is updated.', typing_ms: 2500, status: 'Updating Meta budget' });
  await p.waitForTimeout(700);
  const live = await p.evaluate(() => { const b = document.querySelector('#live'); const av = document.querySelector('.chat-row[data-chat="dm-ben"] .av'); return { on: b.classList.contains('on'), text: b.textContent, ring: av?.classList.contains('working'), ringOp: av ? getComputedStyle(av, '::before').opacity : '' }; });
  check(live.on && live.text === 'Ben is working · Updating Meta budget', `${scheme}: the line under the wordmark names the working bot (${live.text})`);
  check(live.ring, `${scheme}: the working bot's mark carries the spectral ring (opacity ${live.ringOp})`);
  const marks = await p.evaluate(() => [...document.querySelectorAll('.chat-row .av')].map((a) => getComputedStyle(a).backgroundImage).filter((b) => b && b !== 'none').length);
  check(marks === 0, `${scheme}: no chat mark is a gradient sphere (${marks} with a background image)`);
  const needs = await p.evaluate(() => [...document.querySelectorAll('.need:not(.more):not(.lt):not([hidden])')].map((n) => ({ t: n.querySelector('.need-tx b').textContent, mark: !!n.querySelector('.appmark') })));
  check(needs.length > 0 && needs.every((n) => n.mark && n.t.length <= 70 && !/#\d|`|~\/|\/[\w-]+\//.test(n.t)), `${scheme}: Needs you rows show an app mark and a plain title (${needs.map((n) => n.t).join(' | ')})`);
  const prev = await p.evaluate(() => [...document.querySelectorAll('.rc-prev')].map((e) => e.textContent).find((t) => /Updating Meta budget/.test(t)) || '');
  check(prev === 'Updating Meta budget', `${scheme}: a working bot's row reads its status cleanly ("${prev}")`);
  const cu = await p.evaluate(() => { const c = document.querySelector('#catchup'); return { shown: !!c && !c.hidden, head: c?.querySelector('.cu-h')?.textContent, lines: [...(c?.querySelectorAll('.cu-l') || [])].map((l) => l.textContent), av: !!c?.querySelector('.av'), w: c ? Math.round(c.getBoundingClientRect().width) : 0 }; });
  // 11-09: the short form. A head, the counts on one line, and the record a tap away (tools/nov9-shots.mjs).
  check(cu.shown && cu.head === 'Catch me up \u00b7 since 9:10 AM' && cu.lines.length === 1 && /^2 done/.test(cu.lines[0]) && cu.av && cu.w <= 393 - 32,
    `${scheme}: Catch me up sits at the top of home with the counts on one line (${cu.lines.length} lines, ${cu.w}px)`);
  await p.screenshot({ path: `${out}/list-${scheme}.png` });
  // The line is always there, so the list never moves for it; when Ben's message lands, his row
  // glides to its new place (a flip animation) instead of jumping.
  const rowsWithLive = await p.evaluate(() => {
    window.__flips = 0;
    window.__flipIv = setInterval(() => { if (document.getAnimations().some((a) => a.id === 'flip')) window.__flips++; }, 25);
    return Math.round(document.querySelector('#rows').getBoundingClientRect().top);
  });
  await p.waitForTimeout(2300);
  const after = await p.evaluate(() => { clearInterval(window.__flipIv); return { rows: Math.round(document.querySelector('#rows').getBoundingClientRect().top), flips: window.__flips, off: !document.querySelector('#live').classList.contains('on'), text: document.querySelector('#live').textContent }; });
  check(after.off && after.text === 'All quiet' && after.rows === rowsWithLive, `${scheme}: the working line comes and goes without moving the list (rows at ${rowsWithLive} then ${after.rows}, "${after.text}")`);
  check(after.flips > 0, `${scheme}: a row that moves glides to its new place (${after.flips} frames animated)`);
  // 10-30: a bot's clients show as their own logos after its name (the names stay in the label).
  const names = await p.evaluate(() => {
    const el = [...document.querySelectorAll('.rc-name')].find((e) => e.textContent.startsWith('Ben'));
    const marks = [...(el?.querySelectorAll('.clstack .clmark img') || [])];
    return { text: el?.textContent, label: el?.getAttribute('aria-label'), marks: marks.map((i) => i.getAttribute('src')), loaded: marks.every((i) => i.complete && i.naturalWidth > 0) };
  });
  check(names.text === 'Ben' && names.label === 'Ben (Acme, Birch, Cedar)' && names.marks.join() === 'icons/clients/acme.webp,icons/clients/birch.webp,icons/clients/cedar.webp' && names.loaded,
    `${scheme}: bots show their clients as logos after the name (${names.text} + ${names.marks.length} logos, label "${names.label}")`);

  // Open the room by tapping its row, time the push. On a touch screen opening a chat adds no history
  // entry, so iOS's own edge swipe (a snapshot plus a replayed close: the "reload" flash) never runs.
  const hist0 = await p.evaluate(() => ({ n: history.length, coarse: matchMedia('(pointer: coarse)').matches }));
  const t0 = Date.now();
  await p.locator('.rc-name', { hasText: 'Team Room' }).first().click();
  await p.waitForFunction(() => document.body.classList.contains('thread-open'));
  await p.waitForTimeout(650); // push is 0.5 s; swipe tests start after it settles
  check(Date.now() - t0 < 1400, `${scheme}: room opens fast (${Date.now() - t0} ms incl. animation)`);
  const hist1 = await p.evaluate(() => history.length);
  check(hist0.coarse && hist1 === hist0.n, `${scheme}: opening a chat adds no history entry on touch (${hist0.n} -> ${hist1})`);
  await p.screenshot({ path: `${out}/room-${scheme}.png` });

  // Nothing selectable on a long hold.
  const sel = await p.evaluate(() => getComputedStyle(document.querySelector('.msgs')).webkitUserSelect || getComputedStyle(document.querySelector('.msgs')).userSelect);
  check(sel === 'none', `${scheme}: thread text is not selectable (${sel})`);

  // Interactive edge swipe: drag halfway, release slowly -> should stay open; flick -> closes.
  const swipe = async (to, steps, pause) => p.evaluate(async ({ to, steps, pause }) => {
    const g = document.querySelector('.edge-grab');
    const r = g.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (type, x) => g.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
    fire('pointerdown', 6);
    const frames = [];
    for (let i = 1; i <= steps; i++) {
      fire('pointermove', 6 + (to - 6) * (i / steps));
      await new Promise((res) => setTimeout(res, pause));
      frames.push(new DOMMatrix(getComputedStyle(document.querySelector('#thread-pane')).transform).m41);
    }
    const log = [];
    const mo = new MutationObserver((ms) => ms.forEach((m) => log.push(`${Math.round(performance.now() % 100000)}:${m.target.id || m.target.tagName}:${m.attributeName}=${(m.target.getAttribute(m.attributeName) || '').slice(0, 80)}`)));
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    mo.observe(document.querySelector('#thread-pane'), { attributes: true, attributeFilter: ['style', 'class'] });
    fire('pointerup', to);
    const after = [];
    for (let i = 0; i < 12; i++) { await new Promise((res) => setTimeout(res, 30)); after.push(Math.round(new DOMMatrix(getComputedStyle(document.querySelector('#thread-pane')).transform).m41)); }
    await new Promise((res) => setTimeout(res, 400));
    mo.disconnect();
    return { frames: frames.map(Math.round), after, log, open: document.body.classList.contains('thread-open') };
  }, { to, steps, pause });

  const slow = await swipe(150, 10, 40);
  check(slow.open, `${scheme}: slow partial swipe springs back open`);
  check(slow.after.every((x, i, a) => i === 0 || x <= a[i - 1] + 1), `${scheme}: spring back is monotonic, no jump (${slow.after.join(',')})${slow.after.every((x, i, a) => i === 0 || x <= a[i - 1] + 1) ? '' : ' LOG ' + slow.log.join(' | ')}`);
  const flick = await swipe(170, 4, 12);
  check(!flick.open, `${scheme}: quick flick goes back to the list`);
  check(flick.after.every((x, i, a) => i === 0 || x >= a[i - 1] - 1), `${scheme}: slide out never snaps back first (${flick.after.join(',')})`);

  // First-tap open while the list re-renders mid-press (a bot starts typing): must open on one tap.
  await p.goto(`${BASE}/#/`);
  await p.waitForTimeout(500);
  const firstTap = await p.evaluate(async (base) => {
    const row = document.querySelector('.chat-row[data-chat="dm-dora"]');
    const r = row.getBoundingClientRect();
    const opt = { pointerId: 3, pointerType: 'touch', clientX: r.left + 120, clientY: r.top + 30, bubbles: true, isPrimary: true, button: 0 };
    row.dispatchEvent(new PointerEvent('pointerdown', opt));
    await fetch(`${base}/mock/inject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 'dm-dora', sender: 'dora', text: 'On it.', typing_ms: 3000, status: 'Checking Fjord' }) });
    await new Promise((res) => setTimeout(res, 400)); // typing event re-renders the row under the finger
    const same = document.querySelector('.chat-row[data-chat="dm-dora"]') === row;
    const pressed = row.classList.contains('pressed');
    row.dispatchEvent(new PointerEvent('pointerup', opt));
    await new Promise((res) => setTimeout(res, 50));
    return { same, pressed, open: document.body.classList.contains('thread-open') && location.hash.includes('dm-dora') };
  }, BASE);
  check(firstTap.same && firstTap.pressed, `${scheme}: row element survives a live update mid-press (same=${firstTap.same}, highlighted=${firstTap.pressed})`);
  check(firstTap.open, `${scheme}: one tap opens the chat even while it updates`);

  // A live typing event in the open thread adds only the typing row; every message node stays.
  await p.goto(`${BASE}/#/chat/dm-ben`);
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${out}/ben-${scheme}.png` });
  const keep = await p.evaluate(async (base) => {
    const before = [...document.querySelectorAll('#msgs > *')];
    before.forEach((el) => { el.__mark = 1; });
    let removed = 0;
    const mo = new MutationObserver((recs) => { for (const r of recs) removed += [...r.removedNodes].filter((n) => n.__mark).length; });
    mo.observe(document.querySelector('#msgs'), { childList: true });
    await fetch(`${base}/mock/inject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 'dm-ben', sender: 'ben', text: 'Done.', typing_ms: 1500, status: 'Checking Acme' }) });
    await new Promise((r) => setTimeout(r, 500));
    const typing = !!document.querySelector('#msgs .typing-row');
    const kept = before.every((el) => el.isConnected);
    const head = document.querySelector('#head-av').firstElementChild;
    head.__mark = 1;
    await new Promise((r) => setTimeout(r, 1500)); // the message lands, typing row goes
    mo.disconnect();
    const anim = [...document.querySelectorAll('#msgs .enter-in')].length;
    return { typing, kept, removed, headKept: document.querySelector('#head-av').firstElementChild === head, anim };
  }, BASE);
  check(keep.typing && keep.kept && keep.removed === 0, `${scheme}: live typing keeps every message node (typing row=${keep.typing}, kept=${keep.kept}, removed=${keep.removed})`);
  check(keep.headKept, `${scheme}: header avatar is not rebuilt by live events`);
  check(keep.anim <= 1, `${scheme}: only the new message animates in (${keep.anim})`);

  // Emoji-only messages render large with no bubble.
  await p.goto(`${BASE}/#/chat/dm-ada`);
  await p.waitForTimeout(700);
  const emo = await p.evaluate(() => [...document.querySelectorAll('.bubble.jumbo')].map((b) => { const cs = getComputedStyle(b); const t = getComputedStyle(b.querySelector('.btext')); return { text: b.textContent, size: parseFloat(t.fontSize), bg: cs.backgroundImage === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor), tail: !!b.querySelector('.tl') }; }));
  check(emo.length >= 2 && emo.every((e) => e.size >= 44 && e.bg && !e.tail), `${scheme}: emoji-only messages are large with no bubble (${emo.map((e) => `${e.text}:${e.size}px`).join(', ')})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/dm-${scheme}.png` });

  // Long press: the tapback bar is real emoji text, no drawn glyphs.
  const bub = p.locator('.row.in .bubble:not(.jumbo)').last();
  await bub.dispatchEvent('contextmenu');
  await p.waitForTimeout(450);
  const bar = await p.evaluate(() => { const b = document.querySelector('.lp-bar'); return b ? { text: [...b.querySelectorAll('.lp-emoji')].map((x) => x.textContent).join(''), svg: b.querySelectorAll('svg').length } : null; });
  check(!!bar && bar.text === '❤️👍👎😂‼️❓' && bar.svg === 0, `${scheme}: tapback bar uses real emoji (${bar?.text}, svg=${bar?.svg})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/longpress-${scheme}.png` });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);
  // "+" menu: grows out of the "+", and every row does something real.
  await p.goto(`${BASE}/#/chat/room`);
  await p.waitForTimeout(700);
  const openMenu = async () => { await p.locator('#plus-btn').click(); await p.waitForTimeout(520); };
  await openMenu();
  const pm = await p.evaluate(() => { const m = document.querySelector('.pm'); const b = document.querySelector('#plus-btn').getBoundingClientRect(); const r = m?.getBoundingClientRect(); return { rows: [...document.querySelectorAll('.pm-row')].map((x) => x.dataset.act).join(','), covers: !!r && r.left <= b.left && r.bottom >= b.top + b.height / 2 }; });
  check(pm.rows === 'camera,photos,file,all' && pm.covers, `${scheme}: room "+" menu has Camera, Photos, File, Ask everyone and grows over the button (${pm.rows})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/plus-menu-${scheme}.png` });
  const chooserFor = async (act) => { const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 2000 }).catch(() => null), p.locator(`.pm-row[data-act=${act}]`).click()]); return fc; };
  const fcPhotos = await chooserFor('photos');
  check(!!fcPhotos && fcPhotos.isMultiple(), `${scheme}: Photos row opens the photo picker`);
  await p.waitForTimeout(300);
  await openMenu();
  const fcCam = await chooserFor('camera');
  const cap = await p.evaluate(() => document.querySelector('#composer input[capture]')?.getAttribute('capture'));
  check(!!fcCam && cap === 'environment', `${scheme}: Camera row opens the picker with capture (${cap})`);
  await p.waitForTimeout(300);
  await openMenu();
  await p.locator('.pm-row[data-act=all]').click();
  await p.waitForTimeout(350);
  const ask = await p.evaluate(() => ({ v: document.querySelector('#input').value, menus: document.querySelectorAll('.pm').length }));
  check(ask.v.startsWith('@all ') && ask.menus === 0, `${scheme}: Ask everyone inserts "@all " and the menu closes (${JSON.stringify(ask.v)})`);
  await p.evaluate(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); });

  // Details: the name capsule opens them, back closes them, the thread's nodes are untouched.
  const details = async (chat, shot) => {
    await p.goto(`${BASE}/#/chat/${chat}`);
    await p.waitForTimeout(700);
    await p.evaluate(() => { window.__nodes = [...document.querySelectorAll('#msgs > *')]; });
    if (chat === 'dm-dora') {
      const sub = await p.evaluate(() => ({ text: document.querySelector('.hn-sub')?.textContent || '', logo: document.querySelector('.hn-clients .clmark img')?.getAttribute('src') || '' }));
      check(sub.text === 'Fjord' && sub.logo === 'icons/clients/fjord.webp', `${scheme}: thread header shows the bot's clients with their logo (${sub.text}, ${sub.logo})`);
    }
    await p.locator('#head-name').click();
    await p.waitForTimeout(700);
    const d = await p.evaluate(() => { const el = document.querySelector('#details'); return { tf: getComputedStyle(el).transform, hid: el.hidden, anims: el.getAnimations().length, open: !el.hidden && getComputedStyle(el).transform === 'none', name: el.querySelector('.dt-name')?.textContent, acts: [...el.querySelectorAll('.dt-act')].map((b) => `${b.dataset.act}${b.disabled ? '(off)' : ''}`).join(','), groups: [...el.querySelectorAll('.dt-gtitle')].map((t) => t.textContent).join(','), members: el.querySelectorAll('.dt-member').length }; });
    if (scheme === 'light') await p.screenshot({ path: `${out}/${shot}-${scheme}.png` });
    return d;
  };
  const dd = await details('dm-dora', 'details-dm');
  check(dd.open && dd.name === 'Dora' && /^message,room,approvals/.test(dd.acts) && dd.groups === 'Clients,Today,This week,Routines,Always rules,Memory,Recent actions,Conversation,Shared photos', `${scheme}: name capsule opens bot details (${dd.name}: ${dd.acts}; ${dd.groups})`);
  const pz = await p.evaluate(async () => {
    const t = document.querySelector('#details input[data-pause="Fjord"]');
    if (!t || t.disabled) return { ready: false };
    t.click();
    await new Promise((r) => setTimeout(r, 400));
    const on = { checked: t.checked, note: document.querySelector('#details [data-pst="Fjord"]')?.textContent };
    t.click();
    await new Promise((r) => setTimeout(r, 400));
    return { ready: true, ...on, after: t.checked, back: document.querySelector('#details [data-pst="Fjord"]')?.textContent };
  });
  check(pz.ready && pz.checked && /^Paused since .*: nothing goes out$/.test(pz.note) && !pz.after && pz.back === 'Pause holds every send and change',
    `${scheme}: a client's pause switch holds and resumes (${pz.note} / ${pz.back})`);
  await p.locator('.dt-back').click();
  await p.waitForTimeout(500);
  const kept = await p.evaluate(() => ({ hidden: document.querySelector('#details').hidden, same: window.__nodes.length > 0 && window.__nodes.every((n) => n.isConnected) && document.querySelectorAll('#msgs > *').length === window.__nodes.length }));
  check(kept.hidden && kept.same, `${scheme}: back closes details without rebuilding thread nodes (hidden=${kept.hidden}, same=${kept.same})`);
  const dr = await details('room', 'details-room');
  check(dr.open && dr.members === 5 && /^Members,(Room rules,Done without a tap,)?Notifications,Shared photos$/.test(dr.groups), `${scheme}: room details list the bots (${JSON.stringify(dr)})`);
  await p.waitForTimeout(300);
  const rr = await p.evaluate(async () => {
    const d = document.querySelector('#details');
    const pick = () => ({ groups: [...d.querySelectorAll('.dt-gtitle')].map((t) => t.textContent).join(','), b2b: d.querySelector('input[data-rule="botToBot"]')?.checked,
      chain: d.querySelector('.dt-segb.on')?.textContent, mutes: d.querySelectorAll('input[data-rule="mute"]').length, aud: [...d.querySelectorAll('.dt-aud .dt-cl')].map((x) => x.firstChild.textContent) });
    const before = pick();
    d.querySelector('input[data-rule="mute"][data-id="ada"]').click();
    await new Promise((r) => setTimeout(r, 400));
    d.querySelector('.dt-segb[data-chain="2"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const after = { muted: d.querySelector('input[data-rule="mute"][data-id="ada"]').checked, chain: d.querySelector('.dt-segb.on')?.textContent };
    d.querySelector('input[data-rule="mute"][data-id="ada"]').click();
    await new Promise((r) => setTimeout(r, 400));
    d.querySelector('.dt-segb[data-chain="4"]').click();
    await new Promise((r) => setTimeout(r, 400));
    return { before, after };
  });
  check(rr.before.groups === 'Members,Room rules,Done without a tap,Notifications,Shared photos' && rr.before.b2b === true && rr.before.chain === '4' && rr.before.mutes === 5
    && rr.before.aud.join('|') === 'Sunday post reply|Pause 3 keywords|Vendor time update' && rr.after.muted && rr.after.chain === '2',
  `${scheme}: room rules save (mute, turns) and the auto log lists what went ahead (${JSON.stringify(rr)})`);
  if (scheme === 'light') { await p.evaluate(() => document.querySelector('#details .dt-rules')?.scrollIntoView()); await p.waitForTimeout(200); await p.screenshot({ path: `${out}/room-rules-${scheme}.png` }); }
  // Edge swipe shrinks the details to a card and closes them.
  await p.mouse.move(6, 420); await p.mouse.down();
  for (let x = 20; x <= 260; x += 30) { await p.mouse.move(x, 430); await p.waitForTimeout(16); }
  await p.mouse.up();
  await p.waitForTimeout(500);
  const sw = await p.evaluate(() => ({ hidden: document.querySelector('#details').hidden, same: window.__nodes.every((n) => n.isConnected), route: location.hash }));
  check(sw.hidden && sw.same && sw.route === '#/chat/room', `${scheme}: edge swipe closes details back to the chat (${sw.route})`);

  // Keyboard: the composer stays attached when the visual viewport shrinks.
  await p.goto(`${BASE}/#/chat/dm-ben`);
  await p.waitForTimeout(700);
  await p.locator('#input').click();
  await p.keyboard.type('On my way');
  await p.setViewportSize({ width: 393, height: 852 - 336 });
  await p.waitForTimeout(400);
  const kb = await p.evaluate(() => { const c = document.querySelector('#field').getBoundingClientRect(); const rows = [...document.querySelectorAll('#msgs .row')]; const last = rows[rows.length - 1].getBoundingClientRect(); return { gap: Math.round(innerHeight - c.bottom), lastAbove: last.bottom <= c.top + 1, send: getComputedStyle(document.querySelector('#send-btn')).display, h: innerHeight }; });
  check(kb.gap >= 4 && kb.gap <= 14 && kb.lastAbove && kb.send === 'grid', `${scheme}: composer rides the shrunken viewport (gap ${kb.gap}px of ${kb.h}, newest above it, send shown)`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/keyboard-composer-${scheme}.png` });
  await p.setViewportSize({ width: 393, height: 852 });
  await p.evaluate(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); });
  await p.waitForTimeout(300);
  // Keyboard: a downward drag on the messages puts it away (no Done button needed).
  await p.locator('#input').click();
  await p.setViewportSize({ width: 393, height: 852 - 336 });
  await p.waitForTimeout(300);
  const dismissed = await p.evaluate(async () => {
    const sc = document.querySelector('#scroller');
    const kb = document.documentElement.classList.contains('kb-open');
    const focused = document.activeElement?.id === 'input';
    // Desktop WebKit has no Touch constructor: plain events carrying the same touches list.
    const fire = (type, ys) => { const ev = new Event(type, { bubbles: true }); Object.defineProperty(ev, 'touches', { value: ys.map((y) => ({ clientX: 200, clientY: y })) }); sc.dispatchEvent(ev); };
    fire('touchstart', [200]);
    for (const y of [210, 222, 236, 250]) fire('touchmove', [y]);
    fire('touchend', []);
    return { kb, focused, after: document.activeElement?.id || 'body' };
  }).catch((e) => ({ error: e.message }));
  check(dismissed.kb && dismissed.focused && dismissed.after !== 'input', `${scheme}: dragging down on the messages puts the keyboard away (${JSON.stringify(dismissed)})`);
  await p.setViewportSize({ width: 393, height: 852 });
  await p.waitForTimeout(300);

  // Approval cards: a plain title and sub line up front, the full plan behind Details; hold for Reply.
  const plan = 'Run the remote-start ad Nov 2 to 15 with a hard $350 cap. ' + 'Keep the form, test the new email and scheduler, keep the promo estimate titles. '.repeat(5);
  await inject({ chat_id: 'dm-cleo', sender: 'cleo', text: `**Ember Custom**: November remote-start flight (#11)\n\nPlan:\n${plan}`, typing_ms: 0,
    buttons: [[{ label: 'Approve', data: 'a|11|h', style: 'primary' }, { label: 'Decline', data: 'n|11|h', style: 'danger' }]] });
  await p.goto(`${BASE}/#/chat/dm-cleo`);
  await p.waitForTimeout(900);
  const card = await p.evaluate(() => { const a = [...document.querySelectorAll('.appr')].pop(); return { title: a?.querySelector('.ap-title')?.textContent, sub: a?.querySelector('.ap-sub')?.textContent, mark: !!a?.querySelector('.appmark'), q: !!a?.querySelector('.appr-q'), hint: a?.querySelector('.appr-hint')?.textContent, more: a?.querySelector('.appr-more')?.textContent }; });
  check(card.title === 'November remote-start flight' && card.sub === 'Ember Custom' && card.mark && !card.q && card.hint === 'slide to approve' && card.more === 'Details', `${scheme}: a card leads with a plain title and sub line, no ids (${card.title} / ${card.sub} / ${card.hint})`);
  await p.locator('.appr-more').last().click();
  await p.waitForTimeout(200);
  const opened = await p.evaluate(() => { const a = [...document.querySelectorAll('.appr')].pop(); const q = a.querySelector('.appr-q'); return { plan: /remote-start ad Nov 2 to 15/.test(q?.textContent || ''), label: a.querySelector('.appr-more').textContent }; });
  check(opened.plan && opened.label === 'Hide details', `${scheme}: Details opens the full plan on the card (${opened.label})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/card-details-${scheme}.png` });
  // A finished plan is a receipt: the proof, what changed, who and how long, and Undo (two taps).
  await inject({ chat_id: 'dm-dora', sender: 'dora', text: '**Fjord Garage Doors**: Fjord: add 12 negatives (#72)\n\nAdd 12 negatives to the Fjord search campaign.\n\nDone by Dora in 12 min. Added 12 negatives; change history shows them at 2:14 PM.\nChanged: 0 negatives -> 12 negatives\nUndo: remove the 12 negatives', typing_ms: 0 });
  await p.goto(`${BASE}/#/chat/dm-dora`);
  await p.waitForTimeout(900);
  const rc = await p.evaluate(() => { const r = [...document.querySelectorAll('.rcpt')].pop(); return { proof: r?.querySelector('.rcpt-proof')?.textContent, change: r?.querySelector('.rcpt-v')?.textContent, took: r?.querySelector('.rcpt-took')?.textContent, undo: r?.querySelector('.rcpt-undo')?.textContent, waiting: [...document.querySelectorAll('.appr')].some((a) => /12 negatives/.test(a.textContent)) }; });
  check(rc.proof === 'Added 12 negatives; change history shows them at 2:14 PM.' && rc.change === '0 negatives \u2192 12 negatives' && rc.took === 'By Dora · took 12 min' && rc.undo === 'Undo' && !rc.waiting,
    `${scheme}: a finished plan reads as a receipt with Undo (${rc.proof} / ${rc.change} / ${rc.took})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/receipt-${scheme}.png` });
  await p.locator('.rcpt-undo').last().click();
  const armed = await p.evaluate(() => document.querySelectorAll('.rcpt-undo.armed').length);
  await p.locator('.rcpt-undo').last().click();
  await p.waitForTimeout(500);
  const undone = await p.evaluate(() => ({ btn: document.querySelectorAll('.rcpt-undo').length, asked: [...document.querySelectorAll('.rcpt-asked')].pop()?.textContent }));
  check(armed === 1 && undone.btn === 0 && undone.asked === 'Undo asked', `${scheme}: Undo takes two taps, then says it was asked (${JSON.stringify(undone)})`);
  // Needs a human: a button that opens the page, a sealed field, and the slide sends the value (not before).
  await inject({ chat_id: 'dm-ada', sender: 'ada', text: '**Team**: Google sign-in code (#81)\n\nGoogle wants the code it just texted you.\n\nDetails:\nSealed: Google sign-in code', typing_ms: 0,
    buttons: [[{ label: 'Open Google', data: 'link', url: 'https://accounts.google.com/' }], [{ label: 'Send it', data: 'a|81|h', style: 'primary' }, { label: "Can't now", data: 'n|81|h', style: 'danger' }]] });
  await p.goto(`${BASE}/#/chat/dm-ada`);
  await p.waitForTimeout(900);
  const hu = await p.evaluate(() => { const a = [...document.querySelectorAll('.appr')].pop(); return { link: a?.querySelector('.appr-link')?.getAttribute('href'), linkText: a?.querySelector('.appr-link')?.textContent, field: a?.querySelector('.sealed-in')?.type, label: a?.querySelector('.appr-sealed-l')?.firstChild?.textContent, quiet: [...(a?.querySelectorAll('.card-quiet') || [])].map((b) => b.textContent) }; });
  check(hu.link === 'https://accounts.google.com/' && hu.linkText === 'Open Google' && hu.field === 'password' && hu.label === 'Google sign-in code' && !hu.quiet.includes('Open Google'),
    `${scheme}: a Needs-you card has the page button and a sealed field (${JSON.stringify(hu)})`);
  await p.locator('.appr .appr-knob').last().focus();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  const early = await (await fetch(`${BASE}/mock/last-sealed`)).json();
  const code = scheme === 'light' ? '482913' : '739104';
  await p.locator('.sealed-in').last().fill(code);
  if (scheme === 'light') await p.screenshot({ path: `${out}/needs-human-${scheme}.png` });
  await p.locator('.appr .appr-knob').last().focus();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1200);
  const sent = await (await fetch(`${BASE}/mock/last-sealed`)).json();
  check(early.sealed !== code && sent.sealed === code, `${scheme}: the slide waits for the code, then sends it sealed (${early.sealed} then ${sent.sealed ? 'sent' : 'missing'})`);
  // A card from one of Alex's recordings shows what he said and when, above the slider.
  await inject({ chat_id: 'dm-ben', sender: 'ben', text: "**Acme**: text Pat the lighting end date (#71)\n\nI'll draft the text to Pat with the lighting ad end date and bring it back for your yes.\n\nFrom your recording, Fri Oct 30, 2:14 PM (Acme check-in): \u201cI'll text Pat tonight about when the lighting ad ends\u201d\n\nDetails:\nChecked first: not done yet.\nSource: plaud:of_1:commit:0", typing_ms: 0,
    buttons: [[{ label: 'Approve', data: 'a|71|h', style: 'primary' }, { label: 'Decline', data: 'n|71|h', style: 'danger' }]] });
  await p.goto(`${BASE}/#/chat/dm-ben`);
  await p.waitForTimeout(900);
  const heard = await p.evaluate(() => { const a = [...document.querySelectorAll('.appr')].pop(); return { q: a?.querySelector('.heard-q')?.textContent, w: a?.querySelector('.heard-w')?.textContent, note: a?.textContent || '' }; });
  check(/^\u201cI'll text Pat tonight/.test(heard.q || '') && heard.w === 'From your recording · Fri Oct 30, 2:14 PM · Acme check-in' && (heard.note.match(/From your recording/g) || []).length === 1,
    `${scheme}: a recording card shows the quote and when, once (${heard.q} / ${heard.w} / ${heard.note.slice(0, 400)})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/card-recording-${scheme}.png` });
  await p.goto(`${BASE}/#/chat/dm-cleo`);
  await p.waitForTimeout(500);
  // Tasks that are not waiting (Doing, Auto reply, finished cards) read as cards too: the app, a plain title,
  // the actual words, where it stands; no ids or phone endings. A long plain bot message folds behind More.
  await inject({ chat_id: 'dm-cleo', sender: 'cleo', text: `Doing: **Dune Dune**: publish the corrected flyer on Facebook and Instagram (#34)\n\nPost the fixed 3-8 PM flyer to both pages. Postiz id cmv14kuwp00b6pm6c3q9j4ii5 checked.\n\nDetails:\n${plan}`, typing_ms: 0 });
  await inject({ chat_id: 'dm-cleo', sender: 'cleo', text: 'Auto reply: **Ember Custom**: flyer time fixed (#35)\n\nText to Nina Work (ends 0142):\n"Hey Nina, the flyer now says 3-8 PM."\n\nSent on its own. Texted Nina Work (ends 0142) at 2:20 PM, sent, delivery not confirmed yet (SMS).', typing_ms: 0 });
  await p.waitForTimeout(700);
  const tasks = await p.evaluate(() => [...document.querySelectorAll('.tk')].slice(-2).map((t) => ({ title: t.querySelector('.ap-title').textContent, sub: t.querySelector('.ap-sub')?.textContent, duo: !!t.querySelector('.appmark.duo .mini'), note: t.querySelector('.tk-note')?.textContent, bub: t.querySelector('.tk-bub')?.textContent, st: t.querySelector('.tk-st')?.textContent, why: t.querySelector('.tk-why')?.textContent, more: !!t.querySelector('.appr-more'), all: t.textContent })));
  const [doing, auto] = tasks;
  check(doing?.title === 'Publish the corrected flyer on Facebook and Instagram' && doing.sub === 'Dune Eats' && doing.duo && doing.note === 'Post the fixed 3-8 PM flyer to both pages.' && doing.st === 'Working on it' && doing.more && !/#34|cmv14/.test(doing.all), `${scheme}: a Doing task is a card with both app logos, the plain summary and Working on it (${doing?.title} / ${doing?.note} / ${doing?.st})`);
  check(auto?.title === 'Flyer time fixed' && auto.sub === 'Ember Custom · to Nina' && auto.bub === 'Hey Nina, the flyer now says 3-8 PM.' && auto.st === 'Sent on its own' && auto.why === 'Texted Nina Work at 2:20 PM.' && !/ends 0142|SMS/.test(auto.all), `${scheme}: an auto reply shows the text as a green bubble and how it went (${auto?.sub} / ${auto?.st} / ${auto?.why})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/tasks-${scheme}.png` });
  await inject({ chat_id: 'dm-cleo', sender: 'cleo', text: `Here is everything I checked on the flyer.\n\n${plan}`, typing_ms: 0 });
  await inject({ chat_id: 'dm-cleo', sender: 'cleo', text: 'Flyer is fixed and posted.', typing_ms: 0 });
  await p.waitForTimeout(700);
  const fold = await p.evaluate(() => { const b = [...document.querySelectorAll('.bubble.in .btext')]; const long = b.filter((e) => /everything I checked on the flyer/.test(e.textContent)).pop(); const short = b.filter((e) => /Flyer is fixed/.test(e.textContent)).pop(); return { long: long?.classList.contains('clamped'), h: Math.round(long?.getBoundingClientRect().height || 0), more: !!long?.parentElement.querySelector('.bubble-more'), short: short && !short.classList.contains('clamped') && !short.parentElement.querySelector('.bubble-more') }; });
  await p.locator('.bubble-more').last().click();
  await p.waitForTimeout(200);
  const unfold = await p.evaluate(() => { const e = [...document.querySelectorAll('.bubble.in .btext')].filter((x) => /everything I checked on the flyer/.test(x.textContent)).pop(); return { clamped: e.classList.contains('clamped'), h: Math.round(e.getBoundingClientRect().height), label: e.parentElement.querySelector('.bubble-more').textContent }; });
  check(fold.long && fold.more && fold.short && !unfold.clamped && unfold.h > fold.h && unfold.label === 'Less', `${scheme}: a long bot message folds behind More, a short one does not (${fold.h}px -> ${unfold.h}px)`);
  const held = await p.evaluate(async () => {
    const q = [...document.querySelectorAll('.appr .ap-head')].pop();
    const r = q.getBoundingClientRect();
    const opt = { pointerId: 9, pointerType: 'touch', clientX: r.left + 30, clientY: r.top + 10, bubbles: true, isPrimary: true, button: 0 };
    q.dispatchEvent(new PointerEvent('pointerdown', opt));
    // WebKit sends stray mouse moves after a scroll or layout shift; they must not cancel the finger's hold.
    await new Promise((res) => setTimeout(res, 120));
    q.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 47, clientY: 713, bubbles: true, isPrimary: true }));
    await new Promise((res) => setTimeout(res, 440));
    q.dispatchEvent(new PointerEvent('pointerup', opt));
    const reply = document.querySelector('.lp [data-act="reply"]');
    return { menu: !!document.querySelector('.lp'), reply: !!reply };
  });
  await p.waitForTimeout(250);
  await p.locator('.lp [data-act="reply"]').click().catch(() => {});
  await p.waitForTimeout(350);
  const replying = await p.evaluate(() => document.querySelector('.rb-title')?.textContent || '');
  check(held.menu && held.reply && /Cleo/.test(replying), `${scheme}: holding an approval card offers Reply and it quotes the card (${replying})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/card-reply-${scheme}.png` });
  await p.evaluate(() => document.querySelector('.rb-x')?.click());

  // Vesper features: Runs (routines from Hermes), review with edits on a text card, the agent page.
  await p.goto(`${BASE}/#/`);
  await p.waitForTimeout(900);
  const runsRow = await p.evaluate(() => ({ hidden: document.querySelector('#runs-row-wrap').hidden, text: document.querySelector('#runs-row').textContent }));
  check(!runsRow.hidden && /^Runs today\d+ done/.test(runsRow.text), `${scheme}: home shows a Runs today line (${runsRow.text})`);
  await p.locator('#runs-row').click();
  await p.waitForTimeout(800);
  const runs = await p.evaluate(() => ({ open: document.body.classList.contains('runs-open'), hash: location.hash, jobs: document.querySelectorAll('.rn-job').length, sched: document.querySelector('.rn-job .rn-tx span')?.textContent }));
  check(runs.open && runs.hash === '#/runs' && runs.jobs >= 8 && /^Weekdays at 7:45/.test(runs.sched), `${scheme}: Runs lists every routine in plain schedules (${runs.jobs}, ${runs.sched})`);
  const watch = await p.evaluate(() => [...document.querySelectorAll('.rn-ev .rn-tx')].map((e) => e.textContent).find((t) => /^Client watch/.test(t)) || '');
  const watchRows = await p.evaluate(() => [...document.querySelectorAll('.rn-ev .rn-tx b')].filter((e) => e.textContent === 'Client watch').length);
  check(/12 checks today · woke 2×/.test(watch) && watchRows === 1, `${scheme}: a watch shows as one line with its checks and wakes (${watch})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/runs-${scheme}.png` });
  await p.locator('.rn-jhead', { hasText: 'Prospect scan' }).click();
  await p.waitForTimeout(300);
  await p.locator('.rn-job.open [data-run-act="pause"]').click();
  await p.waitForTimeout(700);
  const paused = await p.evaluate(() => ({ btn: [...document.querySelectorAll('.rn-job.open [data-run-act]')].map((b) => b.textContent).join(','), toast: document.querySelector('.rn-toast').textContent, label: document.querySelector('.rn-job.open .rn-tx span').textContent }));
  check(paused.btn === 'Run now,Resume' && paused.toast === 'Paused.' && /Paused/.test(paused.label), `${scheme}: pausing a routine says so and offers Resume (${paused.btn}; ${paused.toast})`);
  await p.locator('.rn-job.open [data-run-act="resume"]').click();
  await p.waitForTimeout(600);
  // New routine: pick Dora, name it, Weekly on Friday at 3 PM, the instructions, quiet on, Add.
  await p.locator('.rn-add').click();
  await p.waitForTimeout(450);
  await p.locator('.rt-bot[data-bot="dora"]').click();
  await p.locator('.rt-in[data-f="name"]').fill(`Friday ad recap ${scheme}`);
  await p.locator('.rt-seg [data-kind="weekly"]').click();
  await p.locator('.rt-chip[data-day="5"]').click();
  await p.locator('.rt-time').fill('15:00');
  await p.locator('.rt-prompt').fill('Pull this week\'s Fjord numbers and tell me cost per lead and what changed, in five lines.');
  const sum = await p.evaluate(() => document.querySelector('.rt-sum').textContent);
  if (scheme === 'light') await p.screenshot({ path: `${out}/routine-new-${scheme}.png` });
  await p.locator('.rt-go').click();
  await p.waitForTimeout(900);
  const added = await p.evaluate((n) => ({ sheet: !!document.querySelector('.rt-ov'), toast: document.querySelector('.rn-toast').textContent, row: [...document.querySelectorAll('.rn-job.open .rn-tx')].map((e) => e.textContent).join('') }), `Friday ad recap ${scheme}`);
  check(sum === 'Dora runs this every Fri at 3:00 PM.' && !added.sheet && /^Added/.test(added.toast) && new RegExp(`Friday ad recap ${scheme}Fridays at 3:00 PM`).test(added.row), `${scheme}: New routine adds it to Runs with a plain schedule (${sum} / ${added.row.slice(0, 50)})`);
  await p.locator('.rn-job.open [data-edit-job]').click();
  await p.waitForTimeout(400);
  const editing = await p.evaluate(() => ({ title: document.querySelector('.rt-sheet .ed-top b').textContent, name: document.querySelector('.rt-in[data-f="name"]').value, kind: document.querySelector('.rt-seg .on').textContent, quiet: document.querySelector('.rt-tog[data-f="quiet"]').checked }));
  await p.locator('.rt-in[data-f="name"]').fill(`Fjord Friday recap ${scheme}`);
  await p.locator('.rt-go').click();
  await p.waitForTimeout(800);
  const edited = await p.evaluate(() => document.querySelector('.rn-job.open .rn-tx b')?.textContent);
  check(editing.title === 'Edit routine' && editing.kind === 'Weekly' && editing.quiet && /^Friday ad recap/.test(editing.name) && edited === `Fjord Friday recap ${scheme}`, `${scheme}: Edit opens the routine as it was and saves the change (${edited})`);
  await p.locator('.rn-back').click();
  await p.waitForTimeout(700);
  check(await p.evaluate(() => !document.body.classList.contains('runs-open') && location.hash === '#/'), `${scheme}: back leaves Runs for the list`);
  await inject({ chat_id: 'dm-cleo', sender: 'cleo', typing_ms: 0, text: '**Dune Dune**: tell the vendors the Truck Meet starts at 5 PM (#512)\n\nText to 9 vendors:\n"Truck Meet update: we now open at 5 PM Saturday. Same spot, same setup time."',
    buttons: [[{ label: 'Approve', data: 'a|512|h', style: 'primary' }, { label: 'Decline', data: 'n|512|h', style: 'danger' }]] });
  await p.goto(`${BASE}/#/chat/dm-cleo`);
  await p.waitForTimeout(900);
  const editable = await p.locator('.appr-edit').count();
  if (editable) {
    await p.locator('.appr-edit').last().click();
    await p.waitForTimeout(500);
    const draft = await p.evaluate(() => document.querySelector('.ed-field').value);
    await p.locator('.ed-field').fill('Truck Meet: we open at 5 PM Saturday. Trucks roll in at 3:30.');
    if (scheme === 'light') await p.screenshot({ path: `${out}/edit-${scheme}.png` });
    await p.locator('.ed-send').click();
    await p.waitForTimeout(1500);
    const sent = await p.evaluate(() => [...document.querySelectorAll('.tk .tk-bub')].map((b) => b.textContent).some((t) => /Trucks roll in at 3:30/.test(t)));
    check(/^Truck Meet update: we now open at 5 PM/.test(draft) && sent, `${scheme}: Edit opens the drafted text and sends the changed words (${draft.slice(0, 30)}…)`);
  } else check(false, `${scheme}: a drafted text card offers Edit`);
  // Change it (11-02): a waiting card offers Change it; the sheet starts him off, nothing goes out, and his
  // words land under the card as his reply.
  await inject({ chat_id: 'dm-ada', sender: 'ada', typing_ms: 0, text: '**Team**: Nudge Hugo (Green Leaf Landscaping): decision on hiring the studio (#604)\n\nHugo still owes you this. Sliding has Ada put up a short follow-up for you to send.',
    buttons: [[{ label: 'Approve', data: 'a|604|h', style: 'primary' }, { label: 'Decline', data: 'n|604|h', style: 'danger' }]] });
  await p.goto(`${BASE}/#/chat/dm-ada`);
  await p.waitForTimeout(900);
  const chBtn = p.locator('.appr-change').last();
  const foot = await p.evaluate(() => { const f = [...document.querySelectorAll('.appr-foot')].pop(); const r = f?.getBoundingClientRect(); return f ? { h: Math.round(r.height), labels: [...f.querySelectorAll('button')].map((b) => b.textContent) } : null; });
  check(foot && foot.labels.includes('Change it') && foot.labels.includes('Ask') && foot.h <= 44, `${scheme}: a waiting card offers Change it on one footer line (${foot?.labels.join(' · ')}, ${foot?.h}px)`);
  await chBtn.click();
  await p.waitForTimeout(500);
  const sheet = await p.evaluate(() => ({ title: document.querySelector('.ed-ov .ed-top b')?.textContent, starts: [...document.querySelectorAll('.ch-start')].map((b) => b.textContent), send: document.querySelector('.ed-ov .ed-send')?.textContent, disabled: document.querySelector('.ed-ov .ed-send')?.disabled }));
  await p.locator('.ch-start').first().click();
  const filled = await p.evaluate(() => document.querySelector('.ch-field').value);
  await p.locator('.ch-field').fill('Start a Claude session for this instead. Check his website first.');
  if (scheme === 'light') await p.screenshot({ path: `${out}/change-${scheme}.png` });
  await p.locator('.ed-ov .ed-send').click();
  await p.waitForTimeout(2400);
  const chAfter = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.row')];
    const mine = rows.filter((r) => r.classList.contains('out')).pop();
    return { mine: mine?.textContent || '', quoted: !!mine?.querySelector('.rq, .reply, .quote, [class*="reply"]'), changed: [...document.querySelectorAll('.tk-st, .card-resolved, .st')].map((e) => e.textContent).join(' | '), sheet: !!document.querySelector('.ed-ov'), left: [...document.querySelectorAll('.appr-change')].length };
  });
  check(sheet.title === 'Change it' && sheet.starts.length === 4 && sheet.send === 'Send to Ada' && sheet.disabled && /^Start a Claude session/.test(filled), `${scheme}: Change it opens a sheet with ways to start and sends to the bot (${sheet.starts.join(' / ')})`);
  check(!chAfter.sheet && /Check his website first/.test(chAfter.mine) && /Changed/.test(chAfter.changed), `${scheme}: his words land in the thread and the card reads Changed (${chAfter.changed.slice(0, 60)})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/change-after-${scheme}.png` });
  // Ask (11-02): a question about a waiting card goes under it as his reply; the card stays up.
  // (Eli's thread, so the waiting card does not change Ada's mood checked below.)
  await inject({ chat_id: 'dm-eli', sender: 'eli', typing_ms: 0, text: '**Leads**: Northside Mobile Welding: first text (#605)\n\nI’ll draft a first text to Mark about the welding quote and bring it back for your yes.',
    buttons: [[{ label: 'Approve', data: 'a|605|h', style: 'primary' }, { label: 'Decline', data: 'n|605|h', style: 'danger' }]] });
  await p.goto(`${BASE}/#/chat/dm-eli`);
  await p.waitForTimeout(900);
  const waitingBefore = await p.evaluate(() => document.querySelectorAll('.appr').length);
  await p.locator('.appr-ask').last().click();
  await p.waitForTimeout(500);
  const askSheet = await p.evaluate(() => ({ title: document.querySelector('.ed-ov .ed-top b')?.textContent, starts: [...document.querySelectorAll('.ch-start')].map((b) => b.textContent), note: document.querySelector('.ed-ov .ed-note')?.textContent }));
  await p.locator('.ch-start').first().click();
  // The keyboard: the sheet fits the visible area above it (iOS shrinks only the visual viewport, so the
  // overlay follows --app-h). Simulate a 470 px visible area with the keyboard open.
  // 11-06: the app now re-checks the height on every focus change, so the keyboard is simulated by really shrinking
  // the screen with the field focused (writing --app-h by hand was overwritten by the re-check).
  await p.setViewportSize({ width: 393, height: 470 });
  await p.waitForTimeout(450);
  const kbFit = await p.evaluate(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); return { field: r('.ed-ov .ed-field'), send: r('.ed-ov .ed-send'), ov: r('.ed-ov') }; });
  if (scheme === 'light') await p.screenshot({ path: `${out}/ask-keyboard-${scheme}.png` });
  check(kbFit.ov.height === 470 && kbFit.send.bottom <= 470 && kbFit.field.top >= 59 && kbFit.field.height >= 90, `${scheme}: with the keyboard open the sheet sits above it, field and button visible (field ${Math.round(kbFit.field.top)}-${Math.round(kbFit.field.bottom)}, send ends ${Math.round(kbFit.send.bottom)} of 470)`);
  await p.setViewportSize({ width: 393, height: 852 });
  await p.waitForTimeout(300);
  await p.locator('.ed-ov .ed-send').click();
  await p.waitForTimeout(1200);
  const asked = await p.evaluate(() => { const mine = [...document.querySelectorAll('.row.out')].pop(); return { text: mine?.textContent || '', quote: mine?.querySelector('.quote')?.textContent || '', waiting: document.querySelectorAll('.appr').length }; });
  check(askSheet.title === 'Ask Eli' && askSheet.starts.length === 4 && /stays up/.test(askSheet.note) && /Why this\?/.test(asked.text) && /Northside Mobile Welding/.test(asked.quote) && asked.waiting === waitingBefore,
    `${scheme}: Ask sends his question under the card and the card stays up (${asked.waiting} waiting)`);
  await p.goto(`${BASE}/#/chat/dm-ben`);
  await p.waitForTimeout(800);
  await p.locator('#info-btn').click();
  await p.waitForTimeout(1300);
  const groups = await p.evaluate(() => [...document.querySelectorAll('.dt-gtitle')].map((e) => e.textContent).join(','));
  check(/This week,Routines,Always rules,Memory/.test(groups), `${scheme}: the agent page shows the week, routines, Always rules and memory (${groups})`);
  // ── Vesper 10-30 ──
  // The agent page: each client row carries its logo; the week is seven bars, today in full color.
  const page = await p.evaluate(() => ({
    clients: [...document.querySelectorAll('.dt-client')].map((r) => [r.textContent, !!r.querySelector('.clmark img')]),
    bars: [...document.querySelectorAll('.wk-col')].length,
    today: (() => { const b = document.querySelector('.wk-col.today .wk-bar'); return b ? [getComputedStyle(b).opacity, b.getBoundingClientRect().height, b.getBoundingClientRect().width] : null; })(),
    tip: document.querySelector('.wk-tip')?.textContent || '',
  }));
  check(page.clients.length === 3 && page.clients.every(([, logo]) => logo), `${scheme}: agent page client rows show each client's logo (${page.clients.map(([t]) => t).join(', ')})`);
  check(page.bars === 7 && page.today && page.today[0] === '1' && page.today[1] > 4 && page.today[2] <= 24 && /runs?/.test(page.tip), `${scheme}: the week is seven bars, today full color, 24px wide at most (${page.tip})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/agent-week-${scheme}.png` });
  await p.locator('.dt-back').click();
  await p.waitForTimeout(700);
  // The header: a long thread scrolls under a strong blur, and the capsules frost what is behind them.
  const head = await p.evaluate(() => {
    const f = document.querySelector('.thread-fade');
    const pill = getComputedStyle(document.querySelector('#head-name'));
    const blur = getComputedStyle(f.querySelector('i')).webkitBackdropFilter || getComputedStyle(f.querySelector('i')).backdropFilter;
    return { fadeBottom: f.getBoundingClientRect().bottom, nameBottom: document.querySelector('#head-name').getBoundingClientRect().bottom, pill: pill.webkitBackdropFilter || pill.backdropFilter, blur };
  });
  check(head.fadeBottom >= head.nameBottom + 30 && /blur\(18px\)/.test(head.pill) && /blur\(14px\)/.test(head.blur), `${scheme}: the header blur reaches past the name and the name capsule frosts (fade ends ${Math.round(head.fadeBottom)}, name ends ${Math.round(head.nameBottom)}, ${head.pill})`);
  // A Stripe link in a text: the green bubble shows a short address, the preview card says the amount and where it stands.
  const stripe = await p.evaluate(() => {
    const tk = [...document.querySelectorAll('.tk')].find((t) => /payment link/.test(t.textContent));
    const lp = tk?.querySelector('.tk-sms .lk');
    return { bub: tk?.querySelector('.tk-bub')?.textContent || '', lp: lp?.textContent || '', h: lp?.getBoundingClientRect().height, logo: !!lp?.querySelector('img[src$="stripe.svg"]'), cl: tk?.querySelector('.ap-sub.has-cl .clmark img')?.getAttribute('src') || '' };
  });
  check(/buy\.stripe\.com\/test_cN…/.test(stripe.bub) && !/test_00example0001/.test(stripe.bub) && /\$375 payment link/.test(stripe.lp) && /Not paid yet/.test(stripe.lp) && stripe.logo && stripe.h === 64,
    `${scheme}: a Stripe link reads as a short address plus a preview card (${stripe.lp}, ${stripe.h}px)`);
  check(stripe.cl === 'icons/clients/acme.webp', `${scheme}: the card's sub line starts with the client's logo (${stripe.cl})`);
  // Moods: a bot with a card waiting on Alex is perked up; one doing nothing follows the clock.
  const moods = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.chat-row')].map((r) => [r.dataset.chat, r.querySelector('.av img')?.getAttribute('src') || ''])));
  const hr = new Date().getHours();
  check(/cleo-perk\.webp$/.test(moods['dm-cleo']) && (hr >= 21 || hr < 8 ? /ada-sleep\.webp$/ : /ada\.webp$/).test(moods['dm-ada']),
    `${scheme}: friends show their mood (Cleo ${moods['dm-cleo']?.split('/').pop()}, Ada ${moods['dm-ada']?.split('/').pop()})`);
  // "card #412" in Cleo's words is a chip with the card's app and title; tapping it opens the card.
  await p.goto(`${BASE}/#/chat/dm-cleo`);
  await p.waitForTimeout(900);
  const chip = await p.evaluate(() => { const c = document.querySelector('.cref[data-card="412"]'); return c ? { text: c.textContent, mark: !!c.querySelector('.appmark') } : null; });
  check(chip && chip.mark && /Truck Meet/.test(chip.text) && !/#412/.test(chip.text), `${scheme}: "card #412" becomes a chip with the card's app and title (${chip?.text})`);
  if (chip) {
    await p.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
    await p.waitForTimeout(300);
    await p.locator('.cref[data-card="412"]').last().click();
    await p.waitForTimeout(900);
    const landed = await p.evaluate(() => { const card = [...document.querySelectorAll('.row')].find((r) => /\(#412\)|Truck Meet starts at 5 PM/.test(r.textContent) && r.querySelector('.appr, .tk')); const b = card?.getBoundingClientRect(); return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), flash: card.classList.contains('flash') } : null; });
    check(landed && landed.flash && landed.top < 852 && landed.bottom > 0, `${scheme}: tapping the chip brings the card into view (${JSON.stringify(landed)})`);
  }
  if (scheme === 'light') await p.screenshot({ path: `${out}/chip-${scheme}.png` });
  // A link in a message gets a preview card under its bubble.
  await p.goto(`${BASE}/#/chat/dm-dora`);
  await p.waitForTimeout(900);
  const lp = await p.evaluate(() => { const a = [...document.querySelectorAll('.stack > a.lk')].pop(); return a ? { text: a.textContent, h: a.getBoundingClientRect().height, href: a.getAttribute('href') } : null; });
  check(lp && /Garage door repair in Springfield/.test(lp.text) && lp.h === 64 && lp.href === 'https://fjorddoors.example/garage-door-repair', `${scheme}: a link gets a preview card under its bubble (${lp?.text})`);
  // A card with a picture uses the picture as its icon, the app on the corner.
  // (Into Dora's chat: Ben's row must not end the light run on top, or the dark run's row move has nowhere to go.)
  await inject({ chat_id: 'dm-dora', sender: 'dora', typing_ms: 0, photo: true, text: '**Fjord Garage Doors**: post the Friday reel on Instagram (#93)\n\nPlan:\nPost the reel at 7:30 PM.',
    buttons: [[{ label: 'Approve', data: 'a|93|h', style: 'primary' }, { label: 'Decline', data: 'n|93|h', style: 'danger' }]] });
  await p.goto(`${BASE}/#/chat/dm-dora`);
  await p.waitForTimeout(1000);
  const thumb = await p.evaluate(() => { const c = [...document.querySelectorAll('.appr')].pop(); const t = c?.querySelector('.ap-head .appmark.thumb'); return t ? { img: !!t.querySelector(':scope > img[src^="/files/"]'), mini: t.querySelector('.mini img')?.getAttribute('src') || '' } : null; });
  check(thumb && thumb.img && /instagram\.svg$/.test(thumb.mini), `${scheme}: a card with a picture uses it as its icon with the app on the corner (${JSON.stringify(thumb)})`);
  // Search everything: words find cards and messages; a client chip alone finds that client's cards.
  await p.goto(`${BASE}/#/`);
  await p.waitForTimeout(700);
  await p.locator('#search-input').focus();
  await p.waitForTimeout(300);
  const chipsShown = await p.evaluate(() => !document.querySelector('#search-chips').hidden && document.querySelectorAll('.sr-chip').length);
  await p.locator('#search-input').fill('truck meet');
  await p.waitForTimeout(900);
  const sr = await p.evaluate(() => ({ labels: [...document.querySelectorAll('#search-results .sec-label')].map((e) => e.textContent), card: [...document.querySelectorAll('#search-results .sr-row b')].map((b) => b.textContent).find((t) => /Truck Meet/.test(t)) || '', marked: !!document.querySelector('#search-results mark') }));
  check(chipsShown >= 10 && sr.labels.includes('Cards') && /Truck Meet/.test(sr.card), `${scheme}: search finds cards by their words, with filter chips (${chipsShown} chips; ${sr.labels.join(', ')})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/search-${scheme}.png` });
  await p.locator('#search-input').fill('');
  await p.locator('.sr-chip[data-fclient="acme"]').click();
  await p.waitForTimeout(900);
  const acme = await p.evaluate(() => ({ titles: [...document.querySelectorAll('#search-results .sr-row b')].map((b) => b.textContent), rows: [...document.querySelectorAll('#rows .chat-row')].map((r) => r.dataset.chat) }));
  check(acme.titles.some((t) => /payment link/.test(t)) && acme.rows.join() === 'dm-ben', `${scheme}: the Acme chip shows Acme's cards and only Ben's chat (${acme.titles.slice(0, 2).join(' | ')}; ${acme.rows.join()})`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/search-acme-${scheme}.png` });
  await p.locator('.sr-chip[data-fclient="acme"]').click();
  await p.locator('#search-input').blur();
  await p.waitForTimeout(500);
  check(await p.evaluate(() => document.querySelector('#search-chips').hidden && document.querySelector('#search-results').hidden && !!document.querySelector('#runs-row-wrap:not([hidden])')), `${scheme}: clearing the search puts the home screen back`);
  // Runs: today as a strip, one lane per bot with its friend, ticks for runs, a line for now.
  await p.goto(`${BASE}/#/runs`);
  await p.waitForTimeout(1000);
  const ds = await p.evaluate(() => ({ lanes: document.querySelectorAll('.ds-lane').length, faces: document.querySelectorAll('.ds-lane .av img').length, ticks: document.querySelectorAll('.ds-tick').length, axis: [...document.querySelectorAll('.ds-axis span')].map((s) => s.textContent).join(' '), now: !!document.querySelector('.ds-now') }));
  check(ds.lanes === 5 && ds.faces === 5 && ds.ticks > 0 && ds.axis === '12 AM 6 AM 12 PM 6 PM 12 AM' && ds.now, `${scheme}: Runs opens with today as a strip, one lane per bot (${ds.ticks} ticks)`);
  if (ds.ticks) {
    await p.locator('.ds-tick').first().click();
    const tip = await p.evaluate(() => document.querySelector('.ds-tip').textContent);
    check(/ · \d{1,2}:\d{2} [AP]M/.test(tip), `${scheme}: tapping a tick says what ran and when (${tip})`);
  }
  if (scheme === 'light') await p.screenshot({ path: `${out}/runs-strip-${scheme}.png` });
  await p.goto(`${BASE}/#/`);
  await p.waitForTimeout(500);
  await p.evaluate(() => document.querySelector('.dt-back')?.click());
  await p.waitForTimeout(500);

  check(errs.length === 0, `${scheme}: no console errors${errs.length ? `: ${errs.join(' | ')}` : ''}`);
  await ctx.close();
}
await browser.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
