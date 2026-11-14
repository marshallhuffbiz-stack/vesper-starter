// What the bots are set up to do, read from their own Hermes profiles: routines (cron/jobs.json), today's run
// attempts (cron/executions.db), token use per run (cron/usage_audit.jsonl) and memory (memories/*.md). Optional:
// Always rules and recent actions from an outbox database ($VESPER_OUTBOX_DB, tables always_rules and actions),
// and a revoke command for Always rules ($VESPER_REVOKE_CMD). Everything is read-only except the actions you take
// from the app: create, edit, pause, resume and run a routine (the hermes CLI) and revoke an Always rule.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BOTS, HUMAN, member } from './team.mjs';
import { HttpError } from './store.mjs';

const HOME = homedir();
// "Only message me if something needs me": appended to a quiet routine's instructions. Hermes drops a [SILENT] reply.
export const QUIET = `If nothing needs ${member(HUMAN)?.name || 'me'}, reply with only [SILENT].`;
const CRON = /^(\*|\*\/\d{1,2}|\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*)( (\*|\*\/\d{1,2}|\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*)){4}$/;

export function createHermes({
  hermesHome = process.env.HERMES_HOME || join(HOME, '.hermes'),
  outboxDb = process.env.VESPER_OUTBOX_DB || null,
  hermesBin = process.env.VESPER_HERMES_BIN || (existsSync(join(HOME, '.local', 'bin', 'hermes')) ? join(HOME, '.local', 'bin', 'hermes') : 'hermes'),
  revokeCmd = process.env.VESPER_REVOKE_CMD ? process.env.VESPER_REVOKE_CMD.split(' ') : null, // gets: <rule id>
  workdirs = process.env.VESPER_WORKDIRS || join(HOME, 'vesper-bots'),
  run = execFileP,
  now = () => Date.now(),
} = {}) {
  const prof = (botId) => {
    const m = member(botId);
    if (!m || m.kind !== 'bot' || !m.profile) throw new HttpError(404, 'no such bot');
    return join(hermesHome, 'profiles', m.profile);
  };

  function readJson(file, fallback) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  // A routine as the app shows it: name without the "[bot:ben] " tag, schedule, next and last run,
  // whether the last run worked, and the routine text (what the bot is told each time).
  function jobs(botId) {
    const raw = readJson(join(prof(botId), 'cron', 'jobs.json'), { jobs: [] });
    const list = Array.isArray(raw) ? raw : raw.jobs || [];
    return list.map((j) => ({
      id: String(j.id),
      bot: botId,
      name: String(j.name || 'Routine').replace(/^\[bot:[^\]]+\]\s*/, ''),
      schedule: j.schedule_display || j.schedule?.display || '',
      next_at: j.next_run_at || null,
      last_at: j.last_run_at || null,
      last_status: j.last_status || null,
      last_error: j.last_error ? String(j.last_error).slice(0, 240) : null,
      failures: Number(j.failure_streak) || 0,
      // A one-time routine that has run is finished, not paused (11-09: the agent page listed last week's as "Paused").
      once: j.schedule?.kind === 'once' || /^once at /.test(String(j.schedule_display || '')),
      run_at: j.schedule?.run_at || null,
      finished: j.state === 'completed',
      paused: j.state !== 'completed' && (j.state === 'paused' || j.enabled === false),
      prompt: String(j.prompt || '').replace(QUIET, '').trim().slice(0, 4000),
      quiet: String(j.prompt || '').includes(QUIET) || /reply with only \[SILENT\]/i.test(String(j.prompt || '')),
      model: j.model || null,
    }));
  }

  // Token use and time per routine from the last `days` days (the audit file is small: one line per run).
  function usage(botId, days = 7) {
    const file = join(prof(botId), 'cron', 'usage_audit.jsonl');
    const since = now() - days * 86400000;
    const midnight = new Date(now());
    midnight.setHours(0, 0, 0, 0);
    // days: the last `days` local days, oldest first, for the agent page's week chart; today: each run that
    // woke the bot today, for the Runs day strip.
    const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) { const d = new Date(midnight); d.setDate(d.getDate() - i); dayList.push({ day: dayKey(d), runs: 0, failed: 0, tokens: 0 }); }
    const byDay = new Map(dayList.map((x) => [x.day, x]));
    const out = { runs: 0, failed: 0, tokens: 0, ms: 0, byJob: {}, wokeToday: {}, days: dayList, today: [] };
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const at = Date.parse(r.ts);
      if (!(at >= since)) continue;
      const dd = byDay.get(dayKey(at));
      if (dd) { dd.runs += 1; dd.tokens += Number(r.total_tokens) || 0; if (r.error) dd.failed += 1; }
      // A run in this file is one that woke the model (a watch tick that found nothing never gets here).
      if (at >= midnight.getTime()) {
        out.wokeToday[r.job_id] = (out.wokeToday[r.job_id] || 0) + 1;
        out.today.push({ at, job_id: String(r.job_id || ''), error: !!r.error });
      }
      const j = (out.byJob[r.job_id] ||= { runs: 0, failed: 0, tokens: 0, ms: 0 });
      for (const t of [out, j]) {
        t.runs += 1;
        if (r.error) t.failed += 1;
        t.tokens += Number(r.total_tokens) || 0;
        t.ms += Number(r.duration_ms) || 0;
      }
    }
    return out;
  }

  // Today's run attempts (local midnight on), newest first.
  function runsToday(botId) {
    const file = join(prof(botId), 'cron', 'executions.db');
    if (!existsSync(file)) return [];
    const midnight = new Date(now());
    midnight.setHours(0, 0, 0, 0);
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      return db.prepare('SELECT job_id, status, claimed_at, started_at, finished_at, error FROM executions ORDER BY claimed_at DESC LIMIT 400').all()
        .filter((r) => Date.parse(r.claimed_at) >= midnight.getTime())
        .map((r) => ({ job_id: r.job_id, bot: botId, status: r.status, started_at: r.started_at || r.claimed_at, finished_at: r.finished_at, error: r.error ? String(r.error).slice(0, 200) : null }));
    } catch {
      return [];
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  function memory(botId) {
    const dir = join(prof(botId), 'memories');
    const read = (name) => {
      const f = join(dir, name);
      try { return statSync(f).size > 200000 ? '' : readFileSync(f, 'utf8').trim(); } catch { return ''; }
    };
    return { notes: read('MEMORY.md'), user: read('USER.md') };
  }

  function outbox(fn) {
    if (!outboxDb || !existsSync(outboxDb)) return [];
    let db;
    try { db = new DatabaseSync(outboxDb, { readOnly: true }); return fn(db); } catch { return []; } finally { try { db?.close(); } catch { /* ignore */ } }
  }

  function rules(botId) {
    const p = member(botId)?.profile;
    return outbox((db) => db.prepare('SELECT id, created, client_name, task_kind FROM always_rules WHERE revoked IS NULL AND bot = ? ORDER BY id').all(p)
      .map((r) => ({ id: r.id, created: Math.round(r.created * 1000), client: r.client_name || '', kind: r.task_kind })));
  }

  // The last few things this bot sent or asked for, with what happened.
  function actions(botId, limit = 8) {
    const p = member(botId)?.profile;
    return outbox((db) => db.prepare('SELECT id, created, kind, ask, client_name, target_display, status, auto, result, decided_at FROM actions WHERE bot = ? ORDER BY id DESC LIMIT ?').all(p, limit)
      .map((r) => ({ id: r.id, at: Math.round(r.created * 1000), kind: r.kind, ask: r.ask, client: r.client_name || '', to: r.target_display || '', status: r.status, auto: !!r.auto, result: r.result ? String(r.result).slice(0, 200) : '' })));
  }

  return {
    runs() {
      return {
        at: now(),
        bots: BOTS.map((b) => {
          const u = usage(b.id);
          return { id: b.id, jobs: jobs(b.id).map((j) => ({ ...j, week: u.byJob[j.id] || null, woke_today: u.wokeToday[j.id] || 0 })), week: { runs: u.runs, failed: u.failed, tokens: u.tokens }, today: runsToday(b.id), activity: u.today };
        }),
      };
    },
    agent(botId) {
      const u = usage(botId);
      return {
        id: botId,
        jobs: jobs(botId).map((j) => ({ ...j, week: u.byJob[j.id] || null })),
        week: { runs: u.runs, failed: u.failed, tokens: u.tokens, ms: u.ms },
        days: u.days,
        memory: memory(botId),
        rules: rules(botId),
        actions: actions(botId),
      };
    },
    // Memory lines (MEMORY.md, § separated) that hold any of the words, for search.
    searchMemory(terms, limit = 12) {
      const ts = (terms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
      if (!ts.length) return [];
      const out = [];
      for (const b of BOTS) {
        let notes = '';
        try { notes = memory(b.id).notes; } catch { continue; }
        for (const note of String(notes).split(/\n?§\n?/).map((x) => x.trim()).filter(Boolean)) {
          const low = note.toLowerCase();
          if (ts.some((t) => low.includes(t))) out.push({ bot: b.id, note: note.slice(0, 600) });
        }
      }
      return out.slice(0, limit);
    },
    // pause | resume | run (run = on the scheduler's next tick, within a minute).
    async act(botId, jobId, verb) {
      if (!['pause', 'resume', 'run'].includes(verb)) throw new HttpError(400, 'no such action');
      if (!jobs(botId).some((j) => j.id === jobId)) throw new HttpError(404, 'no such routine');
      await run(hermesBin, ['-p', member(botId).profile, 'cron', verb, jobId], { timeout: 60000 });
      return jobs(botId).find((j) => j.id === jobId);
    },
    // A routine you add or change from the app: name, a five-field cron line (the Mac's local time), the
    // instructions, and whether it stays quiet when nothing needs you. Named "[bot:<profile>] Name", delivered
    // to the bot's own thread, working folder <workdirs>/<profile> when that folder exists.
    async create(botId, body) {
      const r = routineFields(body, true);
      const p = member(botId)?.profile;
      prof(botId);
      const args = ['-p', p, 'cron', 'create', '--name', `[bot:${p}] ${r.name}`, '--deliver', 'holler'];
      if (existsSync(join(workdirs, p))) args.push('--workdir', join(workdirs, p));
      if (r.once) args.push('--repeat', '1');
      args.push(r.schedule, r.prompt);
      const out = await run(hermesBin, args, { timeout: 120000 });
      const m = /Created job:\s*([0-9a-f]{12})/.exec(out) || /\b([0-9a-f]{12})\b/.exec(out);
      const job = m && jobs(botId).find((j) => j.id === m[1]);
      if (!job) throw new HttpError(502, `Hermes did not confirm the routine: ${String(out).trim().split('\n').pop().slice(0, 160)}`);
      return job;
    },
    async edit(botId, jobId, body) {
      const job = jobs(botId).find((j) => j.id === jobId);
      if (!job) throw new HttpError(404, 'no such routine');
      const r = routineFields(body, false);
      const p = member(botId).profile;
      const args = ['-p', p, 'cron', 'edit', jobId];
      if (r.name) args.push('--name', `[bot:${p}] ${r.name}`);
      if (r.schedule) args.push('--schedule', r.schedule);
      if (r.prompt) args.push('--prompt', r.prompt);
      if (args.length === 5) throw new HttpError(400, 'nothing to change');
      await run(hermesBin, args, { timeout: 120000 });
      return jobs(botId).find((j) => j.id === jobId);
    },
    async revoke(ruleId) {
      const id = Number(ruleId);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad rule id');
      if (!revokeCmd) throw new HttpError(404, 'no revoke command is set up (VESPER_REVOKE_CMD)');
      const out = await run(revokeCmd[0], [...revokeCmd.slice(1), String(id)], { timeout: 30000 });
      return { ok: /"revoked"/.test(out), rule: id };
    },
  };
}

function routineFields(body, creating) {
  const b = body || {};
  const name = b.name == null ? '' : String(b.name).replace(/\s+/g, ' ').trim();
  const schedule = b.schedule == null ? '' : String(b.schedule).replace(/\s+/g, ' ').trim();
  const text = b.prompt == null ? '' : String(b.prompt).trim();
  if (creating || name) if (!name || name.length > 60 || /[\[\]]/.test(name)) throw new HttpError(400, 'Give it a short name (60 characters or fewer).');
  if (creating || schedule) if (!CRON.test(schedule)) throw new HttpError(400, 'That schedule is not a time Hermes understands.');
  if (creating || text) if (text.length < 20 || text.length > 6000) throw new HttpError(400, 'Say what it should do in a sentence or more (20 to 6000 characters).');
  const prompt = text ? (b.quiet ? `${text}\n\n${QUIET}` : text) : '';
  return { name, schedule, prompt, once: !!b.once };
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, env: { ...process.env, HOME, PATH: `${join(HOME, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` } }, (err, stdout, stderr) => {
      if (err) reject(new HttpError(502, `could not do that: ${String(stderr || err.message).trim().slice(0, 160)}`));
      else resolve(String(stdout));
    });
  });
}
