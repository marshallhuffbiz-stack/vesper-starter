// Harness errors (11-11): Hermes writes some of its own failures into a bot's chat as if the bot said them
// ("⚠️ The model returned only a silence marker ...", "⚠️ Cron '[bot:ben] Client watch' failed: ChatGPT plan
// sharing limit reached ... See the full run with `hermes cron runs ...`"). Those are not something a bot wrote:
// they leave the thread and become a system note (System sheet), never a bubble, a push or an unread.
//
// Narrow on purpose: the text must start with the warning sign AND match one of the shapes Hermes uses
// (hermes-agent locales/en.yaml gateway.errors.*, cron/scheduler_failure_copy.py, run_agent.py). A bot that
// writes "⚠️ Heads up: Acme's budget is almost out" still shows as itself.

const WARN = /^\s*⚠️?\s*/;

// [kind, pattern on the text after the sign, noAnswer]. noAnswer: the turn that wrote it ended without a reply,
// so the message of his it answered is marked as not answered (the red note and Send again under his bubble).
const SHAPES = [
  ['silence', /^The model returned only a silence marker for a message that needed a reply/i, true],
  ['cron', /^Cron '[^'\n]{1,160}' failed:/, false],
  ['cron', /^Scheduled job '[^'\n]{1,160}' was cut short because Hermes is/, false],
  ['model', /^(?:The AI model service (?:rejected|kept failing|isn't reachable|isn’t reachable)|The connection to the AI model service was interrupted|Hermes could not reach the AI model service|Sign-in to the AI model service failed|I couldn['’]t connect to the AI model service)/, true],
  ['model', /^(?:No response from provider for \d+s|No first stream event from provider|Provider unreachable|Provider reported usage\/credit exhaustion|Billing or credits exhausted|Rate limited — switching|Upstream \S+ rate-limited|Model returning empty responses|Model produced reasoning but no visible response|Model is repeatedly returning empty content)/, true],
  ['turn', /^(?:Something went wrong and I couldn['’]t finish this reply|Processing completed but no response was generated|Your message wasn['’]t processed \(the previous turn|Your message was interrupted before processing started|I had to stop before finishing|Turn aborted by the liveness watchdog|This turn stopped making progress|Message delivery failed after multiple attempts)/, true],
  ['turn', /^(?:This conversation has grown too long for me to read all at once|Session storage was temporarily unavailable|This session['’]s history is temporarily unavailable|I can['’]t read this conversation['’]s history right now)/, true],
  ['gateway', /^Hermes is (?:restarting|shutting down) — your current task will be interrupted/, false],
];
const PLAN = /plan sharing limit reached/i;
const RUNS = /See the full run with `hermes cron runs [0-9a-f]+`/;

const oneLine = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// What kind of harness error a bot message is, or null when a bot wrote it. Only plain text messages count:
// a card (Hermes's own "needs your OK" prompt starts with the sign too) or a file is never one.
export function harnessError(text, { buttons = null, files = 0 } = {}) {
  const raw = String(text || '');
  if (!WARN.test(raw) || (buttons && buttons.length) || files) return null;
  const body = raw.replace(WARN, '');
  const hit = SHAPES.find(([, re]) => re.test(body));
  if (!hit && !(PLAN.test(body) && /^(?:Cron|ChatGPT|The )/.test(body)) && !RUNS.test(body)) return null;
  const kind = hit ? hit[0] : RUNS.test(body) ? 'cron' : 'model';
  const plan = PLAN.test(body);
  const cron = /^Cron '([^'\n]+)' failed:\s*([\s\S]*)$/.exec(body) || /^Scheduled job '([^'\n]+)'/.exec(body);
  return { kind, plan, noAnswer: hit ? hit[2] : kind === 'model', routine: cron ? cron[1].replace(/^\[bot:[\w-]+\]\s*/, '') : null, reason: cron?.[2] ? cron[2].replace(RUNS, '').replace(/\(output saved under[^)]*\)?/, '') : null };
}

// One plain line for the System sheet. `name` is the bot's first name.
export function plainError(e, name = 'A bot') {
  if (!e) return '';
  if (e.plan) return 'The bots are paused: the shared ChatGPT plan hit its sharing limit.';
  if (e.kind === 'silence') return `${name} could not answer your message (the model gave back nothing).`;
  if (e.kind === 'cron') {
    const why = e.reason ? oneLine(e.reason.replace(/\s*\.\.\.\s*$/, ''), 140) : '';
    return `${name}'s routine${e.routine ? ` “${e.routine}”` : ''} did not finish${why ? `: ${why}` : '.'}`;
  }
  if (e.kind === 'gateway') return `Hermes restarted, so ${name}'s task at the time was cut short.`;
  if (e.kind === 'model') return `${name} could not reach the AI model, so a reply did not come.`;
  return `${name}'s turn failed before it could answer.`;
}
