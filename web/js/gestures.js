// Touch gestures: long-press tapbacks (and right-click on desktop), swipe a bubble right to reply,
// and an edge swipe from the left to go back.
import { h, icons, reducedMotion, isWide } from './util.js';
import { isMe } from './store.js';

const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓'];
const HOLD_MS = 450;
const REVEAL_MAX = 70;

export function initBubbleGestures(container, { lookup, onReply, onReact, onRemind }) {
  let hold = null; // {timer, x, y, target}
  let swipe = null; // {row, line, x, y, dx, locked}
  let reveal = null; // drag left anywhere: sent bubbles slide over, times show
  let rvRaf = 0;
  const paintReveal = () => {
    rvRaf = 0;
    if (reveal) container.style.setProperty('--rv', reveal.v.toFixed(1));
  };

  // Approval cards hold for Reply and tapbacks like any bubble (the slider and buttons keep their taps).
  const target = (e) => e.target.closest('.bubble:not(.typing), .att, .appr, .tk');
  const rowOf = (el) => el?.closest('.row');
  const msgOf = (row) => (row ? lookup(row.dataset.key) : null);

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.appr-track, button.card-quiet, .appr-more, .bubble-more, a, .fail-ic, .fail-note, .quote')) return;
    reveal = { x: e.clientX, y: e.clientY, id: e.pointerId, v: 0, locked: false };
    container.classList.remove('rv-back');
    const t = target(e);
    const row = rowOf(e.target);
    const m = msgOf(row);
    if (!m || m.id == null || m.kind === 'system') return;
    if (t) {
      hold = {
        x: e.clientX, y: e.clientY, target: t, id: e.pointerId,
        timer: setTimeout(() => { hold = null; swipe = null; openMenu(t, m, { onReply, onReact, onRemind }); }, HOLD_MS),
      };
    }
    if (e.clientX > 28) swipe = { row, line: row.querySelector('.line'), x: e.clientX, y: e.clientY, dx: 0, locked: false, id: e.pointerId };
  });

  container.addEventListener('pointermove', (e) => {
    // Only the finger that is holding can cancel it: WebKit sends stray mouse moves after a scroll or a
    // layout shift (an avatar image landing), and a second finger should not cancel either.
    if (hold && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) { clearTimeout(hold.timer); hold = null; }
    if (reveal && e.pointerId === reveal.id && !swipe?.locked) {
      const dx = reveal.x - e.clientX;
      const dy = e.clientY - reveal.y;
      if (!reveal.locked) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) reveal = null;
        else if (dx > 10 && dx > Math.abs(dy) * 1.2) {
          reveal.locked = true;
          swipe = null;
          try { container.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
      }
      if (reveal?.locked) {
        // Follows the finger, then resists toward ~70pt.
        const d = Math.max(0, dx - 10);
        reveal.v = REVEAL_MAX * (1 - Math.exp(-d / 85));
        if (!rvRaf) rvRaf = requestAnimationFrame(paintReveal);
        return;
      }
    }
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (!swipe.locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
      if (dx > 10 && dx > Math.abs(dy) * 1.2) {
        swipe.locked = true;
        swipe.row.classList.add('swiping');
        try { container.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      } else return;
    }
    swipe.dx = Math.max(0, Math.min(90, (dx - 10) * 0.7));
    swipe.line.style.transform = `translateX(${swipe.dx}px)`;
    swipe.row.style.setProperty('--swipe', String(Math.min(1, swipe.dx / 60)));
    swipe.row.classList.toggle('swipe-armed', swipe.dx >= 60);
  });

  const end = (e) => {
    if (hold && (!e || e.pointerId === hold.id)) { clearTimeout(hold.timer); hold = null; }
    if (reveal && (!e || e.pointerId === reveal.id)) {
      const r = reveal;
      reveal = null;
      if (rvRaf) { cancelAnimationFrame(rvRaf); rvRaf = 0; }
      if (r.locked) {
        // Spring back ~0.35 s with no overshoot.
        container.classList.add('rv-back');
        container.style.setProperty('--rv', '0');
        suppressClick();
        setTimeout(() => { if (!reveal) container.classList.remove('rv-back'); }, 380);
      }
    }
    if (!swipe) return;
    const s = swipe;
    swipe = null;
    if (!s.locked) return;
    const armed = s.dx >= 60;
    s.line.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
    s.line.style.transform = '';
    s.row.style.setProperty('--swipe', '0');
    s.row.classList.remove('swipe-armed');
    setTimeout(() => { s.line.style.transition = ''; s.row.classList.remove('swiping'); }, 300);
    if (armed) {
      const m = msgOf(s.row);
      if (m) onReply(m);
      suppressClick();
    }
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);

  // Desktop: right-click opens the same menu.
  container.addEventListener('contextmenu', (e) => {
    const t = target(e);
    const m = msgOf(rowOf(e.target));
    if (!t || !m || m.id == null) return;
    e.preventDefault();
    openMenu(t, m, { onReply, onReact, onRemind });
  });
}

function suppressClick() {
  document.body.classList.add('lp-suppress');
  setTimeout(() => document.body.classList.remove('lp-suppress'), 350);
}

let menuOpen = null;

export function openMenu(el, m, { onReply, onReact, onRemind }) {
  if (menuOpen) menuOpen();
  suppressClick();
  navigator.vibrate?.(8);
  const rect = el.getBoundingClientRect();
  const mine = isMe(m.sender);
  const myEmoji = (m.reactions || []).find((r) => isMe(r.member_id))?.emoji;
  const vw = window.innerWidth;
  const vh = window.visualViewport?.height || window.innerHeight;
  const top0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;

  const clone = el.cloneNode(true);
  clone.classList.add('lp-clone');
  clone.querySelectorAll('button').forEach((b) => { b.disabled = true; b.tabIndex = -1; });

  const NAMES = { '❤️': 'Heart', '👍': 'Like', '👎': 'Dislike', '😂': 'Laugh', '‼️': 'Emphasize', '❓': 'Question' };
  const bar = h('div', { class: 'lp-bar glass blur', role: 'toolbar', 'aria-label': 'Tapback' },
    // Real emoji characters, drawn by the system emoji font (Apple Color Emoji on iPhone).
    TAPBACKS.map((e) => h('button', { class: `lp-emoji${e === myEmoji ? ' on' : ''}`, type: 'button', 'aria-label': NAMES[e], 'aria-pressed': String(e === myEmoji), dataset: { emoji: e } }, h('span', { class: 'emj' }, e))));
  const canCopy = !!String(m.text || '').trim();
  const menu = h('div', { class: 'lp-menu glass blur', role: 'menu' },
    h('button', { type: 'button', role: 'menuitem', dataset: { act: 'reply' } }, h('span', {}, 'Reply'), h('span', { class: 'ic', html: icons.reply })),
    canCopy ? h('button', { type: 'button', role: 'menuitem', dataset: { act: 'copy' } }, h('span', {}, 'Copy'), h('span', { class: 'ic', html: icons.copy })) : null,
    // Later (11-06): park this message on the home screen with a time, instead of hoping to scroll back to it.
    onRemind && m.id != null ? h('button', { type: 'button', role: 'menuitem', dataset: { act: 'remind' } }, h('span', {}, 'Remind me'), h('span', { class: 'ic', html: icons.alarm })) : null);
  const ov = h('div', { class: 'lp', role: 'dialog', 'aria-label': 'Message actions' }, h('div', { class: 'lp-dim' }), clone, bar, menu);
  document.body.append(ov);

  // Place: bar above the bubble, menu below; shift the whole group to stay on screen.
  const barH = 62, menuH = menu.offsetHeight || 100, gap = 10;
  const maxBubbleH = vh - top0 - barH - menuH - gap * 2 - 24;
  const bh = Math.min(rect.height, Math.max(80, maxBubbleH));
  let top = rect.top;
  const minTop = top0 + 12 + barH + gap;
  const maxTop = vh - 12 - menuH - gap - bh;
  top = Math.max(minTop, Math.min(top, maxTop));
  Object.assign(clone.style, { position: 'fixed', left: `${rect.left}px`, top: `${top}px`, width: `${rect.width}px`, maxHeight: `${bh}px`, margin: '0', overflow: bh < rect.height ? 'hidden' : 'visible' });
  const barW = Math.min(vw - 16, 6 * 49 + 18);
  const barLeft = mine ? Math.max(8, rect.right - barW) : Math.min(vw - barW - 8, Math.max(8, rect.left));
  Object.assign(bar.style, { left: `${barLeft}px`, top: `${top - barH - gap}px`, width: `${barW}px` });
  const menuW = 220;
  const menuLeft = mine ? Math.max(8, rect.right - menuW) : Math.min(vw - menuW - 8, Math.max(8, rect.left));
  Object.assign(menu.style, { left: `${menuLeft}px`, top: `${top + bh + gap}px`, width: `${menuW}px` });
  clone.style.transformOrigin = mine ? 'right center' : 'left center';
  el.classList.add('lp-source');
  requestAnimationFrame(() => ov.classList.add('show'));

  const close = () => {
    menuOpen = null;
    document.removeEventListener('keydown', onKey);
    ov.classList.remove('show');
    ov.classList.add('hide');
    setTimeout(() => { ov.remove(); el.classList.remove('lp-source'); }, reducedMotion() ? 0 : 200);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  menuOpen = close;

  ov.addEventListener('click', async (e) => {
    const em = e.target.closest('[data-emoji]');
    const act = e.target.closest('[data-act]');
    if (em) { onReact(m, em.dataset.emoji); close(); return; }
    if (act?.dataset.act === 'reply') { close(); onReply(m); return; }
    if (act?.dataset.act === 'copy') { await copyText(m.text || ''); close(); return; }
    if (act?.dataset.act === 'remind') { close(); onRemind(m); return; }
    if (!e.target.closest('.lp-bar, .lp-menu')) close();
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
}

// Interactive back swipe from the left edge of the thread pane (phone layout only). A thin grab
// strip with touch-action: none owns the edge so the browser never steals the drag. The pane
// follows the finger frame by frame; on release it glides from where it is (never snapping back
// first) to fully closed or back open, speed taken from the last ~100 ms of movement.
const POP_EASE = 'cubic-bezier(.2,.8,.2,1)';
export function initEdgeSwipe(pane, listPane, { onBack }) {
  const grab = h('div', { class: 'edge-grab', 'aria-hidden': 'true' });
  pane.append(grab);
  let s = null;
  let raf = 0;

  const paint = () => {
    raf = 0;
    if (!s) return;
    const w = s.w;
    const p = Math.min(1, s.dx / w);
    pane.style.transform = `translate3d(${s.dx}px,0,0)`;
    listPane.style.transform = `translate3d(${-0.3 * w * (1 - p)}px,0,0)`;
    listPane.style.setProperty('--shade', String(1 - p));
  };

  grab.addEventListener('pointerdown', (e) => {
    if (isWide() || !document.body.classList.contains('thread-open')) return;
    s = { x: e.clientX, y: e.clientY, dx: 0, locked: false, id: e.pointerId, w: pane.offsetWidth, samples: [{ x: e.clientX, t: e.timeStamp }] };
    try { grab.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  grab.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    if (!s.locked) {
      if (Math.abs(e.clientY - s.y) > 14 && Math.abs(e.clientY - s.y) > dx) { s = null; return; }
      if (dx < 4) return;
      s.locked = true;
      document.body.classList.add('edge-dragging');
      pane.style.willChange = listPane.style.willChange = 'transform';
    }
    s.dx = Math.max(0, dx);
    s.samples.push({ x: e.clientX, t: e.timeStamp });
    while (s.samples.length > 2 && e.timeStamp - s.samples[0].t > 100) s.samples.shift();
    if (!raf) raf = requestAnimationFrame(paint);
  });

  const settle = (st, close) => {
    const w = st.w;
    const first = st.samples[0], last = st.samples[st.samples.length - 1];
    const v = (last.x - first.x) / Math.max(16, last.t - first.t); // px per ms, + is toward closing
    const remaining = close ? w - st.dx : st.dx;
    const ms = Math.round(Math.max(160, Math.min(380, remaining / Math.max(0.9, Math.abs(v)))));
    // Explicit animations from where the finger let go to the resting place. CSS transitions
    // here could be retargeted mid-flight (a one-frame jump seen in WebKit); WAAPI cannot.
    const shade = document.querySelector('.list-shade');
    const listFrom = listPane.style.transform || `translate3d(${-0.3 * w}px,0,0)`;
    const opts = { duration: ms, easing: POP_EASE, fill: 'forwards' };
    const a1 = pane.animate([{ transform: `translate3d(${st.dx}px,0,0)` }, { transform: `translate3d(${close ? w : 0}px,0,0)` }], opts);
    const a2 = listPane.animate([{ transform: listFrom }, { transform: `translate3d(${close ? 0 : -0.3 * w}px,0,0)` }], opts);
    const a3 = shade?.animate([{ opacity: getComputedStyle(shade).opacity }, { opacity: close ? 0 : 1 }], opts);
    a1.onfinish = () => {
      // Pin the final frame inline with transitions off, land the class change, and only then
      // let go, two frames later. Nothing can retarget or replay a transition in between.
      const toPane = `translate3d(${close ? w : 0}px,0,0)`;
      const toList = `translate3d(${close ? 0 : -0.3 * w}px,0,0)`;
      pane.style.transition = listPane.style.transition = 'none';
      pane.style.transform = toPane;
      listPane.style.transform = toList;
      a1.cancel(); a2.cancel(); a3?.cancel();
      if (close) onBack();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const el of [pane, listPane]) { el.style.transform = ''; el.style.willChange = ''; }
        listPane.style.removeProperty('--shade');
        document.body.classList.remove('edge-dragging');
        requestAnimationFrame(() => { pane.style.transition = ''; listPane.style.transition = ''; });
      }));
    };
  };

  const end = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const st = s;
    s = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!st.locked) return;
    const first = st.samples[0], last = st.samples[st.samples.length - 1];
    const v = (last.x - first.x) / Math.max(16, last.t - first.t);
    const close = v > 0.5 || (v > -0.2 && st.dx > st.w * 0.5);
    settle(st, close);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}
