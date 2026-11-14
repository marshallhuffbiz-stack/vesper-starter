// Small DOM and formatting helpers shared by every view. Nothing here touches innerHTML with
// untrusted text: h() appends strings as text nodes, and `html` is only used for our own markup.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        for (const s in v) {
          if (v[s] == null) continue;
          if (s.startsWith('--')) el.style.setProperty(s, v[s]);
          else el.style[s] = v[s];
        }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v; // trusted markup only (icons, rendered markdown)
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// `at` is epoch ms from the server; ISO strings are accepted too.
export function toMs(at) {
  if (at == null) return 0;
  if (typeof at === 'number') return at < 1e12 ? at * 1000 : at;
  const n = Number(at);
  if (!Number.isNaN(n) && String(at).trim() !== '') return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
const sepDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayDiff(ms, now = Date.now()) { return Math.round((startOfDay(now) - startOfDay(ms)) / 86400000); }

export const fmtTime = (ms) => timeFmt.format(ms);

export function fmtListTime(ms) {
  if (!ms) return '';
  const d = dayDiff(ms);
  if (d <= 0) return fmtTime(ms);
  if (d === 1) return 'Yesterday';
  if (d < 7) return weekdayFmt.format(ms);
  return shortDateFmt.format(ms);
}

// Separator label parts, as Messages writes them: "Today 10:08 PM", "Yesterday 9:57 PM",
// "Friday 8:25 PM" within the week, "Oct 12 8:25 PM" before that.
export function fmtSeparator(ms, now = Date.now()) {
  const d = dayDiff(ms, now);
  let day;
  if (d <= 0) day = 'Today';
  else if (d === 1) day = 'Yesterday';
  else if (d < 7) day = weekdayFmt.format(ms);
  else day = sepDateFmt.format(ms);
  return { day, time: fmtTime(ms) };
}

// How long a card has waited, for the Approvals view: "Now", "12 min", "3 h" (same day), then the
// separator form ("Yesterday 4:40 PM", "Friday 4:40 PM", "Oct 12 4:40 PM").
export function fmtAge(ms, now = Date.now()) {
  if (!ms) return '';
  const min = Math.max(0, Math.floor((now - ms) / 60000));
  if (min < 1) return 'Now';
  if (min < 60) return `${min} min`;
  if (dayDiff(ms, now) <= 0) return `${Math.floor(min / 60)} h`;
  const s = fmtSeparator(ms, now);
  return `${s.day} ${s.time}`;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isWide = () => matchMedia('(min-width: 900px)').matches;
export const coarsePointer = () => matchMedia('(pointer: coarse)').matches;

export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Messages of one to three emoji and nothing else render large with no bubble.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3#*0-9\u{1F3FB}-\u{1F3FF}])+$/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function emojiCount(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s || s.length > 40 || !EMOJI_ONLY.test(s) || /^[#*0-9]+$/.test(s)) return 0;
  const n = segmenter ? [...segmenter.segment(s)].length : [...s].length;
  return n <= 3 ? n : 0;
}

// Inline SVG icons (static markup, safe for innerHTML).
export const icons = {
  wave: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 7v2M5 4.5v7M8 2.5v11M11 5v6M14 7v2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 12 21" width="12" height="21" aria-hidden="true"><path d="M10.5 1.5 1.5 10.5l9 9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 8 13" width="7" height="12" aria-hidden="true"><path d="m1.5 1.5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 3v14M3 10h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  up: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 16V4.5M4.8 9.6 10 4.4l5.2 5.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="8.5" cy="8.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m13 13 4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.4 15.4A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6Z" fill="currentColor"/><path d="M9.5 19a2.5 2.5 0 0 0 5 0" fill="currentColor"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M10 5 3.5 11 10 17v-3.6c4.6 0 7.7 1.4 10.5 5.1-.9-5.3-3.9-9.6-10.5-10.5Z" fill="currentColor"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M16 5.5V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  alarm: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="13" r="7.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 9.2V13l2.6 1.7M4.5 5.2 7 3M19.5 5.2 17 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="m4.5 10.5 3.6 3.6 7.4-8.2" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  xmark: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M12 6.5v7" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.5" fill="#fff"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 2.5h8l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1-1.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 2.5V8h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};

export function icon(name, cls) {
  const s = h('span', { class: `ic${cls ? ` ${cls}` : ''}`, html: icons[name] || '' });
  return s;
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer = null;
export function toast(text) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
