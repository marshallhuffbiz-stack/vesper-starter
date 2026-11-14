// Vesper marks: one line glyph per bot, the app a card touches, and a plain reading of a card's text
// (title, sub line, slider verb) so a waiting card never shows ids, paths or command strings up front.
import { h } from './util.js';

const svg = (paths, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const GLYPHS = {
  compass: svg('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  mega: svg('<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8.5a5 5 0 0 1 0 7M18 5.5a9 9 0 0 1 0 13"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17M8 14h2M14 14h2M8 17h2"/>'),
  bars: svg('<path d="M5 19.5V11M10 19.5V5M15 19.5v-7M20 19.5v-4M2.5 19.5h19"/>'),
  radar: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 5.5-5.5"/><circle cx="12" cy="12" r=".9" fill="currentColor"/>'),
  people: svg('<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.9M15.5 4.1a3.5 3.5 0 0 1 0 6.8"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  chat: svg('<path d="M20 15a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>'),
  term: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15H17"/>'),
  task: svg('<path d="M9 11.5 11.5 14 20 5.5"/><path d="M20 12v6.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2H15"/>'),
  ask: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.3-2.4 3.8M12 17h.01"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  edit: svg('<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  spark: svg('<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.25 1.6 1 2.35 2.5 2.5-1.5.15-2.25.9-2.5 2.5-.25-1.6-1-2.35-2.5-2.5 1.5-.15 2.25-.9 2.5-2.5Z"/>'),
  pulse: svg('<path d="M3 12.5h3.5l2.2-5.5 4.1 11 2.6-7 1.4 1.5H21"/>', 1.8),
  phone: svg('<path d="M6.6 3.8 9 3.5l1.6 4-2 1.4a10.5 10.5 0 0 0 6.5 6.5l1.4-2 4 1.6-.3 2.4a2 2 0 0 1-2.2 1.7C10.7 18.3 5.7 13.3 4.9 6a2 2 0 0 1 1.7-2.2Z"/>'),
  doc: svg('<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10Z"/><path d="M14 3.5v5h5M9 13h6M9 16.5h4"/>'),
  photo: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>'),
};

// The team as team.json describes it (server/team.mjs), filled in by setTeam() from /api/bootstrap. The arrays
// are filled in place so modules that imported them see the update.
const BOT_GLYPH = {}; // bot id -> glyph name; a bot without an avatar shows its glyph, anyone else their initials
const AVATAR = {}; // bot id -> avatar file name in icons/agents (headset, antenna, flower, glasses, cap or your own)
const FRIEND = {}; // bot id -> the bot's color (avatar tile shadow, charts)
export const BOTS_ORDER = [];
export const TEAM = { owner: 'you', lead: null, faces: [], quietHours: [21, 8] };
export function setTeam(b) {
  const bots = (b?.members || []).filter((m) => m.kind === 'bot');
  for (const o of [BOT_GLYPH, AVATAR, FRIEND]) for (const k of Object.keys(o)) delete o[k];
  BOTS_ORDER.splice(0, BOTS_ORDER.length, ...bots.map((m) => m.id));
  for (const m of bots) { if (m.glyph && GLYPHS[m.glyph]) BOT_GLYPH[m.id] = m.glyph; if (m.avatar) AVATAR[m.id] = m.avatar; if (m.color) FRIEND[m.id] = m.color; }
  const human = (b?.members || []).find((m) => m.kind === 'human');
  TEAM.owner = human?.name || 'you';
  TEAM.lead = b?.team?.lead || BOTS_ORDER[0] || null;
  TEAM.faces = (b?.team?.room?.faces || BOTS_ORDER.slice(0, 3)).filter((id) => BOTS_ORDER.includes(id));
  if (Array.isArray(b?.team?.quietHours)) TEAM.quietHours = b.team.quietHours;
  CLIENTS.splice(0, CLIENTS.length, ...(b?.team?.clients || []).map((c) => ({ ...c, re: safeRe(c.match) })));
  CLIENT_LIST.splice(0, CLIENT_LIST.length, ...CLIENTS);
}
const safeRe = (src) => { try { return new RegExp(src, 'i'); } catch { return /$^/; } };
export const glyphFor = (id) => BOT_GLYPH[id] || null;

// Glass friends: a 3D render per avatar on a tile in the bot's color, plus mood faces: busy, perk (a card waits on
// you), sleep (quiet hours). Add your own as icons/agents/<name>.webp and <name>-busy|perk|sleep.webp.
export const MOODS = ['busy', 'perk', 'sleep'];
export const friendSrc = (id, mood = '') => (AVATAR[id] ? `icons/agents/${AVATAR[id]}${mood && MOODS.includes(mood) ? `-${mood}` : ''}.webp` : '');
export const friendFor = (id, mood = '') => (AVATAR[id] ? { src: friendSrc(id, mood), color: FRIEND[id] || '#8E8E93' } : null);
export const friendColor = (id) => FRIEND[id] || null;

// App marks: real logos (SVGL files in icons/apps) on a white tile for brands; anything without a logo is a
// colored tile with a white glyph, like an iOS app icon. A second app (Facebook and Instagram together)
// sits small on the corner.
const LOGO = {
  instagram: 'instagram', facebook: 'facebook', meta: 'meta', gmail: 'gmail', calendar: 'google-calendar', google: 'google', pay: 'stripe',
  gads: 'google-ads', maps: 'google-maps', square: 'square', zillow: 'zillow', canva: 'canva', claude: 'claude', chatgpt: 'openai',
};
const APP_NAME = {
  instagram: 'Instagram', facebook: 'Facebook', meta: 'Meta ads', gmail: 'Email', calendar: 'Calendar', google: 'Google', pay: 'Payment',
  gads: 'Google Ads', maps: 'Google listing', square: 'Square', zillow: 'Zillow', canva: 'Canva', claude: 'Claude', chatgpt: 'ChatGPT',
  bill: 'Invoice', sms: 'Text message', web: 'Website', term: 'Command', task: 'Task', ask: 'Question', learn: 'Skill', pulse: 'Monitoring',
  call: 'Call', routine: 'Routine', photo: 'Photos',
};
const APP_GLYPH = { sms: 'chat', web: 'globe', term: 'term', task: 'task', ask: 'ask', learn: 'spark', pulse: 'pulse', call: 'phone', routine: 'clock', bill: 'doc', photo: 'photo' };
export const appName = (app) => APP_NAME[app] || '';

export function appMark(app, size = 40, app2 = null) {
  const logo = LOGO[app];
  const el = h('span', { class: `appmark${logo ? '' : ` g-${app in APP_GLYPH ? app : 'task'}`}`, style: { '--s': `${size}px` }, title: APP_NAME[app] || '', 'aria-hidden': 'true' });
  if (logo) el.append(h('img', { src: `icons/apps/${logo}.svg`, alt: '', draggable: 'false', decoding: 'async' }));
  else el.innerHTML = GLYPHS[APP_GLYPH[app] || 'task'];
  if (app2 && app2 !== app) {
    const mini = appMark(app2, Math.round(size * 0.5));
    mini.classList.add('mini');
    el.classList.add('duo');
    el.append(mini);
  }
  return el;
}

// A card with pictures uses the first picture as its icon; the app it touches rides on the corner.
export function thumbMark(url, size = 40, app = null) {
  const el = h('span', { class: 'appmark thumb', style: { '--s': `${size}px` }, 'aria-hidden': 'true' },
    h('img', { src: url, alt: '', draggable: 'false', decoding: 'async', loading: 'lazy' }));
  if (app && app !== 'task' && app !== 'photo') {
    const mini = appMark(app, Math.round(size * 0.5));
    mini.classList.add('mini');
    el.classList.add('duo');
    el.append(mini);
  }
  return el;
}

// Which app a card is about, from its words: the app named first wins (the ask before the body),
// so a plan that mentions an email in passing still reads as the ad it is about.
const RULES = [
  ['instagram', /\binstagram\b|\binsta\b|\breels?\b/i],
  ['facebook', /\bfacebook\b|\bFB\b|\bmessenger\b/i],
  ['social', /\bposts?\b|\bcaptions?\b|\bstory\b|\bstories\b|\bannouncements?\b/i],
  ['gmail', /\bemails?\b|\bgmail\b|\binbox\b|\be-mail\b|\bdigest\b|\bnewsletter\b/i],
  ['meta', /\bmeta\b|ads manager|\bad ?sets?\b|\bcampaigns?\b|\bad spend\b|\bads?\b|\bbudget\b/i],
  ['gads', /google ads|\bLSA\b|search ads|local services|performance max|\bPMax\b/i],
  ['maps', /google (business )?profile|business profile|\bGBP\b|google listing|google maps|google reviews?/i],
  ['zillow', /\bzillow\b/i],
  ['canva', /\bcanva\b/i],
  ['chatgpt', /\bchatgpt\b|\bopenai\b/i],
  ['claude', /\bclaude\b/i],
  ['square', /\bSquare\b(?!\s*(feet|foot|ft|footage|inch(es)?|meters?|miles?|yards?)\b)/],
  ['bill', /\bbill\.com\b/i],
  ['pay', /\bpayment link\b|\binvoice\b|\bcheckout\b|\bstripe\b|\bpayments?\b/i],
  ['calendar', /\bcalendar\b|\bmeeting\b|\bappointment\b|\binvite\b|\bbooking\b|\bsit-?down\b/i],
  ['web', /\bwebsite\b|\bsite\b|\bhomepage\b|\blanding page\b|\bweb ?page\b|\bdomain\b|\bSEO\b/i],
  ['sms', /\btext (him|her|them|the|a|\d)|\btexts\b|\bSMS\b/i],
  ['pulse', /\bmonitor(s|ing)?\b|\buptime\b|\btime ?outs?\b|\btiming out\b|\boutage\b|\bserver\b|\balerts?\b/i],
  ['call', /\bcall(s|back|backs)?\b|\bphone\b|\bdialer\b|\bvoicemail\b/i],
];

// Every app the words name, in the order they first appear.
function detectAll(text) {
  const t = String(text || '');
  return RULES.map(([key, re]) => [key, t.search(re)]).filter(([, i]) => i >= 0).sort((x, y) => x[1] - y[1]).map(([k]) => k);
}
// "Ads" alone means Meta unless the words are about Google Ads; a social post is Facebook and Instagram.
function detect(text) {
  const all = detectAll(text);
  let app = all[0] || null;
  if (app === 'meta' && all.includes('gads') && !/\bmeta\b|ads manager|facebook/i.test(text)) app = 'gads';
  // A post on a named platform is that platform's ("post the reel on Instagram"); a plain post is both.
  if (app === 'social') return all.includes('instagram') && !all.includes('facebook') ? 'instagram' : 'facebook';
  return app;
}
export const appFor = (text) => detect(text) || 'task';

const strip = (s) => String(s || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/\*\*|__|[*_~]/g, '')
  .replace(/\s*\(#\d+\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Shorten to a phone-width title on a word boundary.
function shorten(s, n = 64) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 12)).replace(/[,;:.\s]+$/, '')}…`;
}

// Inline code, paths, versions and hashes drop out of the title; the full text keeps them under Details.
function plainify(s) {
  return s
    .replace(/`[^`]*`/g, '')
    .replace(/(?:~|\.{1,2})?\/[\w.@~\-/]+/g, '')
    .replace(/\b[\w.-]+@\d[\w.-]*\b/g, '')
    .replace(/\b[a-f0-9]{8,}\b/gi, '')
    .replace(/\s+(in|on|at|to)\s*([?.!,]|$)/gi, '$2')
    .replace(/\s+/g, ' ')
    .replace(/\s+([?.!,])/g, '$1')
    .trim();
}

const VERB = { instagram: 'post', facebook: 'post', web: 'publish', gmail: 'send', sms: 'send', term: 'run', calendar: 'book' };

// A card's plain reading: {app, title, sub, verb}. The full text stays on the card behind Details.
// Cards made from the owner's voice recordings can carry one line:
//   From your recording, Fri Oct 30, 2:14 PM (Acme check-in): “what they said”
const HEARD = /^From your recording(?:, ([^(\n]*?))?(?: \(([^)\n]*)\))?(?::\s*\u201c([^\n]*)\u201d|\.)\s*$/m;
export function heardOf(text) {
  const x = HEARD.exec(String(text || ''));
  return x ? { when: (x[1] || '').trim(), where: (x[2] || '').trim(), quote: (x[3] || '').trim() } : null;
}
const dropHeard = (s) => String(s || '').replace(HEARD, '').replace(/\n{3,}/g, '\n\n').trim();

// ── the plain card (the format an approvals service writes) ─────────────────────────────
// The owner, 11-11: cards read like "approve the blank blank blank for this blank blank blank". A card now carries
// its own context as labelled paragraphs, which come out here so the rest of the parsing sees the old shape:
//   Why: <what is going on and why now>
//   Replying to Pat, 2:51 PM: “<the message a reply answers>”
//   If you slide: <exactly what happens>
//   Cost: <plain dollars>
//   Your slide also puts it on your calendar: <when>
//   Prepared by Claude.
// and since 11-11 (one decision per outcome):
//   Updated 2:14 PM: <what changed>          a card a bot changed in place (team-act update)
//   You said, 11:42 AM: “<his words>”         his message taken as the yes (team-act --said)
//   Still needs your slide: <why>.           a said-so card his word does not cover (spending, deleting, ...)
//   Also adds Robin to Birch's HQ contacts (they wrote to you first).
const CLOCK = '(?:\\w{3} )?\\d{1,2}:\\d{2} [AP]M';
const PLAIN = [
  ['updated', new RegExp(`^Updated(?: (${CLOCK}))?:\\s+([\\s\\S]+)$`)],
  ['said', new RegExp(`^You said(?:, (${CLOCK}))?:\\s*\u201c([\\s\\S]*)\u201d$`)],
  ['held', /^Still needs your slide:\s+([\s\S]+?)\.?$/],
  ['contact', /^Also adds ([^\n]+?) to ([^\n]+?)'s HQ contacts(?: \([^)\n]*\))?\.?$/],
  ['why', /^Why:\s+([\s\S]+)$/],
  ['slide', /^If you slide:\s+([\s\S]+)$/],
  ['cost', /^Cost:\s+([\s\S]+)$/],
  ['calendar', /^Your slide also puts it on your calendar:\s+([\s\S]+)$/],
  ['claude', /^Prepared by Claude\.?$/],
  ['answers', /^Replying to ([^,:\n]{1,40})(?:, ([^\n]{1,24}?))?:\s*\u201c([\s\S]*)\u201d$/],
];
export function plainOf(text) {
  const out = {};
  const keep = [];
  for (const para of String(text || '').split(/\n\s*\n/)) {
    const t = para.trim();
    const hit = t && PLAIN.find(([, re]) => re.test(t));
    if (!hit) { keep.push(para); continue; }
    const [key, re] = hit;
    const x = re.exec(t);
    if (key === 'claude') out.claude = true;
    else if (key === 'answers') out.answers = { who: x[1].trim(), when: (x[2] || '').trim(), quote: x[3].trim() };
    else if (key === 'updated') out.updated = { when: (x[1] || '').trim(), note: x[2].trim() };
    else if (key === 'said') out.said = { when: (x[1] || '').trim(), quote: x[2].trim() };
    else if (key === 'held') out.held = cap(x[1].trim());
    else if (key === 'contact') out.contact = `${x[1].trim()} to ${x[2].trim()}`;
    else out[key] = cap(you(x[1].trim()));
  }
  return { plain: Object.keys(out).length ? out : null, rest: keep.join('\n\n').trim() };
}

export function readCard(m) {
  const raw = String(m.text || '');
  const buttons = (m.buttons || []).flat();
  const isClarify = buttons.some((b) => String(b.data || '').startsWith('cl:'));
  const isExec = buttons.some((b) => String(b.data || '').startsWith('ea:'));
  const paras = raw.replace(/^\s*(approval needed|approve\?)\s*:?\s*/i, '').split(/\n\s*\n/);
  const head = paras[0] || '';
  const { plain, rest } = plainOf(paras.slice(1).join('\n\n'));
  let client = '';
  let ask = head;
  // Approvals service: "**Client**: ask (#123)" then "Text to X:" / "Email to X" / the plan.
  const hm = head.match(/^\s*\*\*([^*]{1,60})\*\*\s*:\s*([\s\S]+)$/);
  if (hm) { client = hm[1].trim(); ask = hm[2]; }
  ask = strip(ask.split('\n')[0]);
  let app = null;
  let sub = client;
  const to = rest.match(/^(Text|Email) to ([^\n:]+)/m);
  if (to) {
    app = to[1] === 'Text' ? 'sms' : 'gmail';
    const who = person(to[2]).split(' ')[0];
    sub = [client, `to ${who}`].filter(Boolean).join(' · ');
  }
  if (!app) app = detect(ask) || detect(rest);
  if (!app && (isExec || /`[^`]+`/.test(head))) app = 'term';
  if (!app) app = isClarify ? 'ask' : 'task';
  let title = plainify(ask).replace(isClarify ? /[.!]+$/ : /[?.!]+$/, '');
  if (app === 'term' && (!title || /^(run|execute)\b/i.test(title) || title.length < 6)) {
    title = 'Run a command';
    if (!sub) sub = 'On the Mac';
  }
  title = shorten(cap(title || (isClarify ? 'Question for you' : 'Needs your OK')));
  if (!sub && (app === 'instagram' || app === 'facebook' || app === 'meta')) sub = APP_NAME[app];
  // A text the approvals service drafted ("Text to X:" then the words in quotes) can be changed before
  // it goes; `draft` is those words.
  const dm = to && to[1] === 'Text' ? /^Text to [^\n]*\n"([\s\S]*)"\s*$/m.exec(rest.split(/\n\n(?=Sending|Quiet hours|Held|Not sent)/)[0]) : null;
  const draft = dm && buttons.some((b) => /^a\|\d+\|/.test(String(b.data || ''))) ? dm[1] : null;
  const app2 = pairOf(app, `${ask} ${rest}`);
  const sealed = /^Sealed: ([^\n]{1,60})$/m.exec(raw)?.[1]?.trim() || null;
  return { app, app2, title, sub, verb: VERB[app] || 'approve', clarify: isClarify, draft, content: readTask(m)?.content || null, heard: heardOf(rest), sealed, plain, sends: sendsOf(raw, buttons) };
}

// When a card with a Stop button sends on its own (an auto reply, or since 11-11 what he told a bot to send), in
// his words: "Sends in 2 min unless you tap Stop", "Sends at 8:00 AM unless you tap Stop".
function sendsOf(raw, buttons) {
  if (!buttons.some((b) => /^s\|\d+\|/.test(String(b.data || '')))) return null;
  const last = String(raw).trim().split(/\n\s*\n/).at(-1) || '';
  let x;
  if ((x = /^Sending in (\d+) min\b/.exec(last))) return `Sends in ${x[1]} min unless you tap Stop`;
  if ((x = /^(?:Quiet hours: sending|Sending) at (\d{1,2}:\d{2} [AP]M)/.exec(last))) return `Sends at ${x[1]} unless you tap Stop`;
  return null;
}

// Facebook and Instagram usually go together: the other one rides on the corner of the mark.
export function pairOf(app, text) {
  const other = { facebook: 'instagram', instagram: 'facebook' }[app];
  const all = detectAll(text);
  if (app === 'facebook' && all[0] === 'social' && !all.includes('facebook')) return 'instagram';
  return other && all.includes(other) ? other : null;
}

// ── tasks ────────────────────────────────────────────────────────────────────────────────────────
// Every message the approvals service writes has one shape (see the plain card above):
//   [Doing: |Auto reply: |Learn: ]**Client**: what it is (#id)
//   then "Text to Name (ends 1234):" + "the words" | "Email to Name" + "Subject: ..." + "the words" |
//   the plan's plain summary (working detail under "Details:")
//   then a status line once something happens ("Sent on its own. ...", "Not sent: ...", "Withdrawn ...").
// readTask turns that into what the owner needs: the app, a plain title, who it is for, the actual words,
// and where it stands. Ids, hashes, phone endings and readback receipts stay behind Details.
const HEAD = /^\s*(?:(Doing|Auto reply|Learn|Approve\?)\s*:\s*)?(?:\*\*([^*\n]{1,80})\*\*\s*:\s*)?([^\n]+?)\s*\(#(\d+)\)\s*$/;
const STATUS = /^(Quiet hours:|Sending in \d+ min|Sending\.\.\.|Sent on its own\.|Sent\.|Probably sent\.|Not sent[.:]|Held for your tap:|Approved\.|Done\.|Done by [^.\n]+\.|\S+ could not finish it\.|Stopped by the owner|Expired without a tap|Withdrawn|Saved\.|Routine is on|Not created:|Hermes did not take it)/;
// A sentence that is a receipt for the bots, not news for the owner.
const RECEIPT = /readback|exact-ID|\bBackup:|payload|\bsha(256)?\b|\bhash(es)?\b|\bstdout\b|\bexit code\b|\bcommit\b|\.(py|mjs|js|json|md|sh)\b|\bpid\b|\bQUEUE\b|\bTemporal\b|byte-exact|\breceipt\b|\bHTTP ?\d{3}|\bMCP\b|inverse patch|runtime policy|#\d+|\bmain and origin\b|\b(ids?|IDs?)\b|\bgit\b|\bbranch\b|\brepo\b|\bdiff\b/i;
// A finished task's result line is worth showing only when it says what happened in plain words.
const NEWS = /^(Texted|Emailed|Called|Posted|Published|Scheduled|Booked|Replied|Moved|Added|Created|From now on)\b/;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const you = (s) => { const n = esc(TEAM.owner); return s.replace(new RegExp(`\\b${n}'s\\b`, 'g'), 'your').replace(new RegExp(`\\b${n}[- ](decision|tap|approval|review|go|OK)\\b`, 'g'), 'your $1').replace(new RegExp(`\\b${n}\\b`, 'g'), 'you'); };

// One line of plain words: no phone endings, UTC stamps, error codes, ids, paths or hashes.
export function tidy(s) {
  return you(plainify(strip(s)
    .replace(/\s*\(ends \d{3,4}\)/g, '')
    .replace(/,?\s*sent, delivery not confirmed yet\s*\(\w+\)/gi, '')
    .replace(/\s*\((?:DB,\s*)?\d{1,2}:\d{2}Z\)/g, '')
    .replace(/\s*\(-?\d{3,}\)/g, '')
    .replace(/\s*\((?:RCS|SMS|MMS|iMessage)\)/g, '')
    .replace(/\s*\([^)]*\b(board|task|card|commit|sha|id)\b[^)]*\)/gi, '')
    .replace(/\bt[0-9a-f]{7,}\b/g, '')
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{16,}\b/gi, '')
    .replace(/,?\s*\b(HQ )?client ?\d+\b/gi, '')))
    .replace(/\s+([,.;:])/g, '$1').replace(/([,;:])\1+/g, '$1').trim();
}

// The first sentence or two that say something, as plain words.
export function gist(s, max = 220) {
  const para = String(s || '').trim().split(/\n\s*\n/)[0] || '';
  const keep = [];
  for (const x of para.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)) {
    if (RECEIPT.test(x)) continue;
    const t = tidy(x).replace(/^[,;:\s]+/, '');
    if (t.split(/\s+/).length < 3) continue;
    keep.push(t);
    if (keep.length === 2 || keep.join(' ').length > max * 0.6) break;
  }
  return shorten(cap(keep.join(' ')), max);
}

const words = (name) => String(name || '').split(/,\s*/).map((n) => n.replace(/[-_]+/g, ' ').trim()).filter(Boolean);
const initials = (s) => String(s || '').split(/\s+/).filter((w) => /^[A-Z0-9]/.test(w)).map((w) => w[0]).join('');

// "Fjord: morning check" under Fjord Garage Doors reads as "Morning check".
export function taskTitle(ask, client) {
  let t = strip(ask);
  const nick = /^([^:]{1,24}):\s+(.+)$/.exec(t);
  const c = String(client || '').toLowerCase();
  if (nick && c && (c.includes(nick[1].toLowerCase()) || initials(client).toUpperCase() === nick[1].replace(/\W/g, '').toUpperCase())) t = nick[2];
  return cap(you(plainify(t)).replace(/[.!]+$/, ''));
}

const person = (to) => strip(to).replace(/\s*\(ends \d{3,4}\)/g, '').replace(/:$/, '').trim();

// Where a task stands: {tone: ok|busy|wait|warn|bad|off, label, note}.
function standing(line, verb, m) {
  const L = String(line || '').trim();
  const st = (tone, label, note = '') => {
    let n = note ? gist(String(note).split(/(?<=[.!?])\s+(?=[A-Z])/)[0], 140) : '';
    if (tone === 'ok' && !NEWS.test(n)) n = '';
    return { tone, label, note: n };
  };
  let x;
  if (!L) {
    if (m.buttons?.length && !m.resolved) return null;
    if (m.resolved?.change) return st('busy', 'Changed', m.resolved.change);
    if (m.resolved) return /^(deny|denied|reject|decline|cancel|no\b|stop)/i.test(m.resolved.label || '') ? st('off', 'Declined') : st('ok', 'Approved');
    if (verb === 'Doing') return st('busy', 'Working on it');
    if (verb === 'Auto reply') return st('wait', 'Queued');
    return null;
  }
  if ((x = /^Quiet hours: sending at (\d{1,2}:\d{2} [AP]M)/i.exec(L))) return st('wait', `Sends at ${x[1]}`);
  if ((x = /^Sending in (\d+) min/.exec(L))) return st('wait', `Sends in ${x[1]} min`);
  if (/^Sending\.\.\./.test(L)) return st('busy', 'Sending');
  if ((x = /^Sent on its own\.\s*([\s\S]*)$/.exec(L))) return st('ok', 'Sent on its own', x[1]);
  if ((x = /^Sent\.\s*([\s\S]*)$/.exec(L))) return st('ok', 'Sent', x[1]);
  if ((x = /^Probably sent\.\s*([\s\S]*)$/.exec(L))) return st('warn', 'Probably sent', x[1]);
  if ((x = /^Not sent\. (?:You|\S+) changed it:?\s*([\s\S]*)$/.exec(L))) return st('busy', 'Changed', x[1].replace(/^\u201c([\s\S]*?)\u201d\s*/, '$1. ').trim());
  if (/^Not sent\. (?:You|\S+) said no/.test(L)) return st('off', 'Declined');
  if ((x = /^Not sent[.:]\s*([\s\S]*)$/.exec(L))) return st('bad', 'Not sent', x[1]);
  if ((x = /^Held for your tap:\s*([\s\S]*)$/.exec(L))) return st('wait', 'Waiting on you', x[1]);
  if ((x = /^Approved\.\s*([\s\S]*)$/.exec(L))) return st('ok', 'Approved', x[1]);
  if ((x = /^Done(?: by [^.\n]+)?\.\s*([\s\S]*)$/.exec(L))) return st('ok', 'Done', x[1]);
  if ((x = /^\S+ could not finish it\.\s*([\s\S]*)$/.exec(L))) return st('bad', "Couldn't finish", x[1]);
  if (/^Stopped by (?:you|\S+)/.test(L)) return st('off', 'Stopped', 'Nothing was sent.');
  if (/^Expired/.test(L)) return st('off', 'Expired');
  if ((x = /^Withdrawn(?: by the bot)?[.:]?\s*([\s\S]*)$/.exec(L))) return st('off', 'Withdrawn', x[1]);
  if (/^Saved\./.test(L)) return st('ok', 'Saved');
  if (/^Routine is on/.test(L)) return st('ok', 'Routine is on');
  return st('bad', 'Not done', L.replace(/^(Not created|Hermes did not take it):?\s*/, ''));
}

// A finished plan's receipt (approvals service receipt_line, 10-31):
//   Done by Dora in 12 min. <proof>
//   Changed: <old -> new>
//   Undo: <how to put it back>          or   Undo asked: Dora is putting it back (#95).
export function receiptOf(line) {
  const L = String(line || '');
  const x = /^Done by ([^.\n]+?)(?: in ([^.\n]+))?\.[ \t]*([^\n]*)/.exec(L);
  if (!x) return null;
  const get = (re) => (re.exec(L)?.[1] || '').trim();
  const asked = get(/^Undo asked: ([^\n]+)$/m);
  return { who: x[1].trim(), took: (x[2] || '').trim(), proof: tidy(x[3] || ''), change: get(/^Changed: ([^\n]+)$/m).replace(/\s*->\s*/g, ' \u2192 '),
    undo: asked ? '' : get(/^Undo: ([^\n]+)$/m), asked: asked.replace(/\s*\(#\d+\)\.?$/, '.') };
}

// null when the message is not a task (a bot just talking).
export function readTask(m) {
  const raw = String(m.text || '').trim();
  if (!raw) return null;
  // Hermes's own note after a bot sharpens its skills.
  const sk = /^💾\s*Self-improvement review:\s*([\s\S]+)$/.exec(raw);
  if (sk) {
    const names = [...new Set([...sk[1].matchAll(/Skill '([^']+)'/g)].map((x) => words(x[1])[0]))];
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    return { id: null, verb: 'Learn', app: 'learn', app2: null, title: names.length > 1 ? 'Sharpened its skills' : 'Sharpened a skill', sub: '',
      content: list ? { type: 'note', body: cap(list) } : null, status: { tone: 'ok', label: 'Saved', note: '' }, more: false };
  }
  const nl = raw.indexOf('\n');
  const hm = HEAD.exec(nl < 0 ? raw : raw.slice(0, nl));
  if (!hm) return null;
  const [, verb = '', clientRaw = '', ask, id] = hm;
  const pl = plainOf(nl < 0 ? '' : raw.slice(nl + 1).trim());
  const plain = pl.plain;
  let rest = pl.rest;
  const paras = rest.split(/\n\s*\n/);
  let line = '';
  if (paras.length && STATUS.test(paras[paras.length - 1].trim())) { line = paras.pop().trim(); rest = paras.join('\n\n').trim(); }
  const client = strip(clientRaw).replace(/^Lead:\s*/i, '');
  let content = null;
  let to = '';
  let x;
  if ((x = /^Text to ([^\n]+?):\s*\n"([\s\S]*)"\s*$/.exec(rest))) { to = person(x[1]); content = { type: 'sms', body: x[2].trim() }; }
  else if ((x = /^Email to ([^\n]+)\nSubject: ([^\n]*)\n"([\s\S]*)"\s*$/.exec(rest))) { to = person(x[1]); content = { type: 'email', subject: strip(x[2]), body: x[3].trim() }; }
  else {
    let body = dropHeard(rest).replace(/^(Plan|Details):\s*\n/, '');
    const cut = body.search(/\n\s*\nDetails:\s*\n/);
    if (cut >= 0) body = body.slice(0, cut);
    if (verb === 'Learn') body = body.replace(/^[^.]*\bwants to (save|update)[^.]*\.\s*/i, '');
    // The plain card's Why is written for him already (team-act checks it); otherwise the plan's first sentences.
    const note = plain?.why || gist(body);
    content = note ? { type: 'note', body: note } : null;
  }
  let title;
  let app;
  if (verb === 'Learn') {
    const names = words(ask);
    const fresh = /save a new skill/i.test(raw);
    title = `${fresh ? 'New skill' : 'Skill update'}: ${cap(names.join(', '))}`;
    app = 'learn';
  } else {
    title = taskTitle(ask, clientRaw.replace(/^Lead:\s*/i, ''));
    if (!title || title.toLowerCase() === client.toLowerCase()) title = content?.type === 'sms' ? `Text to ${to.split(' ')[0]}` : content?.type === 'email' ? `Email to ${to.split(' ')[0]}` : client || 'Task';
    const said = `${title} ${content?.type === 'note' ? content.body : ''}`;
    app = content?.type === 'sms' ? 'sms' : content?.type === 'email' ? 'gmail'
      : /Schedule \([A-Za-z ]+\)/.test(raw) ? 'routine' : detect(said) || (/`[^`]+`/.test(ask) ? 'term' : 'task');
  }
  const app2 = pairOf(app, `${title} ${content?.body || ''}`);
  const sub = [client && client !== 'Team' ? client : '', to ? `to ${client ? to.split(' ')[0] : to}` : ''].filter(Boolean).join(' · ');
  let status = standing(line, verb, m);
  if (verb === 'Learn' && status?.tone === 'ok') status = { tone: 'ok', label: 'Saved', note: '' };
  // Details only when there is more than the card shows (a plan's working detail, a receipt).
  const shownAll = content && content.type !== 'note' && !/\n\s*\nDetails:/.test(raw);
  return { id: Number(id), verb, app, app2, title: shorten(title, 72), sub, content, status, more: !shownAll || RECEIPT.test(line), heard: heardOf(rest), receipt: receiptOf(line), plain };
}

// ── clients ──────────────────────────────────────────────────────────────────────────────────────
// Optional (team.json "clients"): each client's mark, so a card, a bot's name and the agent page read at a glance
// the way the app logos do. A logo is icons/clients/<logo>.webp; without one the client gets a quiet initial.
const CLIENTS = [];
export const CLIENT_LIST = [];
export const clientByKey = (key) => CLIENTS.find((c) => c.key === key) || null;
export function clientOf(name) {
  const s = String(name || '').trim();
  return s ? CLIENTS.find((c) => c.re.test(s)) || null : null;
}

export function clientMark(c, size = 20) {
  const cl = typeof c === 'string' ? clientOf(c) : c;
  if (!cl) return null;
  const el = h('span', { class: `clmark${cl.fill ? ' fill' : ''}${cl.logo ? '' : ' plain'}`, style: { '--s': `${size}px` }, title: cl.short, 'aria-hidden': 'true', dataset: { client: cl.key } });
  if (cl.logo) el.append(h('img', { src: `icons/clients/${cl.logo}.webp`, alt: '', draggable: 'false', decoding: 'async' }));
  else if (cl.glyph) el.innerHTML = GLYPHS[cl.glyph];
  else el.append(h('span', {}, cl.initial));
  return el;
}

// A bot's clients as small overlapping marks (chat list) or as marks with their short names (thread header).
export function clientStack(names, size = 18) {
  const list = (names || []).map(clientOf).filter(Boolean);
  if (!list.length) return null;
  return h('span', { class: 'clstack', 'aria-label': list.map((c) => c.short).join(', ') }, ...list.map((c) => clientMark(c, size)));
}
export function clientChips(names, size = 16) {
  const list = (names || []).map((n) => ({ n, c: clientOf(n) }));
  if (!list.length) return null;
  return h('span', { class: 'clchips' }, ...list.map(({ n, c }) => h('span', { class: 'clchip' }, c ? clientMark(c, size) : null, h('span', {}, c ? c.short : n))));
}

// A card's sub line ("Acme Pressure Washing · to Pat") with the client's mark in front of it.
export function subLine(sub, cls = 'ap-sub', size = 16) {
  if (!sub) return null;
  const first = String(sub).split(' · ')[0];
  const mark = clientMark(first, size);
  return h('div', { class: `${cls}${mark ? ' has-cl' : ''}` }, mark, h('span', {}, sub));
}

// ── card chips ───────────────────────────────────────────────────────────────────────────────────
// "card #91" in a bot's message becomes a chip with the card's app and its plain title; tapping it opens
// the card. Works on the renderer's HTML: only text outside tags, and never inside a link or code.
const CARD_REF = /\b[Cc]ards?\s+#(\d{1,6})((?:(?:,\s*|,?\s+(?:and|or)\s+)#\d{1,6})*)/g;
export function cardIdOf(m) {
  const first = String(m?.text || '').split('\n')[0];
  const x = /\(#(\d+)\)\s*$/.exec(first);
  return x ? Number(x[1]) : null;
}
export function chipCards(html, lookup) {
  if (!/[Cc]ards?\s+#\d/.test(html)) return html;
  let skip = 0;
  return html.split(/(<[^>]+>)/).map((part, i) => {
    if (i % 2) {
      if (/^<(a|code|pre)\b/i.test(part)) skip++;
      else if (/^<\/(a|code|pre)>/i.test(part)) skip = Math.max(0, skip - 1);
      return part;
    }
    if (skip) return part;
    return part.replace(CARD_REF, (all, first, more) => {
      const ids = [first, ...[...more.matchAll(/#(\d+)/g)].map((x) => x[1])];
      return ids.map((id) => cardChip(Number(id), lookup(Number(id)))).join(' ');
    });
  }).join('');
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function cardChip(id, info) {
  const mark = appMark(info?.app || 'task', 18);
  const label = info?.title ? shorten(info.title, 34) : 'Card';
  return `<button type="button" class="cref" data-card="${id}">${mark.outerHTML}<span>${escHtml(label)}</span></button>`;
}
