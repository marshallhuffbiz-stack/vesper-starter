// Documents (11-10, the owner: the bots say "it's ready" and there was no place in Vesper to read it). Three things
// live here: the file tile a thread or a card shows for anything that is not a plain photo, the viewer that opens a
// file inside the app (a PDF page by page as pictures, Word and HTML in a frame that runs nothing, text, video,
// sound), and Deliverables (#/files), every file the bots handed him: what is coming up, what waits on his OK, then
// the rest by day. Home shows one row for it (docsSummary).
import { $, h, icon, icons, fmtBytes, fmtSeparator, fmtTime, toMs, toast } from './util.js';
import { api, post } from './api.js';
import { firstName } from './store.js';
import { avatar } from './avatar.js';
import { readCard, readTask, clientMark, clientOf } from './marks.js';
import { renderMarkdown, previewText } from './md.js';

const DAY = 86400000;
const svg = (d, w = 24) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const DOC_GLYPH = svg('<path d="M7 3h7.5L19 7.5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h4.5"/>');
const SHARE = svg('<path d="M12 3.5v11M8 7l4-4 4 4"/><path d="M8.5 10.5H7A1.5 1.5 0 0 0 5.500 12v7A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5v-7a1.500 1.500 0 0 0-1.500-1.500h-1.500"/>', 21);
const CLOSE = svg('<path d="m6 6 12 12M18 6 6 18"/>', 18);

let hooks = { back() {}, openAt() {} };
let items = null;
let loading = null;
let el = null;
const listeners = new Set();

// ── what a file is, in words ──────────────────────────────────────────────
const KIND = {
  pdf: ['PDF', 'pdf'], image: ['Photo', 'img'], video: ['Video', 'vid'], audio: ['Recording', 'aud'],
};
const BY_TYPE = [
  [/wordprocessingml|msword|rtf/, 'Word', 'doc', 'DOC'], [/spreadsheetml|ms-excel/, 'Excel', 'xls', 'XLS'], [/presentationml/, 'Slides', 'ppt', 'PPT'],
  [/^text\/csv/, 'Table', 'xls', 'CSV'], [/^text\/markdown/, 'Notes', 'txt', 'MD'], [/^text\/html/, 'Web page', 'web', 'HTML'],
  [/^text\/plain/, 'Text', 'txt', 'TXT'], [/json/, 'Data', 'txt', 'JSON'], [/zip/, 'Zip', 'zip', 'ZIP'],
];
// How a file opens. The server says (file.view); a file object without it is read from its type.
function viewOf(f) {
  if (f.view) return f.view;
  const t = String(f.type || '');
  return t.startsWith('image/') ? 'image' : t === 'application/pdf' ? 'pdf' : /^text\/(plain|markdown|csv)$|json/.test(t) ? 'text' : t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : 'file';
}
export function kindOf(f) {
  if (!f.view) f = { ...f, view: viewOf(f) };
  if (KIND[f.view]) return { word: KIND[f.view][0], cls: KIND[f.view][1], tag: f.view === 'pdf' ? 'PDF' : f.view === 'video' ? 'MP4' : f.view === 'audio' ? 'AUDIO' : 'IMG' };
  const hit = BY_TYPE.find(([re]) => re.test(String(f.type || '')));
  if (hit) return { word: hit[1], cls: hit[2], tag: hit[3] };
  const ext = /\.([a-z0-9]{1,5})$/i.exec(f.name || '')?.[1];
  return { word: 'File', cls: 'gen', tag: (ext || 'FILE').toUpperCase() };
}
export function fileMeta(f) {
  const k = kindOf(f);
  return [k.word, f.pages ? `${f.pages} ${f.pages === 1 ? 'page' : 'pages'}` : null, fmtBytes(f.size)].filter(Boolean).join(' · ');
}

// "for today 2:30 PM", "for Wed 2:30 PM"; once it has passed, "was for Tue 10:00 AM".
export function forWhen(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(ms) - day(now)) / DAY);
  const d = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday'
    : new Date(ms).toLocaleDateString([], Math.abs(diff) < 7 ? { weekday: 'short' } : { weekday: 'short', month: 'short', day: 'numeric' });
  return `${ms < now - 3 * 3600000 ? 'was for' : 'for'} ${d} ${fmtTime(ms)}`;
}

// The small picture of a file: its first page, the photo itself, or a paper tile with its kind on it.
export function fileThumb(f, cls = '') {
  const k = kindOf(f);
  const box = h('span', { class: `ft ft-${k.cls}${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' });
  const tag = () => box.replaceChildren(h('span', { class: 'ft-tag' }, k.tag));
  const photo = viewOf(f) === 'image';
  const src = photo ? (f.preview || f.url) : f.thumb;
  if (!src) { tag(); return box; }
  if (photo) box.classList.add('ft-photo');
  box.append(h('img', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', onerror: tag }));
  return box;
}

// A file in a thread or on a card: thumbnail, name, what it is. Opens the viewer.
export function fileTile(f, { files = null, item = null, mine = false } = {}) {
  return h('button', { class: `fcell${mine ? ' out' : ''}`, type: 'button', 'aria-label': `Open ${f.name || 'file'}`, onclick: (e) => { e.stopPropagation(); openFile(f, { files: files || [f], item }); } },
    fileThumb(f), h('span', { class: 'fcell-tx' }, h('b', {}, f.name || 'File'), h('span', {}, fileMeta(f))), icon('chevron'));
}

// What a bot handed over, in its thread: what it is called, what it is for, and its files.
export function docCard(m) {
  const d = m.doc || {};
  const files = m.attachments || [];
  const item = { id: m.id, chat_id: m.chat_id, by: m.sender, doc: d, files, waiting: false };
  const sub = [d.kind, d.for_at ? forWhen(d.for_at) : null].filter(Boolean).join(' · ');
  const mark = d.client ? clientMark(d.client, 16) : null;
  return h('div', { class: 'dl' },
    h('div', { class: 'dl-head' }, h('b', {}, d.title || 'Files'),
      sub || mark ? h('div', { class: `dl-sub${mark ? ' has-cl' : ''}` }, mark, h('span', {}, [mark ? clientOf(d.client)?.short : (d.client || null), sub].filter(Boolean).join(' · '))) : null),
    h('div', { class: 'dl-files' }, ...files.map((f) => fileTile(f, { files, item }))));
}

// The documents on a card he is asked to approve (pictures show above the card as before).
export function cardDocs(m) {
  const files = (m.attachments || []).filter((a) => viewOf(a) !== 'image');
  if (!files.length) return null;
  const all = m.attachments || [];
  const item = { id: m.id, chat_id: m.chat_id, by: m.sender, files: all, waiting: !!(m.buttons?.length && !m.resolved) };
  return h('div', { class: 'ap-docs' }, ...files.map((f) => fileTile(f, { files: all, item })));
}

// ── the viewer ────────────────────────────────────────────────────────────
const blobs = new Map(); // file id -> Promise<File> for sharing
function fileBlob(f) {
  if (!blobs.has(f.id)) {
    const p = fetch(f.url, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error('gone'); return r.blob(); })
      .then((b) => new File([b], f.name || 'file', { type: f.type || b.type }));
    p.catch(() => blobs.delete(f.id));
    blobs.set(f.id, p);
  }
  return blobs.get(f.id);
}

function markSeen(f) {
  if (f.seen) return;
  f.seen = true;
  for (const it of items || []) for (const x of it.files) if (x.id === f.id) x.seen = true;
  notify();
  post(`/api/files/${f.id}/seen`).catch(() => {});
}

let viewer = null;
export function closeViewer() { viewer?.close(); }
export const viewerOpen = () => !!viewer;

export function openFile(file, { files = [file], item = null } = {}) {
  closeViewer();
  let cur = file;
  const body = h('div', { class: 'dv-body' });
  const title = h('b', {});
  const sub = h('span', {});
  const shareBtn = h('button', { class: 'dv-btn glass', type: 'button', 'aria-label': 'Share or save', html: SHARE });
  const strip = files.length > 1 ? h('div', { class: 'dv-strip glass blur', role: 'tablist', 'aria-label': 'Files' }) : null;
  const who = item?.by ? firstName(item.by) : '';
  const answer = item?.waiting ? h('button', { class: 'dv-answer', type: 'button' }, `Answer ${who || 'the card'}`) : item?.chat_id ? h('button', { class: 'dv-answer quiet', type: 'button' }, 'Open the chat') : null;
  const ov = h('div', { class: 'dv', role: 'dialog', 'aria-modal': 'true', 'aria-label': file.name || 'File' },
    body,
    h('header', { class: 'dv-bar' },
      h('button', { class: 'dv-btn glass', type: 'button', 'aria-label': 'Close', html: CLOSE, onclick: () => close() }),
      h('div', { class: 'dv-title glass blur' }, title, sub),
      shareBtn),
    strip || answer ? h('footer', { class: 'dv-foot' }, strip, answer) : null);
  let cleanup = () => {};
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    cleanup();
    ov.classList.remove('show');
    document.removeEventListener('keydown', key, true);
    if (viewer?.ov === ov) viewer = null;
    setTimeout(() => ov.remove(), 260);
  }
  answer?.addEventListener('click', () => { close(); hooks.openAt(item.chat_id, item.id); });
  shareBtn.addEventListener('click', () => share(cur, shareBtn));

  function show(f) {
    if (!f.view) f.view = viewOf(f);
    cur = f;
    cleanup();
    title.textContent = item?.doc?.title && files.length === 1 ? item.doc.title : (f.name || 'File');
    const setSub = (t) => { sub.textContent = t || fileMeta(f); };
    setSub('');
    body.className = `dv-body dv-${f.view || 'file'}`;
    body.scrollTop = 0; body.scrollLeft = 0;
    cleanup = render(f, body, setSub) || (() => {});
    markSeen(f);
    if (strip) strip.replaceChildren(...files.map((x) => h('button', { class: `dv-chip${x.id === f.id ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(x.id === f.id), title: x.name, onclick: () => { if (x.id !== cur.id) show(x); } },
      fileThumb(x, 'sm'), h('span', {}, x.name || 'File'))));
    // The file is fetched once in the background so Share answers on the first tap (iOS only shares inside a tap).
    if (navigator.canShare && f.size < 30 * 1024 * 1024) fileBlob(f).catch(() => {});
  }

  document.addEventListener('keydown', key, true);
  document.body.append(ov);
  viewer = { ov, close };
  show(file);
  requestAnimationFrame(() => ov.classList.add('show'));
  return viewer;
}

async function share(f, btn) {
  if (!navigator.share || !navigator.canShare) { window.open(f.url, '_blank', 'noopener'); return; }
  btn.classList.add('busy');
  try {
    const file = await fileBlob(f);
    if (!navigator.canShare({ files: [file] })) { window.open(f.url, '_blank', 'noopener'); return; }
    await navigator.share({ files: [file], title: f.name });
  } catch (e) {
    // The phone lost the tap while the file was still arriving: it is here now, so the next tap works.
    if (e?.name === 'NotAllowedError') toast('Ready. Tap Share again.');
    else if (e?.name !== 'AbortError') toast('Could not get the file from the Mac.');
  } finally { btn.classList.remove('busy'); }
}

function render(f, body, setSub) {
  if (f.view === 'pdf') return pages(body, f, Array.from({ length: f.pages || 1 }, (_, i) => `${f.url}/pg/${i + 1}`), setSub);
  if (f.view === 'image') return pages(body, f, [f.url], setSub, f.preview);
  if (f.view === 'text') { textDoc(body, f); return null; }
  if (f.view === 'html') {
    body.replaceChildren(h('iframe', { class: 'dv-frame', src: `${f.url}/v`, sandbox: '', referrerpolicy: 'no-referrer', title: f.name || 'Document' }));
    return null;
  }
  if (f.view === 'video') { body.replaceChildren(h('video', { class: 'dv-video', src: f.url, controls: true, playsinline: true, preload: 'metadata' })); return () => body.querySelector('video')?.pause(); }
  if (f.view === 'audio') { body.replaceChildren(h('div', { class: 'dv-none' }, fileThumb(f, 'big'), h('b', {}, f.name), h('audio', { src: f.url, controls: true, preload: 'metadata' }))); return () => body.querySelector('audio')?.pause(); }
  body.replaceChildren(h('div', { class: 'dv-none' }, fileThumb(f, 'big'), h('b', {}, f.name || 'File'), h('span', {}, fileMeta(f)),
    h('p', {}, 'Vesper cannot show this kind of file. Share it to open it in another app.')));
  return null;
}

// Pages as pictures, drawn on the Mac: each loads when it is near the screen. Pinch or double-tap to zoom.
function pages(body, f, urls, setSub, first = null) {
  const ratio = f.width && f.height ? `${f.width} / ${f.height}` : (f.view === 'pdf' ? '612 / 792' : null);
  const wrap = h('div', { class: `dv-pages${urls.length === 1 && f.view === 'image' ? ' photo' : ''}` });
  const boxes = urls.map((u, i) => {
    const img = h('img', { alt: f.view === 'pdf' ? `Page ${i + 1}` : (f.name || 'Photo'), decoding: 'async', draggable: 'false' });
    const box = h('div', { class: 'dv-pg', style: ratio ? { aspectRatio: ratio } : null, dataset: { src: u, n: i + 1 } }, img);
    img.addEventListener('load', () => box.classList.add('ready'));
    img.addEventListener('error', () => {
      if (box.dataset.tried) { box.classList.add('bad'); box.dataset.msg = 'This page could not be drawn. Tap to try again.'; return; }
      box.dataset.tried = '1';
      setTimeout(() => { img.src = `${u}${u.includes('?') ? '&' : '?'}r=1`; }, 900);
    });
    box.addEventListener('click', () => { if (box.classList.contains('bad')) { box.classList.remove('bad'); delete box.dataset.tried; img.src = `${u}?r=${Date.now()}`; } });
    if (i === 0 && first) { img.src = first; const full = new Image(); full.onload = () => { if (img.isConnected) img.src = u; }; full.src = u; box.dataset.loaded = '1'; }
    return box;
  });
  wrap.append(...boxes);
  body.replaceChildren(wrap);
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting || e.target.dataset.loaded) continue;
      e.target.dataset.loaded = '1';
      e.target.firstChild.src = e.target.dataset.src;
    }
  }, { root: body, rootMargin: '120% 0px' });
  boxes.forEach((b) => io.observe(b));

  const total = urls.length;
  const onScroll = () => {
    if (total < 2) return;
    const mid = body.scrollTop + body.clientHeight * 0.4;
    let n = 1;
    for (const b of boxes) { if (b.offsetTop <= mid) n = Number(b.dataset.n); else break; }
    setSub(`Page ${n} of ${total}`);
  };
  body.addEventListener('scroll', onScroll, { passive: true });
  if (total > 1) setSub(`Page 1 of ${total}`);

  // Zoom: the pages get wider and the screen scrolls both ways; the point under the fingers stays put.
  let zoom = 1;
  const setZoom = (z, cx, cy) => {
    z = Math.min(4, Math.max(1, z));
    const r = wrap.getBoundingClientRect();
    const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
    zoom = z;
    wrap.style.width = z === 1 ? '' : `${z * 100}%`;
    body.classList.toggle('zoomed', z > 1);
    const r2 = wrap.getBoundingClientRect();
    body.scrollLeft += (r2.left + fx * r2.width) - cx;
    body.scrollTop += (r2.top + fy * r2.height) - cy;
  };
  let pinch = null, lastTap = null, frame = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const ts = (e) => {
    if (e.touches.length === 2) { pinch = { d: dist(e.touches), z: zoom }; lastTap = null; }
  };
  const tm = (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const d = dist(e.touches);
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (pinch) setZoom(pinch.z * (d / pinch.d), cx, cy); });
  };
  const te = (e) => {
    if (pinch) { if (e.touches.length < 2) { pinch = null; if (zoom < 1.08) setZoom(1, 0, 0); } return; }
    if (e.changedTouches.length !== 1 || e.touches.length) return;
    const t = e.changedTouches[0];
    const now = Date.now();
    if (lastTap && now - lastTap.at < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 28) {
      lastTap = null;
      e.preventDefault();
      setZoom(zoom > 1 ? 1 : 2.4, t.clientX, t.clientY);
    } else lastTap = { at: now, x: t.clientX, y: t.clientY };
  };
  const dbl = (e) => setZoom(zoom > 1 ? 1 : 2.4, e.clientX, e.clientY);
  body.addEventListener('touchstart', ts, { passive: true });
  body.addEventListener('touchmove', tm, { passive: false });
  body.addEventListener('touchend', te, { passive: false });
  body.addEventListener('dblclick', dbl);
  return () => {
    io.disconnect();
    cancelAnimationFrame(frame);
    body.removeEventListener('scroll', onScroll);
    body.removeEventListener('touchstart', ts); body.removeEventListener('touchmove', tm); body.removeEventListener('touchend', te);
    body.removeEventListener('dblclick', dbl);
    body.classList.remove('zoomed');
  };
}

const TEXT_MAX = 600 * 1024;
function csvRows(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
async function textDoc(body, f) {
  const sheet = h('div', { class: 'dv-sheet' }, h('div', { class: 'dv-wait' }, 'Opening…'));
  body.replaceChildren(sheet);
  try {
    const res = await fetch(f.url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('gone');
    let text = await res.text();
    const cut = text.length > TEXT_MAX;
    if (cut) text = text.slice(0, TEXT_MAX);
    if (!sheet.isConnected) return;
    if (f.type === 'text/markdown') sheet.replaceChildren(h('div', { class: 'dv-md btext', html: renderMarkdown(text) }));
    else if (f.type === 'text/csv') {
      const rows = csvRows(text).slice(0, 2000);
      sheet.classList.add('wide');
      sheet.replaceChildren(h('table', { class: 'dv-table' }, h('thead', {}, h('tr', {}, ...(rows[0] || []).map((c) => h('th', {}, c)))),
        h('tbody', {}, ...rows.slice(1).map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c)))))));
    } else sheet.replaceChildren(h('pre', { class: 'dv-pre' }, text));
    if (cut) sheet.append(h('p', { class: 'dv-cut' }, 'This is the start of a long file. Share it to read the rest.'));
  } catch {
    if (sheet.isConnected) sheet.replaceChildren(h('div', { class: 'dv-wait' }, 'Could not get this file from the Mac.'));
  }
}

// ── Deliverables ──────────────────────────────────────────────────────────
export function onDocs(fn) { listeners.add(fn); }
function notify() { listeners.forEach((f) => f(items)); if (isOpen()) render2(); }

export async function loadDocs() {
  if (loading) return loading;
  loading = api('/api/deliverables').then((d) => { items = d.items || []; notify(); return items; })
    .catch(() => items).finally(() => { loading = null; });
  return loading;
}
// A message with files arrived, or a card was answered: fetch once things settle.
let soon = 0;
export function docsChanged(m) {
  if (m && !(m.attachments || []).length) return;
  clearTimeout(soon);
  soon = setTimeout(loadDocs, 400);
}

const asMessage = (it) => ({ id: it.id, chat_id: it.chat_id, sender: it.by, text: it.text, kind: it.kind, buttons: it.buttons, resolved: it.resolved, attachments: it.files, at: it.at });
const isDocish = (it) => !!it.doc || it.files.some((f) => viewOf(f) !== 'image');
const isNew = (it) => isDocish(it) && it.files.some((f) => !f.seen) && Date.now() - toMs(it.at) < 21 * DAY;
const upcoming = (it, now = Date.now()) => it.doc?.for_at && it.doc.for_at > now - 3 * 3600000 && it.doc.for_at < now + 21 * DAY;

export function titleOf(it) {
  if (it.doc?.title) return it.doc.title;
  const m = asMessage(it);
  if (it.waiting) { const c = readCard(m); if (c?.title) return c.title; }
  const t = readTask(m);
  if (t?.title) return t.title;
  const line = previewText(String(it.text || '').split('\n').find((l) => l.trim()) || '').replace(/\s*\(#\d+\)\s*$/, '');
  if (line) return line.length > 70 ? `${line.slice(0, 69)}…` : line;
  const pics = it.files.filter((f) => viewOf(f) === 'image').length;
  return it.files.length === 1 ? (it.files[0].name || 'File') : pics === it.files.length ? `${pics} pictures` : `${it.files.length} files`;
}
function subOf(it) {
  const n = it.files.length;
  const count = n > 1 ? `${n} files` : null;
  if (it.waiting) return ['Waiting on your OK', count].filter(Boolean).join(' · ');
  // A card says how it ended (Sent, Done, Not sent); anything else says what kind of file it is.
  const task = it.doc ? null : readTask(asMessage(it));
  const kind = it.doc?.kind || task?.status?.label || (it.card ? (it.resolved?.label ? `You answered: ${it.resolved.label}` : 'Card') : n === 1 ? kindOf(it.files[0]).word : null);
  const when = it.doc?.for_at ? forWhen(it.doc.for_at) : null;
  // When it is for leads while it is still ahead, so a narrow phone never cuts the time off.
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  // Under a day heading, the time it came in closes the line.
  return (when && upcoming(it) ? [cap(when.replace(/^for /, '')), kind, count] : [kind, when, count, fmtTime(toMs(it.at))]).filter(Boolean).join(' · ');
}

// One line for the home screen.
export function docsSummary() {
  if (!items || !items.length) return null;
  const fresh = items.filter(isNew);
  const next = items.filter((it) => upcoming(it)).sort((a, b) => a.doc.for_at - b.doc.for_at)[0];
  const waiting = items.filter((it) => it.waiting).length;
  const parts = [];
  if (fresh.length) parts.push(`${fresh.length} new`);
  if (next) parts.push(`${titleOf(next)} ${forWhen(next.doc.for_at)}`);
  else if (fresh.length) parts.push(titleOf(fresh[0]));
  else if (waiting) parts.push(`${waiting} waiting on your OK`);
  if (!parts.length) parts.push('Nothing new');
  return { text: parts.join(' · '), fresh: fresh.length, parts, newWord: fresh.length ? `${fresh.length} new` : '' };
}

const isOpen = () => document.body.classList.contains('docs-open');
export const docsOpen = isOpen;

export function initDocs({ back, openAt }) {
  hooks = { back, openAt };
  el = $('#docs-pane');
  const backBtn = h('button', { class: 'back glass dr-back', type: 'button', 'aria-label': 'Back', onclick: () => back() });
  backBtn.innerHTML = '<svg viewBox="0 0 12 21" width="12" height="20" aria-hidden="true"><path d="M10 1.8 1.8 10.5l8.2 8.7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el.replaceChildren(h('div', { class: 'rn-scroll' }), h('div', { class: 'fade-top', 'aria-hidden': 'true' }, h('i'), h('i')), backBtn);
  el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-item]');
    if (!row) return;
    const it = (items || []).find((x) => String(x.id) === row.dataset.item);
    if (!it) return;
    const first = it.files.find((f) => !f.seen) || it.files[0];
    openFile(first, { files: it.files, item: it });
  });
  setInterval(() => { if (document.visibilityState === 'visible') loadDocs(); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadDocs(); });
}

export function showDocs() {
  document.body.classList.add('docs-open');
  el.setAttribute('aria-hidden', 'false');
  render2();
  loadDocs();
}
export function hideDocs() {
  document.body.classList.remove('docs-open');
  el?.setAttribute('aria-hidden', 'true');
}

function row(it) {
  const f = it.files[0];
  const more = it.files.length > 1;
  return h('button', { class: `need dr${isNew(it) ? ' new' : ''}`, type: 'button', dataset: { item: it.id }, 'aria-label': `${titleOf(it)}. ${subOf(it)}. From ${firstName(it.by)}.` },
    h('span', { class: `dr-th${more ? ' stack' : ''}` }, fileThumb(f)),
    h('span', { class: 'need-tx' }, h('b', {}, h('i', { class: 'dr-dot', 'aria-hidden': 'true' }), titleOf(it)),
      h('span', { class: it.doc?.client && clientOf(it.doc.client) ? 'has-cl' : '' }, it.doc?.client ? clientMark(it.doc.client, 15) : null, h('span', { class: 'dr-sub' }, subOf(it)))),
    h('span', { class: 'dr-end' }, avatar(it.by, 24)));
}

function render2() {
  if (!el) return;
  const scroll = el.querySelector('.rn-scroll');
  const top = scroll.scrollTop;
  const kids = [];
  const sum = docsSummary();
  kids.push(h('div', { class: 'rn-title' }, h('h1', {}, 'Deliverables'),
    h('div', { class: 'rn-sub' }, items == null ? 'Loading…' : !items.length ? 'Nothing yet' : sum?.fresh ? `${sum.fresh} new` : 'All caught up')));
  if (items && !items.length) {
    kids.push(h('div', { class: 'dr-empty' }, h('span', { class: 'appmark g-doc', style: { '--s': '56px' }, html: DOC_GLYPH }),
      h('b', {}, 'Files from the team land here'),
      h('p', {}, 'Meeting prep, proposals, drafts and anything a bot wants you to check before it goes out.')));
  }
  if (items?.length) {
    const now = Date.now();
    const used = new Set();
    const section = (label, list) => {
      if (!list.length) return;
      list.forEach((it) => used.add(it.id));
      kids.push(h('div', { class: 'sec-label' }, label), h('div', { class: 'cells' }, ...list.map(row)));
    };
    section('Coming up', items.filter((it) => upcoming(it, now)).sort((a, b) => a.doc.for_at - b.doc.for_at));
    section('Waiting on your OK', items.filter((it) => it.waiting && !used.has(it.id)));
    const days = new Map();
    for (const it of items) {
      if (used.has(it.id)) continue;
      const day = fmtSeparator(toMs(it.at), now).day;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(it);
    }
    for (const [day, list] of days) section(day, list);
  }
  scroll.replaceChildren(h('div', { class: 'rn-inner' }, ...kids));
  scroll.scrollTop = top;
}
