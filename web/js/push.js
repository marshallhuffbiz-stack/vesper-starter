// Service worker registration and Web Push. Everything here is skipped silently over plain HTTP.
import { h, icons, isIOS, isStandalone, store } from './util.js';
import { state } from './store.js';
import { post } from './api.js';

const DISMISS_KEY = 'holler.pushBannerDismissed';
let registration = null;
let listening = false;

export async function registerServiceWorker(onOpenChat) {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return null;
  if (!listening) {
    listening = true;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-chat' && e.data.chat_id) onOpenChat(e.data.chat_id, e.data.message_id ?? null);
      // A reminder opens a screen, not a chat ("#/approvals"); the router picks it up from the hash.
      if (e.data?.type === 'open-route' && /^#\/[a-z]+$/.test(String(e.data.route || ''))) location.hash = e.data.route;
    });
    // A new release took over: reload the next time the app is out of sight, never in front of
    // The owner (a Home Screen app can stay open for days and would keep running the old code).
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const reloadHidden = () => { if (document.visibilityState === 'hidden') location.reload(); };
      document.addEventListener('visibilitychange', reloadHidden);
    });
  }
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch { registration = null; }
  return registration;
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// 'prompt' (show "Turn on notifications"), 'a2hs' (iOS Safari tab: add to Home Screen first) or null.
async function pushMode() {
  if (!window.isSecureContext || !state.vapidPublicKey) return null;
  if (isIOS() && !isStandalone()) return 'a2hs';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null;
  if (Notification.permission === 'denied') return null;
  if (Notification.permission === 'granted') {
    // Already allowed: make sure the server has a fresh subscription, quietly.
    subscribe().catch(() => {});
    return null;
  }
  return 'prompt';
}

async function subscribe() {
  const reg = registration || (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(state.vapidPublicKey) });
  }
  await post('/api/push/subscribe', { subscription: sub.toJSON() });
  return sub;
}

export async function renderPushBanner(slot) {
  slot.replaceChildren();
  slot.hidden = true;
  if (store.get(DISMISS_KEY)) return;
  const mode = await pushMode();
  if (!mode) return;
  const dismiss = (e) => { e?.stopPropagation(); store.set(DISMISS_KEY, '1'); slot.hidden = true; slot.replaceChildren(); };
  const banner = mode === 'a2hs'
    ? h('div', { class: 'banner' },
      h('div', { class: 'banner-ic', html: icons.share }),
      h('div', { class: 'banner-text' },
        h('b', {}, 'Add Vesper to your Home Screen'),
        h('span', {}, 'Tap Share, then Add to Home Screen. Notifications work from there.')),
      h('button', { class: 'banner-x', type: 'button', 'aria-label': 'Dismiss', html: icons.x, onclick: dismiss }))
    : h('div', { class: 'banner tappable', role: 'button', tabindex: '0' },
      h('div', { class: 'banner-ic', html: icons.bell }),
      h('div', { class: 'banner-text' },
        h('b', {}, 'Turn on notifications'),
        h('span', {}, 'Get a ping when a bot needs you.')),
      h('button', { class: 'banner-x', type: 'button', 'aria-label': 'Dismiss', html: icons.x, onclick: dismiss }));
  if (mode === 'prompt') {
    const go = async () => {
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') { await subscribe(); slot.hidden = true; slot.replaceChildren(); }
        else if (perm === 'denied') { slot.hidden = true; slot.replaceChildren(); }
      } catch {
        banner.querySelector('.banner-text span').textContent = 'Couldn’t turn on notifications. Try again.';
      }
    };
    banner.addEventListener('click', go);
    banner.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
  slot.append(banner);
  slot.hidden = false;
}

// The Notifications row in the room's details (11-02): where this device stands, in plain words.
export function pushStatus() {
  if (!window.isSecureContext || !state.vapidPublicKey) return { mode: 'off', text: 'Not available on this address' };
  if (isIOS() && !isStandalone()) return { mode: 'a2hs', text: 'Open Vesper from your Home Screen to get them' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { mode: 'off', text: 'This browser cannot get them' };
  if (Notification.permission === 'denied') return { mode: 'denied', text: 'Blocked. Turn them on in Settings, Notifications, Vesper' };
  if (Notification.permission === 'granted') return { mode: 'on', text: 'On. Each card rings on its own, and one reminder comes if a card waits two hours' };
  return { mode: 'ask', text: 'Off on this device' };
}

export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  await subscribe();
  return true;
}

// Re-subscribe (so the server surely has this device), then ask the server to push a test to every device.
export async function testPush() {
  if (pushStatus().mode === 'on') await subscribe().catch(() => {});
  return post('/api/push/test', {});
}

