// The app's height and the iOS keyboard (moved out of app.js 11-06 so it can be tested on its own).

// ── viewport: keep the composer above the iOS keyboard ─────────────────────
// Only a focused text field can bring the keyboard up. 11-06: a Home Screen app that missed the keyboard's close
// (back from a call or another app, the keyboard gone while Vesper was out of sight) kept the short height, so the
// whole app sat in the top 60% of the screen with the search bar floating over the list. With nothing to type in,
// the keyboard is down whatever the browser last said, and the height is checked again on every focus change and
// every return to the app.
const TYPABLE = 'textarea, [contenteditable=""], [contenteditable="true"], input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=file]):not([type=color])';
export function typing(doc = document) {
  const a = doc.activeElement;
  return !!a && a !== doc.body && !!a.matches?.(TYPABLE) && !a.disabled && !a.readOnly;
}
// The app's height. kb: the keyboard is up (a field has focus and the visible height is well short of the tallest
// seen at this width). Without it the app fills the screen; in a Home Screen app the window never changes size
// apart from the keyboard, so the tallest height seen is the screen even when the browser still reports less.
export function appHeight({ visible, inner, full, typing: t, standalone }) {
  const kb = t && full - visible > 120;
  if (kb) return { kb, h: visible };
  return { kb, h: Math.max(visible, inner, standalone ? full : 0) };
}
export function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const standalone = () => !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  // With interactive-widget=resizes-content the layout viewport shrinks too, so the keyboard is
  // detected against the tallest height seen for this width (reset when the width changes).
  let full = 0, fullW = 0;
  const apply = () => {
    const visible = vv ? vv.height : window.innerHeight;
    if (window.innerWidth !== fullW) { fullW = window.innerWidth; full = 0; }
    full = Math.max(full, window.innerHeight, visible);
    // Without the keyboard the app fills the whole screen: in a Home Screen app iOS can report a visual
    // viewport short of the home indicator, which left a bare strip under the list (10-29).
    const { kb, h } = appHeight({ visible, inner: window.innerHeight, full, typing: typing(), standalone: standalone() });
    root.style.setProperty('--app-h', `${h}px`);
    root.classList.toggle('kb-open', kb);
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
  };
  // The keyboard animates for about a quarter second and iOS does not always send a resize at the end.
  let timers = [];
  const settle = () => { apply(); timers.forEach(clearTimeout); timers = [80, 320, 700].map((ms) => setTimeout(apply, ms)); };
  apply();
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', settle);
  window.addEventListener('pageshow', settle);
  document.addEventListener('focusin', settle);
  document.addEventListener('focusout', settle);
  document.addEventListener('visibilitychange', () => {
    // Leaving the app puts the keyboard away for good (iOS hides it anyway); the field keeps its words.
    if (document.visibilityState === 'hidden') { if (typing()) document.activeElement.blur(); return; }
    settle();
  });
}
