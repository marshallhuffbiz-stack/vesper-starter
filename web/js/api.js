// Same-origin JSON API with credentials, uploads with progress, and the live event stream.
import { uuid } from './util.js';

export class HttpError extends Error {
  constructor(status, message) { super(message || `HTTP ${status}`); this.status = status; }
}

// One id per tab so the server can tell this window's presence and stream apart from others.
export const CLIENT_ID = (() => {
  try {
    let id = sessionStorage.getItem('holler.client');
    if (!id) { id = uuid(); sessionStorage.setItem('holler.client', id); }
    return id;
  } catch { return uuid(); }
})();

function unauthorized() { window.dispatchEvent(new CustomEvent('holler:unauthorized')); }

export async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: 'no-store',
    });
  } catch (e) {
    throw new HttpError(0, e.name === 'AbortError' ? 'timeout' : 'network');
  } finally { clearTimeout(t); }
  if (res.status === 401) { unauthorized(); throw new HttpError(401, 'signed out'); }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) throw new HttpError(res.status, (data && data.error) || res.statusText);
  return data;
}

export function post(path, body) { return api(path, { method: 'POST', body: body ?? {} }); }

// Raw-body upload with progress. Resolves to the server's {file}.
export function upload(file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', '/api/files');
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'photo'));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 401) { unauthorized(); return reject(new HttpError(401)); }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new HttpError(xhr.status));
      try { resolve(JSON.parse(xhr.responseText).file); } catch { reject(new HttpError(500, 'bad response')); }
    };
    xhr.onerror = () => reject(new HttpError(0, 'network'));
    xhr.onabort = () => reject(new HttpError(0, 'aborted'));
    xhr.send(file);
  });
  promise.abort = () => xhr.abort();
  return promise;
}

// Server-sent events with our own reconnect (backoff with jitter). onResync fires after any
// reconnect so the caller can refetch what it may have missed.
export function connectEvents({ onEvent, onStatus, onResync }) {
  const NAMES = ['message', 'update', 'typing', 'read', 'presence', 'later', 'files'];
  let es = null;
  let attempt = 0;
  let timer = null;
  let opened = false;
  let dropped = false;
  let hiddenAt = 0;
  let stopped = false;
  // The server sends a "ping" every 20 s. Once one has been seen, a visible app that hears nothing for 50 s knows
  // its stream died without closing (a phone that changed networks, a relay that dropped) and opens a new one.
  let beatAt = 0;
  let sawPing = false;
  const beat = () => { beatAt = Date.now(); };

  function open() {
    clearTimeout(timer);
    if (es) es.close();
    es = new EventSource(`/api/events?client=${encodeURIComponent(CLIENT_ID)}`, { withCredentials: true });
    es.addEventListener('ping', () => { sawPing = true; beat(); });
    es.onopen = () => {
      beat();
      attempt = 0;
      onStatus?.(true);
      if (opened && dropped) onResync?.();
      opened = true;
      dropped = false;
    };
    for (const name of NAMES) {
      es.addEventListener(name, (e) => {
        let data;
        beat();
        try { data = JSON.parse(e.data); } catch { return; }
        onEvent(name, data);
      });
    }
    es.onerror = () => {
      es.close();
      es = null;
      dropped = true;
      onStatus?.(false);
      schedule();
    };
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    const base = Math.min(30000, 1000 * 2 ** attempt);
    const delay = attempt === 0 ? 400 : base * (0.6 + Math.random() * 0.4);
    attempt++;
    timer = setTimeout(async () => {
      // After a few failures, check whether the session itself is gone (EventSource hides 401s).
      if (attempt >= 3) {
        try { await api('/api/bootstrap', { timeout: 8000 }); } catch (e) { if (e.status === 401) { stopped = true; return; } }
      }
      open();
    }, delay);
  }

  function reconnectNow() {
    if (stopped) return;
    dropped = true;
    attempt = 0;
    open();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    // iOS freezes background pages; a stream that looks open may be dead. Reopen after a pause.
    if (!es || es.readyState === EventSource.CLOSED || (hiddenAt && Date.now() - hiddenAt > 20000)) reconnectNow();
  });
  setInterval(() => {
    if (stopped || !sawPing || !es || es.readyState !== EventSource.OPEN || document.visibilityState !== 'visible') return;
    if (Date.now() - beatAt > 50000) reconnectNow();
  }, 10000);
  window.addEventListener('online', reconnectNow);
  window.addEventListener('pageshow', (e) => { if (e.persisted) reconnectNow(); });

  open();
  return { reconnectNow, stop() { stopped = true; clearTimeout(timer); es?.close(); } };
}
