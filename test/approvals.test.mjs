// Approvals view helpers that run without a browser: the age label and which cards are waiting.
import './fixtures/web-team.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtAge, fmtSeparator } from '../web/js/util.js';
import { state } from '../web/js/store.js';
import { waitingCards } from '../web/js/list.js';

test('card age reads like a phone: minutes, hours today, then day and time', () => {
  const now = new Date(2026, 9, 29, 16, 0).getTime(); // Thu Oct 29, 4:00 PM local
  assert.equal(fmtAge(now - 20 * 1000, now), 'Now');
  assert.equal(fmtAge(now - 12 * 60000, now), '12 min');
  assert.equal(fmtAge(now - 59 * 60000, now), '59 min');
  assert.equal(fmtAge(now - 3 * 3600000 - 5 * 60000, now), '3 h');
  const yesterday = new Date(2026, 9, 28, 16, 40).getTime();
  const s = fmtSeparator(yesterday, now);
  assert.equal(s.day, 'Yesterday');
  assert.equal(fmtAge(yesterday, now), `Yesterday ${s.time}`);
  // Twenty minutes ago across midnight still reads in minutes.
  const midnight = new Date(2026, 9, 29, 0, 10).getTime();
  assert.equal(fmtAge(midnight - 20 * 60000, midnight), '20 min');
  assert.equal(fmtAge(0, now), '');
});

test('waiting cards come from every loaded thread, newest first (11-11), and skip answered or withdrawn ones', () => {
  state.me = { id: 'alex' };
  state.chats = new Map([['room', { id: 'room', kind: 'room' }], ['dm-ben', { id: 'dm-ben', kind: 'dm' }], ['dm-dora', { id: 'dm-dora', kind: 'dm' }]]);
  const btn = [[{ label: 'Approve', data: 'a', style: 'primary' }]];
  const msg = (id, chat_id, sender, at, extra = {}) => ({ id, chat_id, sender, at, text: `#${id}`, buttons: btn, resolved: null, ...extra });
  state.threads = new Map([
    ['dm-ben', { loaded: true, messages: [msg(1, 'dm-ben', 'ben', 300), msg(2, 'dm-ben', 'ben', 100, { resolved: { label: 'Approve' } })] }],
    ['room', { loaded: true, messages: [msg(3, 'room', 'ada', 200), msg(4, 'room', 'alex', 50), msg(5, 'room', 'cleo', 400, { buttons: null })] }],
    ['dm-dora', { loaded: false, messages: [msg(6, 'dm-dora', 'dora', 10)] }],
    ['dm-gone', { loaded: true, messages: [msg(7, 'dm-gone', 'eli', 5)] }],
  ]);
  assert.deepEqual(waitingCards().map((m) => m.id), [1, 3]);
});

test('the plain card comes out of the text; the rest reads as before (11-11)', async () => {
  const { plainOf, readTask, readCard } = await import('../web/js/marks.js');
  const text = `**Acme Pressure Washing**: get the gutter ads ready, paused (#901)

Why: Pat asked Alex in today's meeting to push gutters through Thanksgiving.

If you slide: Claude builds two gutter ads in Meta, paused.

Cost: No cost now.

Prepared by Claude.

Details:
Ad 1.`;
  const m = { id: 9, text, buttons: [[{ label: 'Approve', data: 'a|9|h', style: 'primary' }]] };
  const t = readTask(m);
  assert.deepEqual(t.plain, { why: 'Pat asked you in today\'s meeting to push gutters through Thanksgiving.', slide: 'Claude builds two gutter ads in Meta, paused.', cost: 'No cost now.', claude: true });
  assert.deepEqual(t.content, { type: 'note', body: t.plain.why });
  assert.equal(t.more, true, 'Details holds the plan');
  assert.equal(readCard(m).plain.claude, true);
  const reply = readTask({ id: 10, text: `**Acme Pressure Washing**: weekly budget (#902)

Replying to Pat, 2:51 PM: \u201cHow much a week?\u201d

Text to Pat Barlow (ends 0100):
"About $140 a week."

Your slide also puts it on your calendar: Thu Nov 12, 11:00 to 11:30 AM`, buttons: [] });
  assert.deepEqual(reply.content, { type: 'sms', body: 'About $140 a week.' });
  assert.deepEqual(reply.plain.answers, { who: 'Pat', when: '2:51 PM', quote: 'How much a week?' });
  assert.equal(reply.plain.calendar, 'Thu Nov 12, 11:00 to 11:30 AM');
  assert.deepEqual(plainOf('Just a plan.\n\nDetails:\nx'), { plain: null, rest: 'Just a plan.\n\nDetails:\nx' });
});

test('one decision per outcome: his words, a changed card, why it still needs a slide, the contact it adds (11-11)', async () => {
  const { readCard, readTask } = await import('../web/js/marks.js');
  const said = { id: 31, text: `**Acme Pressure Washing**: confirm 11 tomorrow (#931)

You said, 11:42 AM: \u201cYeah, text that 11 works\u201d

Replying to Pat, 11:20 AM: \u201cDoes 11 work tomorrow?\u201d

Text to Pat (ends 0101):
"Hey Pat, 11 works. See you then."

Sending in 2 min unless Alex taps Stop.`, buttons: [[{ label: 'Send now', data: 'g|931|h', style: 'primary' }, { label: 'Stop', data: 's|931|h', style: 'danger' }]] };
  const c = readCard(said);
  assert.deepEqual(c.plain.said, { when: '11:42 AM', quote: 'Yeah, text that 11 works' });
  assert.equal(c.app, 'sms');
  assert.equal(c.title, 'Confirm 11 tomorrow');
  assert.deepEqual(c.content, { type: 'sms', body: 'Hey Pat, 11 works. See you then.' });
  assert.equal(c.sends, 'Sends in 2 min unless you tap Stop');
  const upd = readCard({ id: 32, text: `**Acme Pressure Washing**: overdue Meta bill $430 (#932)

Updated 2:14 PM: the bill is now $430

Why: Meta says the Acme ad account bill is overdue and ads stop Friday.

If you slide: Ben pays the $430 Meta bill with the card on file.

Cost: $430 once`, buttons: [[{ label: 'Approve', data: 'a|932|h2', style: 'primary' }]] });
  assert.deepEqual(upd.plain.updated, { when: '2:14 PM', note: 'the bill is now $430' });
  assert.equal(upd.plain.cost, '$430 once');
  const held = readCard({ id: 33, text: `**Gale (Gale Capital)**: confirm Friday (#933)

You said, Tue 4:10 PM: \u201cTell Gale Friday is good\u201d

Still needs your slide: Gale is tap only.

Also adds Robin Smith to Birch Mechanical's HQ contacts (they wrote to you first).

Text to Gale (ends 0114):
"Friday is good."`, buttons: [[{ label: 'Approve', data: 'a|933|h', style: 'primary' }]] });
  assert.equal(held.plain.held, 'Gale is tap only');
  assert.equal(held.plain.said.when, 'Tue 4:10 PM');
  assert.equal(held.plain.contact, 'Robin Smith to Birch Mechanical');
  const sent = readTask({ id: 34, text: said.text.replace('Sending in 2 min unless Alex taps Stop.', 'Sent. Texted Pat at 11:44 AM, delivered.'), buttons: null });
  assert.equal(sent.status.label, 'Sent');
  assert.equal(sent.plain.said.quote, 'Yeah, text that 11 works');
});
