// A small, safe Markdown renderer for bot messages. Every piece of source text goes through esc()
// before it reaches the output string; the only markup produced is the fixed set of tags below.
// Links are kept only for http and https URLs.
import { esc } from './util.js';

const SAFE_URL = /^https?:\/\/[^\s<>"'`]+$/i;

function link(url, labelHtml) {
  if (!SAFE_URL.test(url)) return labelHtml;
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
}

// One combined scanner for inline syntax, applied to raw text.
const INLINE = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, //               1,2 code span
  /\[([^\]\n]+)\]\(\s*(https?:\/\/[^\s)<>]+)\s*\)/.source, //   3,4 [label](url)
  /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, //                       5   **bold**
  /(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/.source, //        6   __bold__
  /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/.source, // 7   *italic*
  /(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/.source, //  8   _italic_
  /~~(?=\S)([\s\S]*?\S)~~/.source, //                           9   ~~strike~~
  /(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}])/.source, //       10  bare URL
].join('|'), 'g');

export function inline(src) {
  let out = '';
  let last = 0;
  const re = new RegExp(INLINE.source, 'g'); // per call: inline() recurses
  let m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] != null) out += `<code>${esc(m[2].replace(/^ (.*) $/s, '$1'))}</code>`;
    else if (m[3] != null) out += link(m[4], inline(m[3]));
    else if (m[5] != null) out += `<strong>${inline(m[5])}</strong>`;
    else if (m[6] != null) out += `<strong>${inline(m[6])}</strong>`;
    else if (m[7] != null) out += `<em>${inline(m[7])}</em>`;
    else if (m[8] != null) out += `<em>${inline(m[8])}</em>`;
    else if (m[9] != null) out += `<del>${inline(m[9])}</del>`;
    else if (m[10] != null) out += link(m[10], esc(m[10]));
  }
  out += esc(src.slice(last));
  return out;
}

// Plain text with links only (The owner's own messages).
export function plain(src) {
  const text = String(src ?? '');
  let out = '';
  let last = 0;
  const re = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    out += link(m[0], esc(m[0]));
    last = re.lastIndex;
  }
  out += esc(text.slice(last));
  return out.replace(/\n/g, '<br>');
}

const LIST_RE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const code = [];
      const marker = fence[1];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i++]);
      out.push(`<pre class="md-code"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const lm = LIST_RE.exec(lines[i]);
        if (lm) {
          items.push({ indent: lm[1].replace(/\t/g, '  ').length, ordered: /\d/.test(lm[2]), start: parseInt(lm[2], 10), text: lm[3] });
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].text += `\n${lines[i].trim()}`; // continuation line
          i++;
        } else break;
      }
      i--;
      out.push(renderList(items));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); out.push(`<p class="md-h">${inline(heading[1])}</p>`); continue; }
    if (/^\s{0,3}>\s?/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      i--;
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    para.push(line);
  }
  flush();
  return out.join('');
}

function renderList(items) {
  // Build nested lists from indentation (two or more spaces deeper starts a sub-list).
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent + 1) {
      const tag = it.ordered ? 'ol' : 'ul';
      const start = it.ordered && it.start > 1 ? ` start="${it.start}"` : '';
      html += `<${tag}${start}>`;
      stack.push({ tag, indent: it.indent });
    } else {
      html += '</li>';
    }
    html += `<li>${it.text.split('\n').map(inline).join('<br>')}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

// Text for list previews and notifications: Markdown markers stripped, one line.
export function previewText(src) {
  return String(src ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
