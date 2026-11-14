// Agent marks: a bot with an `avatar` in team.json is its glass friend, a 3D-rendered character on a glass tile in
// the bot's color (icons/agents); without one it shows its line glyph. People get initials on a gray disc; the
// room is up to three small friends together. A working agent gets a thin spectral ring (CSS .av.working).
// Each friend has a mood: busy while it works, perked up while one of its cards waits on you, asleep in the
// team's quiet hours (team.json quietHours, default 9 PM to 8 AM), otherwise its usual face.
import { h } from './util.js';
import { member, state, typers } from './store.js';
import { GLYPHS, glyphFor, friendFor, friendSrc, MOODS, BOTS_ORDER, TEAM } from './marks.js';

export function moodOf(id, now = new Date()) {
  if (member(id)?.kind !== 'bot') return '';
  for (const chat of state.chats.values()) if (typers(chat.id).some((t) => t.id === id)) return 'busy';
  for (const t of state.threads.values()) {
    if (t.messages.some((m) => m.sender === id && m.buttons?.length && !m.resolved)) return 'perk';
  }
  const hr = now.getHours();
  const [from, to] = TEAM.quietHours;
  return (from > to ? hr >= from || hr < to : hr >= from && hr < to) ? 'sleep' : '';
}

// Every friend on screen takes its current mood; only the ones whose mood changed are touched.
export function refreshMoods() {
  const cache = new Map();
  for (const el of document.querySelectorAll('.av.tile[data-member]')) {
    const id = el.dataset.member;
    if (!cache.has(id)) cache.set(id, moodOf(id));
    const mood = cache.get(id);
    if ((el.dataset.mood || '') === mood) continue;
    el.dataset.mood = mood;
    const img = el.querySelector('img');
    if (!img) continue;
    img.src = friendSrc(id, mood);
    img.animate?.([{ opacity: 0.55, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1)' });
  }
}

// The mood faces are tiny; load them once so a change never flashes.
let preloaded = false;
export function preloadMoods() {
  if (preloaded) return;
  preloaded = true;
  for (const id of BOTS_ORDER) for (const m of MOODS) { const src = friendSrc(id, m); if (!src) continue; const i = new Image(); i.decoding = 'async'; i.src = src; }
}

export function avatar(id, size, { working = false } = {}) {
  const m = member(id);
  const mood = m.kind === 'bot' ? moodOf(id) : '';
  const friend = m.kind === 'bot' ? friendFor(id, mood) : null;
  const g = m.kind === 'bot' && !friend ? glyphFor(id) : null;
  const initials = m.initials || String(m.name || '?').slice(0, 1).toUpperCase();
  const el = h('div', {
    class: `av${m.kind === 'human' ? ' human' : ''}${friend ? ' tile' : ''}${g ? ' glyph' : ''}${working ? ' working' : ''}`,
    style: { '--s': `${size}px`, ...(friend ? { '--tc': friend.color } : {}) },
    dataset: { member: id, mood },
    'aria-hidden': 'true',
  });
  if (friend) el.append(h('img', { src: friend.src, alt: '', draggable: 'false', decoding: 'async' }));
  else if (g) el.innerHTML = GLYPHS[g];
  else el.append(h('span', { class: 'av-i' }, initials));
  return el;
}

// The room: up to three small friends tucked together (team.json room.faces, default the first three bots).
const SPOTS = [[0.02, 0.02, 0.54], [0.48, 0, 0.5], [0.28, 0.46, 0.52]];
const SPOTS_TWO = [[0.0, 0.08, 0.56], [0.44, 0.34, 0.56]];
export function roomMark(size) {
  const el = h('div', { class: 'av room', style: { '--s': `${size}px` }, 'aria-hidden': 'true' });
  const faces = TEAM.faces.slice(0, 3);
  if (faces.length === 1) return avatar(faces[0], size);
  const spots = faces.length === 2 ? SPOTS_TWO : SPOTS;
  for (const [i, id] of faces.entries()) {
    const [x, y, s] = spots[i];
    const a = avatar(id, Math.round(size * s));
    a.style.position = 'absolute';
    a.style.left = `${x * size}px`;
    a.style.top = `${y * size}px`;
    el.append(a);
  }
  return el;
}

// Kept for callers that still ask for a group picture: the room is one mark now.
export function cluster(memberIds, size) { return roomMark(size); }

export function chatAvatar(chat, size, opts) {
  if (!chat) return h('div');
  if (chat.kind === 'room') return roomMark(size);
  const other = (chat.members || []).find((id) => id !== state.me?.id) || chat.id.replace(/^dm-/, '');
  return avatar(other, size, opts);
}

export function dmPartner(chat) {
  if (!chat || chat.kind !== 'dm') return null;
  return (chat.members || []).find((id) => id !== state.me?.id) || chat.id.replace(/^dm-/, '');
}

// Presence no longer draws a dot; the marks need no update.
export function refreshPresence() {}
