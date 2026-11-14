// The team: you, your bots and (optionally) the clients or projects your bots work on. Read once at start from
// team.json: $VESPER_TEAM, else ~/.config/vesper/team.json, else config/team.example.json in this repo.
// Each bot maps one to one onto a Hermes profile (`profile`, defaults to the bot's id). Restart after edits.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const TEAM_PATH = process.env.VESPER_TEAM
  || [join(homedir(), '.config', 'vesper', 'team.json'), join(ROOT, 'config', 'team.example.json')].find((p) => existsSync(p));

const ID = /^[a-z]{1,20}$/; // bot ids appear in routes (/api/agents/<id>) and chat ids (dm-<id>)
const PALETTE = ['#7C6CF0', '#3B9CFF', '#FF8F70', '#4CD07D', '#FFB443', '#E86BB8', '#3CC6C6', '#8E8E93'];
const GLYPH_CYCLE = ['compass', 'mega', 'cal', 'bars', 'radar', 'spark', 'globe', 'term'];

function load(path) {
  if (!path) throw new Error('No team.json found. Copy config/team.example.json to ~/.config/vesper/team.json.');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const you = raw.you || {};
  const human = {
    id: String(you.id || 'me'), name: String(you.name || 'Me'), kind: 'human', role: '', clients: '',
    colors: you.colors || ['#3A8DFF', '#0A60FF'], initials: you.initials || String(you.name || 'Me').slice(0, 2).toUpperCase(),
  };
  if (!ID.test(human.id)) throw new Error(`team.json: you.id "${human.id}" must be 1-20 lowercase letters`);
  const bots = (raw.bots || []).map((b, i) => {
    const id = String(b.id || '');
    if (!ID.test(id)) throw new Error(`team.json: bot id "${id}" must be 1-20 lowercase letters`);
    const color = b.color || PALETTE[i % PALETTE.length];
    return {
      id, name: String(b.name || id), kind: 'bot', profile: String(b.profile || id), role: String(b.role || ''),
      clients: Array.isArray(b.clients) ? b.clients.join(', ') : String(b.clients || ''),
      colors: b.colors || [color, color], initials: b.initials || String(b.name || id).slice(0, 1).toUpperCase(),
      color, glyph: b.glyph || GLYPH_CYCLE[i % GLYPH_CYCLE.length], avatar: b.avatar || null,
    };
  });
  if (!bots.length) throw new Error('team.json: add at least one bot');
  const ids = new Set([human.id]);
  for (const b of bots) { if (ids.has(b.id)) throw new Error(`team.json: duplicate id "${b.id}"`); ids.add(b.id); }
  const lead = raw.defaultResponder && ids.has(raw.defaultResponder) ? raw.defaultResponder : bots[0].id;
  // Clients (optional): group waiting cards and work by client on home. `match` is a case-insensitive regex
  // tried against card titles and work names; `logo` is a file name in web/icons/clients (without .webp).
  const clients = (raw.clients || []).map((c) => ({
    key: String(c.key), short: String(c.short || c.name || c.key), name: String(c.name || c.short || c.key),
    bot: c.bot && ids.has(c.bot) ? c.bot : lead, match: String(c.match || `\\b${String(c.short || c.name || c.key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    logo: c.logo || null, initial: c.initial || String(c.short || c.name || c.key).slice(0, 1).toUpperCase(),
  }));
  const room = raw.room || {};
  return {
    human, bots, lead, clients,
    roomTitle: String(room.title || 'Team'),
    roomFaces: (room.faces || bots.slice(0, 3).map((b) => b.id)).filter((id) => bots.some((b) => b.id === id)),
    timezone: raw.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    quietHours: Array.isArray(raw.quietHours) && raw.quietHours.length === 2 ? raw.quietHours.map(Number) : [21, 8],
  };
}

const T = load(TEAM_PATH);

export const HUMAN = T.human.id;
export const MEMBERS = [T.human, ...T.bots];
export const BOTS = T.bots;
export const DEFAULT_RESPONDER = T.lead;
export const CLIENTS = T.clients;
export const TZ = T.timezone;
export const QUIET_HOURS = T.quietHours; // [from, to] in TZ, e.g. 9 PM to 8 AM: no reminders, sleepy faces
export const ROOM = 'room';
export const ROOM_TITLE = T.roomTitle;

export const CHATS = [
  { id: ROOM, kind: 'room', title: T.roomTitle, sort: 0, members: MEMBERS.map((m) => m.id) },
  ...BOTS.map((b, i) => ({ id: `dm-${b.id}`, kind: 'dm', title: b.name, sort: i + 1, members: [HUMAN, b.id] })),
];

// What the web app needs to draw the team (sent with /api/bootstrap).
export const TEAM_VIEW = {
  room: { title: T.roomTitle, faces: T.roomFaces },
  clients: T.clients.map(({ key, short, name, bot, match, logo, initial }) => ({ key, short, name, bot, match, logo, initial })),
  quietHours: T.quietHours,
  timezone: T.timezone,
};

export const member = (id) => MEMBERS.find((m) => m.id === id) || null;
export const botByProfile = (profile) => BOTS.find((b) => b.profile === profile) || null;
