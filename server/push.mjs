// Web Push with no dependencies: VAPID (RFC 8292) signed with ES256 and aes128gcm payload encryption
// (RFC 8291), all on node:crypto.

import { createECDH, createHmac, createCipheriv, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function generateVapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])), privateJwk: jwk };
}

export function vapidAuthHeader(endpoint, vapid, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject }));
  const key = createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// Encrypt `payload` for one subscription (keys.p256dh, keys.auth); returns the aes128gcm body.
export function encryptPayload(payload, keys, { salt = randomBytes(16), ecdh = null } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (!ecdh) { ecdh = createECDH('prime256v1'); ecdh.generateKeys(); }
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Send one notification. Resolves {ok, status, gone} and never throws; `gone` means the subscription
// is dead (404/410) and should be dropped.
export async function sendPush(sub, data, vapid, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  try {
    const body = encryptPayload(JSON.stringify(data), sub.keys);
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthHeader(sub.endpoint, vapid), 'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Topic: String(data.chat_id || 'holler').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'holler',
      },
      body, signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String(e?.message || e) };
  }
}
