import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, namedBots, BOT_CHAIN_CAP } from '../server/routing.mjs';
import { CHATS } from '../server/team.mjs';

const room = CHATS.find((c) => c.id === 'room');
const dmSam = CHATS.find((c) => c.id === 'dm-ben');
const woke = (r) => [...r.addressed].sort();

test('DM from Alex wakes that bot only', () => {
  const r = route({ chat: dmSam, sender: 'alex', text: 'hi' });
  assert.deepEqual(r.recipients, ['ben']);
  assert.deepEqual(woke(r), ['ben']);
});

test('bot message in a DM wakes nobody', () => {
  assert.deepEqual(woke(route({ chat: dmSam, sender: 'ben', text: 'done' })), []);
});

test('room: unaddressed message goes to Ada, everyone else gets it as context', () => {
  const r = route({ chat: room, sender: 'alex', text: 'what is on today?' });
  assert.deepEqual(woke(r), ['ada']);
  assert.equal(r.recipients.length, 5);
});

test('room: first word or @mention addresses a bot', () => {
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'Ben, check Acme' })), ['ben']);
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'hey dora: Fjord spend?' })), ['dora']);
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'can @cleo and @Eli look' })), ['cleo', 'eli']);
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'Samuel said hi' })), ['ada']);
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'email ben@example.com' })), ['ada']);
});

test('room: @all wakes every bot, but not when a bot says it', () => {
  assert.equal(route({ chat: room, sender: 'alex', text: '@all status please' }).addressed.size, 5);
  assert.equal(route({ chat: room, sender: 'ada', text: '@all heads up' }).addressed.size, 0);
});

test('room: replying to a bot addresses it', () => {
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'yes do it', replyToSender: 'eli' })), ['eli']);
});

test('room: bots wake only who they name, never themselves, and the chain stops at the cap', () => {
  assert.deepEqual(woke(route({ chat: room, sender: 'ada', text: 'thanks all' })), []);
  assert.deepEqual(woke(route({ chat: room, sender: 'ada', text: '@ben can you check Acme leads? @ada' })), ['ben']);
  assert.deepEqual(woke(route({ chat: room, sender: 'ada', text: '@ben again', botWakesSinceHuman: BOT_CHAIN_CAP })), []);
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: '@ben go', botWakesSinceHuman: 99 })), ['ben']);
});

test('namedBots ignores unknown names', () => {
  assert.equal(namedBots('@bob hi').bots.size, 0);
});

test('room rules: bot-to-bot off, a shorter turn budget, and muted bots', async () => {
  const { cleanRules } = await import('../server/routing.mjs');
  // Bot-to-bot off: a bot naming another bot wakes nobody; Alex still wakes whoever he names.
  assert.deepEqual(woke(route({ chat: room, sender: 'ben', text: '@dora can you check Fjord', rules: { botToBot: false } })), []);
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: '@dora check Fjord', rules: { botToBot: false } })), ['dora']);
  // Turn budget 2: the third bot turn in a row waits for Alex.
  assert.deepEqual(woke(route({ chat: room, sender: 'ben', text: '@dora ok', botWakesSinceHuman: 2, rules: { chainCap: 2 } })), []);
  assert.deepEqual(woke(route({ chat: room, sender: 'ben', text: '@dora ok', botWakesSinceHuman: 1, rules: { chainCap: 2 } })), ['dora']);
  // Muted: Ada muted means an unaddressed message wakes nobody; @all skips her; Alex naming her wakes her.
  const muted = { muted: ['ada'] };
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'morning all', rules: muted })), []);
  assert.ok(!woke(route({ chat: room, sender: 'alex', text: '@all status', rules: muted })).includes('ada'));
  assert.deepEqual(woke(route({ chat: room, sender: 'alex', text: 'Ada, status?', rules: muted })), ['ada']);
  assert.deepEqual(woke(route({ chat: room, sender: 'ben', text: '@ada look', rules: muted })), []);
  // Bad input falls back to the defaults.
  assert.deepEqual(cleanRules({ chainCap: 99, muted: ['nobody', 'ben', 'ben'], botToBot: 0 }), { botToBot: false, chainCap: BOT_CHAIN_CAP, muted: ['ben'] });
});
