// One decision per outcome (11-11), in WebKit at iPhone 15 Pro size against the mock server: a said-so card (his
// own words quoted, Send now and Stop), a said-so card his word does not cover (one line why), a card changed in
// place (one "Updated" line), and the quiet grouped notice for a recording's prep. Card texts are what
// agent-team approvals/service.py card_text writes (pass them in a JSON file, or the built-in copies are used).
//
//   node tools/mock-server.mjs --port 8794 &
//   node tools/onedecision-shots.mjs <out-dir> [cards.json]
import { readFileSync } from 'node:fs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= `${process.env.HOME}/.vesper/test-browsers`;
const { webkit } = await import(process.env.VESPER_PLAYWRIGHT || 'playwright-core');

const out = process.argv[2] || 'tmp/onedecision-shots';
const BASE = process.env.HOLLER_BASE || 'http://127.0.0.1:8794';
const CARDS = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {
  said: '**Acme Pressure Washing**: confirm 11 tomorrow (#1)\n\nYou said, 11:42 AM: “Yeah, text that 11 works”\n\nReplying to Pat, 11:20 AM: “Does 11 work tomorrow for the house wash?”\n\nText to Pat (ends 0101):\n"Hey Pat, 11 tomorrow works. See you then."\n\nSending in 2 min unless Alex taps Stop.',
  held: '**Gale (Gale Capital)**: Friday walkthrough (#2)\n\nYou said, 11:44 AM: “Tell Gale Friday at 10 is good”\n\nStill needs your slide: Gale is tap only.\n\nText to Gale (ends 0114):\n"Gale, Friday at 10 works for the walkthrough."',
  updated: '**Acme Pressure Washing**: pay the overdue Meta bill (#3)\n\nUpdated 2:14 PM: the bill is now $430, up from $412\n\nWhy: Meta says the Acme ad account bill is overdue and the ads stop Friday if it is not paid.\n\nIf you slide: Ben pays the $430 bill with the card on file. The ads keep running at the same budget.\n\nCost: $430 once\n\nDetails:\nPay the overdue Meta ad account bill with the card on file.',
  notice: "From your recording today (Meeting with Pat): I'm getting these ready:\n1. Draft the gutter flyer text\n2. Find Robin's email for the Birch site\n3. Follow up with Kay on the photos\n\nNothing goes out until you OK the finished thing. Reply to drop one.",
};
// The shots read like a weekday late morning, whatever the clock says when they are taken.
const fix = (s) => s.replace(/You said, [^:]+:\d\d [AP]M/, 'You said, 11:42 AM').replace(/Replying to Pat, [^:]+:\d\d [AP]M/, 'Replying to Pat, 11:20 AM')
  .replace(/Updated [^:]+:\d\d [AP]M/, 'Updated 2:14 PM');

const browser = await webkit.launch();
const results = [];
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const SAFE = ':root { --sat: 59px !important; --sab: 34px !important; }';
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const inject = (chat_id, sender, text, buttons = null) => post('/mock/inject', { chat_id, sender, text, buttons, typing_ms: 0 });
const grace = (id) => [[{ label: 'Send now', data: `g|${id}|h`, style: 'primary' }, { label: 'Stop', data: `s|${id}|h`, style: 'danger' }]];
const slide = (id) => [[{ label: 'Approve', data: `a|${id}|h`, style: 'primary' }, { label: 'Decline', data: `n|${id}|h`, style: 'danger' }]];

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
  const n = scheme === 'light' ? 0 : 10;

  // 1. Said-so: his message in Eli's thread, then the card that goes on his word.
  await p.goto(`${BASE}/#/chat/dm-eli`);
  await p.waitForTimeout(1000);
  await inject('dm-eli', 'eli', 'Pat asked if 11 tomorrow works for the house wash. Want me to tell him yes?');
  await p.waitForTimeout(300);
  await p.evaluate(() => { const c = document.querySelector('#input'); if (c) c.focus(); });
  await p.keyboard.type('Yeah, text that 11 works');
  await p.evaluate(() => document.querySelector('#send-btn').click());
  await p.waitForTimeout(700);
  await inject('dm-eli', 'eli', fix(CARDS.said).replace('(#1)', `(#${71 + n})`), grace(71 + n));
  await p.waitForTimeout(900);
  const said = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.appr')].at(-1);
    return { said: c?.querySelector('.pc-said .heard-q')?.textContent, by: c?.querySelector('.pc-said .heard-w')?.textContent,
      ans: c?.querySelector('.pc-ans .heard-q')?.textContent, hint: c?.querySelector('.appr-hint')?.textContent, sends: c?.querySelector('.pc-sends')?.textContent,
      stop: [...(c?.querySelectorAll('.card-quiet') || [])].map((b) => b.textContent).join('|') };
  });
  check(said.said === '“Yeah, text that 11 works”' && said.by === 'You said · 11:42 AM' && /Does 11 work/.test(said.ans || '')
    && said.hint === 'slide to send now' && said.stop === 'Stop' && said.sends === 'Sends in 2 min unless you tap Stop', `${scheme}: said-so card quotes him and keeps Send now and Stop (${JSON.stringify(said)})`);
  await p.screenshot({ path: `${out}/${scheme}-1-said-so.png` });

  // 2. Said-so that his word does not cover (tap-only client): one plain line why.
  await p.goto(`${BASE}/#/chat/dm-ada`);
  await p.waitForTimeout(900);
  await inject('dm-ada', 'ada', fix(CARDS.held).replace('(#2)', `(#${72 + n})`), slide(72 + n));
  await p.waitForTimeout(900);
  const held = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.appr')].at(-1);
    return { held: c?.querySelector('.pc-held')?.textContent, said: c?.querySelector('.pc-said .heard-q')?.textContent };
  });
  check(held.held === 'Still needs your slide: Gale is tap only.' && /Friday at 10/.test(held.said || ''), `${scheme}: fallback says why in one line (${JSON.stringify(held)})`);
  await p.screenshot({ path: `${out}/${scheme}-2-said-but-held.png` });

  // 3. A card changed in place: one Updated line under the title.
  await p.goto(`${BASE}/#/chat/dm-ben`);
  await p.waitForTimeout(900);
  await inject('dm-ben', 'ben', fix(CARDS.updated).replace('(#3)', `(#${73 + n})`), slide(73 + n));
  await p.waitForTimeout(900);
  const upd = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.appr')].at(-1);
    return { k: c?.querySelector('.pc-upd-k')?.textContent, v: c?.querySelector('.pc-upd-v')?.textContent, cost: [...(c?.querySelectorAll('.pc-row') || [])].map((r) => r.textContent).join('|') };
  });
  check(upd.k === 'Updated 2:14 PM' && upd.v === 'the bill is now $430, up from $412' && /Cost\$430 once/.test(upd.cost), `${scheme}: updated card reads right (${JSON.stringify(upd)})`);
  await p.screenshot({ path: `${out}/${scheme}-3-updated.png` });

  // 4. The quiet grouped notice for a recording's prep (no buttons, no card).
  await inject('dm-ben', 'ben', CARDS.notice);
  await p.waitForTimeout(900);
  const note = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.bubble.in')].at(-1);
    return { text: b?.textContent || '', items: b?.querySelectorAll('li').length || 0, card: !!b?.closest('.row')?.querySelector('.appr') };
  });
  check(/^From your recording today \(Meeting with Pat\): I'm getting these ready:/.test(note.text) && note.items === 3 && !note.card,
    `${scheme}: grouped notice is one quiet message with three items (${JSON.stringify({ items: note.items, card: note.card })})`);
  await p.screenshot({ path: `${out}/${scheme}-4-recording-notice.png` });

  // 5. The Approvals screen shows the same cards the same way.
  if (scheme === 'light') {
    await p.goto(`${BASE}/#/approvals`);
    await p.waitForTimeout(1200);
    await p.screenshot({ path: `${out}/light-5-approvals-screen.png` });
  }
  check(!errs.length, `${scheme}: no page errors (${errs.join(' | ')})`);
  await ctx.close();
}

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
