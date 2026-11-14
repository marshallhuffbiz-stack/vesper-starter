// Picture previews (11-06, the owner: "the way we get pictures is always laggy and takes too long"). Bots send
// 1-2 MB PNGs (often four at once) and the phone reaches the Mac through a Tailscale relay, so the app shows a
// preview made here instead: at most 840 x 1400 (2.5x the biggest place a picture shows), JPEG, about a fifth to
// a tenth of the original. Tapping a picture still opens the original. Previews live in data/previews (rebuilt
// on demand, so backups leave them out); macOS's own sips makes them, nothing to install.
import { execFile } from 'node:child_process';
import { openSync, readSync, closeSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const PREVIEW_W = 840;
export const PREVIEW_H = 1400;
const SMALL_BYTES = 250 * 1024; // an original this small that already fits the box is sent as it is
const SIPS = '/usr/bin/sips';

// Does the app get a preview for this file? Pure, so the store can say which URL to use without touching disk.
export function wantsPreview(f) {
  if (!f || !/^image\//.test(f.type) || f.type === 'image/gif') return false; // a GIF keeps its animation
  if (f.type === 'image/heic') return true; // browsers other than Safari cannot show HEIC at all
  if (!f.width || !f.height) return (f.size || 0) > SMALL_BYTES;
  return (f.size || 0) > SMALL_BYTES || f.width > PREVIEW_W || f.height > PREVIEW_H;
}

// Width and height as a browser shows the picture (a JPEG's EXIF rotation applied), and whether a PNG has
// transparency, from the first bytes of the file. PNG, JPEG, GIF and WebP; null for anything else.
export function imageSize(path) {
  let buf;
  try {
    const fd = openSync(path, 'r');
    try { buf = Buffer.alloc(Math.min(512 * 1024, statSync(path).size)); readSync(fd, buf, 0, buf.length, 0); }
    finally { closeSync(fd); }
  } catch { return null; }
  return sizeOf(buf);
}

export function sizeOf(b) {
  if (b.length >= 26 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 4 || b[25] === 6 || pngChunk(b, 'tRNS') };
  }
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), alpha: true };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), alpha: !!(b[20] & 0x10) };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff), alpha: true }; }
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, alpha: false };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2, turn = false;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xe1 && b.toString('ascii', i + 4, i + 8) === 'Exif') turn = exifTurned(b, i + 10, len - 8);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7);
        return turn ? { w: h, h: w, alpha: false } : { w, h, alpha: false };
      }
      i += 2 + len;
    }
  }
  return null;
}

// A PNG chunk before the image data (tRNS: a see-through color).
function pngChunk(b, want) {
  let i = 8;
  while (i + 8 <= b.length) {
    const type = b.toString('ascii', i + 4, i + 8);
    if (type === want) return true;
    if (type === 'IDAT') return false;
    i += 12 + b.readUInt32BE(i);
  }
  return false;
}

// EXIF orientation 5 to 8 means the camera stored the picture on its side.
function exifTurned(b, start, len) {
  try {
    const le = b.toString('ascii', start, start + 2) === 'II';
    const u16 = (o) => (le ? b.readUInt16LE(start + o) : b.readUInt16BE(start + o));
    const u32 = (o) => (le ? b.readUInt32LE(start + o) : b.readUInt32BE(start + o));
    const ifd = u32(4);
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > len) break;
      if (u16(e) === 0x0112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
    }
  } catch { /* no usable EXIF */ }
  return false;
}

export function createMedia({ filesDir, previewDir, log = () => {}, sips = SIPS }) {
  const pending = new Map();
  const previewPath = (id) => join(previewDir, `${id}.p`);

  // The preview's path, made on first ask (once, however many ask at the same time); null = send the original.
  function ensure(f) {
    if (!f || !/^[a-f0-9]{32}$/.test(f.id) || !wantsPreview(f)) return Promise.resolve(null);
    const out = previewPath(f.id);
    if (existsSync(out)) return Promise.resolve(out);
    if (pending.has(f.id)) return pending.get(f.id);
    const job = make(f, out).finally(() => pending.delete(f.id));
    pending.set(f.id, job);
    return job;
  }

  function make(f, out) {
    const src = join(filesDir, f.id);
    if (!existsSync(src)) return Promise.resolve(null);
    mkdirSync(previewDir, { recursive: true, mode: 0o700 });
    const dims = f.width && f.height ? { w: f.width, h: f.height } : imageSize(src);
    // -Z caps the longest side and keeps the shape, whichever way the camera stored it.
    const scale = dims ? Math.min(1, PREVIEW_W / dims.w, PREVIEW_H / dims.h) : 1;
    const maxSide = dims ? Math.max(1, Math.round(Math.max(dims.w, dims.h) * scale)) : PREVIEW_H;
    // A PNG with see-through parts stays a PNG (JPEG has no transparency); everything else becomes a JPEG.
    const png = f.type === 'image/png' && (dims?.alpha ?? imageSize(src)?.alpha);
    const tmp = `${out}.${process.pid}.tmp`;
    const args = ['-Z', String(maxSide), '-s', 'format', png ? 'png' : 'jpeg', ...(png ? [] : ['-s', 'formatOptions', '76']), src, '--out', tmp];
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(sips, args, { timeout: 20000 }, (err) => {
        try {
          if (err || !existsSync(tmp)) throw err || new Error('no output');
          // Never send a "preview" bigger than the picture itself.
          if (statSync(tmp).size >= (f.size || statSync(src).size)) { unlinkSync(tmp); resolve(null); return; }
          renameSync(tmp, out);
          log(`preview ${f.id.slice(0, 8)} ${Math.round((f.size || 0) / 1024)} KB -> ${Math.round(statSync(out).size / 1024)} KB in ${Date.now() - started} ms`);
          resolve(out);
        } catch (e) {
          try { unlinkSync(tmp); } catch { /* nothing written */ }
          log(`preview failed ${f.id.slice(0, 8)}: ${e?.message || e}`);
          resolve(null);
        }
      });
    });
  }

  // What kind of bytes a preview holds (it is a PNG only when the picture had transparency).
  function previewType(path) {
    try {
      const fd = openSync(path, 'r');
      const b = Buffer.alloc(4);
      try { readSync(fd, b, 0, 4, 0); } finally { closeSync(fd); }
      return b.readUInt32BE(0) === 0x89504e47 ? 'image/png' : 'image/jpeg';
    } catch { return 'image/jpeg'; }
  }

  return { ensure, previewPath, previewType };
}
