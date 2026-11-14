// Who a message wakes. Every bot in the chat (except the sender) receives every message; only the
// addressed ones get a model turn. See docs/design.md, "Who answers".

import { BOTS, DEFAULT_RESPONDER, member } from './team.mjs';

export const BOT_CHAIN_CAP = 4;
// The owner's room rules (Vesper 10-31): bot-to-bot on or off, how many bot turns in a row before the room waits
// for him, and bots muted in the room (they still read it; only his naming them wakes them).
export const DEFAULT_RULES = { botToBot: true, chainCap: BOT_CHAIN_CAP, muted: [] };
export const CHAIN_CHOICES = [2, 4, 6, 8];
export function cleanRules(r = {}) {
  const ids = new Set(BOTS.map((b) => b.id));
  return {
    botToBot: r.botToBot === undefined ? DEFAULT_RULES.botToBot : !!r.botToBot,
    chainCap: CHAIN_CHOICES.includes(Number(r.chainCap)) ? Number(r.chainCap) : DEFAULT_RULES.chainCap,
    muted: [...new Set((Array.isArray(r.muted) ? r.muted : []).map(String).filter((id) => ids.has(id)))],
  };
}

const LEAD_INS = new Set(['hey', 'hi', 'yo', 'ok', 'okay', 'and', 'so', 'also']);
const botByName = new Map(BOTS.map((b) => [b.name.toLowerCase(), b.id]));

function word(raw) {
  return String(raw || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9'-]+$/u, '').replace(/[,.:;!?]+$/, '');
}

// Bots named in the text: "@ben" anywhere, or the first word ("Ben, can you..."; also after a lead-in
// like "hey"). "@all" means every bot.
export function namedBots(text) {
  const out = new Set();
  let all = false;
  for (const m of String(text || '').matchAll(/(^|[^\w@])@([A-Za-z][\w-]*)/g)) {
    const name = m[2].toLowerCase();
    if (name === 'all' || name === 'everyone' || name === 'team') all = true;
    else if (botByName.has(name)) out.add(botByName.get(name));
  }
  const words = String(text || '').trim().split(/\s+/).slice(0, 2).map(word);
  const first = LEAD_INS.has(words[0]) ? words[1] : words[0];
  if (first && botByName.has(first)) out.add(botByName.get(first));
  return { bots: out, all };
}

// chat: {kind, members[]}; sender: member id; replyToSender: author of the quoted message or null;
// botWakesSinceHuman: bot-authored messages since the human last spoke here that woke someone.
export function route({ chat, sender, text, replyToSender = null, botWakesSinceHuman = 0, rules = DEFAULT_RULES }) {
  const bots = chat.members.filter((id) => member(id)?.kind === 'bot' && id !== sender);
  const addressed = new Set();
  const fromBot = member(sender)?.kind === 'bot';

  if (chat.kind === 'dm') {
    if (!fromBot) bots.forEach((id) => addressed.add(id));
    return { recipients: bots, addressed };
  }

  const r = cleanRules(rules);
  if (fromBot && (!r.botToBot || botWakesSinceHuman >= r.chainCap)) return { recipients: bots, addressed };

  const muted = new Set(r.muted);
  const { bots: named, all } = namedBots(text);
  if (all && !fromBot) bots.forEach((id) => { if (!muted.has(id)) addressed.add(id); });
  // A muted bot wakes only when the owner names it.
  for (const id of named) if (bots.includes(id) && (!muted.has(id) || !fromBot)) addressed.add(id);
  if (replyToSender && bots.includes(replyToSender) && !muted.has(replyToSender)) addressed.add(replyToSender);
  if (!fromBot && addressed.size === 0 && bots.includes(DEFAULT_RESPONDER) && !muted.has(DEFAULT_RESPONDER)) addressed.add(DEFAULT_RESPONDER);
  return { recipients: bots, addressed };
}
