// A bottom sheet (the same one Later and the card editors use): slides up over a dimmed app, closes on the
// backdrop, a [data-close] control or Escape. Returns {ov, close}.
import { h } from './util.js';

export function sheet(label, cls, ...kids) {
  const ov = h('div', { class: 'ed-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, h('div', { class: `ed-sheet ${cls || ''}` }, ...kids));
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  let closed = false;
  const close = () => { if (closed) return; closed = true; ov.classList.remove('show'); document.removeEventListener('keydown', key, true); setTimeout(() => ov.remove(), 260); };
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', key, true);
  document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('show'));
  return { ov, close };
}

export const sheetTop = (title, closeWord = 'Done') => h('div', { class: 'ed-top' }, h('span'), h('b', {}, title), h('button', { class: 'ed-cancel ed-done', type: 'button', 'data-close': '' }, closeWord));
