// 11-11: the app's side of home by client and the grouped Approvals screen, without a browser: which client a card
// belongs to, which cards one group slide may sweep, the sweep itself (a failing press does not stop the rest), and
// the rows on home.
import './fixtures/web-team.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../web/js/store.js';
import { keyOf, sweepable, groupCards, sweep, clientRows, setBoard, needsFor, stopsFor, isStopCard } from '../web/js/clients.js';

const approve = (id) => [[{ label: 'Approve', data: `a|${id}|h`, style: 'primary' }, { label: 'Decline', data: `n|${id}|h`, style: 'danger' }]];
const card = (id, at, head, extra = {}) => ({ id, chat_id: 'dm-ben', sender: 'ben', at, text: `${head} (#${id})\n\nWhy: it is time.`, buttons: approve(id), resolved: null, ...extra });

function seed(messages) {
  state.me = { id: 'alex' };
  state.chats = new Map([['dm-ben', { id: 'dm-ben', kind: 'dm' }], ['dm-eli', { id: 'dm-eli', kind: 'dm' }]]);
  state.threads = new Map([['dm-ben', { loaded: true, messages }]]);
}

test('a card belongs to the client its head names; leads are one client; the server’s reading wins', () => {
  setBoard({ clients: [], map: { 9: 'fjord' } });
  assert.equal(keyOf(card(1, 1, '**Acme Pressure Washing**: keep the ads')), 'acme');
  assert.equal(keyOf(card(2, 1, 'Doing: **Dune Dune**: post the flyer')), 'dune');
  assert.equal(keyOf(card(3, 1, '**Lead: Northside Mobile Welding**: text back')), 'leads');
  assert.equal(keyOf(card(4, 1, 'Approval needed: run `ls`')), null);
  assert.equal(keyOf(card(9, 1, '**Team**: a card the outbox says is Fjord’s')), 'fjord');
  assert.equal(keyOf({ id: 5, kind: 'work', work: { client: 'Ember', title: 'x', state: 'working' } }), 'ember');
});

test('only plain approve sliders go into a group slide', () => {
  assert.equal(sweepable(card(1, 1, '**Acme**: plain')), true);
  assert.equal(sweepable(card(2, 1, '**Acme**: answered', { resolved: { label: 'Approve' } })), false);
  assert.equal(sweepable(card(3, 1, '**Acme**: stop', { buttons: [[{ label: 'Stop', data: 's|3|h', style: 'danger' }]] })), false, 'a send in its Stop window');
  assert.equal(sweepable(card(4, 1, '**Acme**: link', { buttons: [[{ label: 'Open Meta', url: 'https://business.facebook.com/' }], [{ label: 'Done', data: 'a|4|h', style: 'primary' }]] })), false, 'Needs a human');
  assert.equal(sweepable(card(5, 1, '**Acme**: code', { text: '**Acme**: code (#5)\n\nSealed: Google sign-in code' })), false, 'a sealed field');
  assert.equal(sweepable(card(6, 1, 'Hermes wants to run a command', { buttons: [[{ label: 'Approve once', data: 'ea:6:once', style: 'primary' }]] })), false, 'a command Hermes wants to run');
  assert.equal(sweepable(card(7, 1, '**Acme**: choose', { buttons: [[{ label: 'Tuesday', data: 'cl:7:1' }, { label: 'Friday', data: 'cl:7:2' }]] })), false, 'a choice list');
  assert.equal(isStopCard(card(3, 1, 'x', { buttons: [[{ label: 'Stop', data: 's|3|h' }]] })), true);
});

test('Approvals groups cards by client, the group with the newest card first, Other last', () => {
  setBoard({ clients: [], map: {} });
  seed([
    card(11, 100, '**Acme Pressure Washing**: one'), card(12, 300, '**Acme Pressure Washing**: two'),
    card(13, 200, '**Fjord Garage Doors**: three'), card(14, 400, 'Approval needed: run `ls`'),
    card(15, 50, '**Cedar Boutique**: text Lee', { buttons: [[{ label: 'Stop', data: 's|15|h', style: 'danger' }]] }),
  ]);
  const groups = groupCards();
  assert.deepEqual(groups.map((g) => [g.key, g.cards.map((m) => m.id)]), [['acme', [12, 11]], ['fjord', [13]], ['cedar', [15]], ['', [14]]]);
  assert.equal(groups.at(-1).name, 'Other');
  assert.equal(groups[0].name, 'Acme Pressure Washing');
  assert.deepEqual(needsFor('cedar').map((m) => m.id), [], 'a Stop card is not Needs you');
  assert.deepEqual(stopsFor('cedar').map((m) => m.id), [15]);
});

test('one group slide presses each card in order; a failing press does not stop the rest', async () => {
  const cards = [card(21, 1, '**Acme**: a'), card(22, 1, '**Acme**: b'), card(23, 1, '**Acme**: c'), card(24, 1, '**Acme**: d')];
  const pressed = [];
  const steps = [];
  const out = await sweep(cards, async (m) => {
    pressed.push(m.id);
    if (m.id === 22) return false; // the server refused it (the card changed under him)
    if (m.id === 23) throw new Error('network');
    return true;
  }, (i, n) => steps.push(`${i + 1}/${n}`));
  assert.deepEqual(pressed, [21, 22, 23, 24], 'every card got its own press, in order');
  assert.deepEqual(out, { done: [21, 24], failed: [22, 23] });
  assert.deepEqual(steps, ['1/4', '2/4', '3/4', '4/4']);
});

test('home rows: the count comes from the threads, the line from the server; quiet clients do not show', () => {
  seed([card(31, 100, '**Acme Pressure Washing**: one'), card(32, 200, '**Acme Pressure Washing**: two'), card(33, 300, '**Lead: Pat**: call back')]);
  setBoard({ clients: [
    { key: 'fjord', name: 'Fjord Garage Doors', short: 'Fjord', owner: 'dora', need: [], line: null, done_line: '3 done today' },
    { key: 'acme', name: 'Acme Pressure Washing', short: 'Acme', owner: 'ben', need: [31, 32], line: 'Claude working on the cheat sheet', done_line: null },
    { key: 'leads', name: 'Leads', short: 'Leads', owner: 'eli', need: [33], line: null, done_line: null },
    { key: 'dune', name: 'Dune Eats', short: 'Dune', owner: 'cleo', need: [99], line: null, done_line: null },
  ], map: {} });
  const rows = clientRows();
  assert.deepEqual(rows.map((r) => [r.key, r.need, r.line]), [
    ['acme', 2, '2 need you · Claude working on the cheat sheet'],
    ['leads', 1, '1 needs you'],
    ['fjord', 0, '3 done today'],
  ], 'Dune lists a card the threads do not have and nothing else, so it stays off');
  setBoard({ clients: [], map: {} });
  assert.deepEqual(clientRows(), []);
});
