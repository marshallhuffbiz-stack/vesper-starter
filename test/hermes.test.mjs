import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHermes, QUIET } from '../server/hermes.mjs';

// A fake ~/.hermes with Ben's profile (ben) and a team outbox: routines, a run, token use, memory, a rule.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'holler-hermes-'));
  const cron = join(dir, 'profiles', 'ben', 'cron');
  mkdirSync(cron, { recursive: true });
  mkdirSync(join(dir, 'profiles', 'ben', 'memories'));
  writeFileSync(join(cron, 'jobs.json'), JSON.stringify({ jobs: [
    { id: 'abc123def456', name: '[bot:ben] Morning sweep', schedule_display: '50 7 * * 1-5', next_run_at: '2026-10-30T07:50:00-04:00', last_run_at: '2026-10-29T07:54:00-04:00', last_status: 'ok', failure_streak: 0, state: 'scheduled', enabled: true, prompt: 'Morning sweep.' },
    { id: 'abc123def457', name: '[bot:ben] Birch check', schedule_display: '30 11 * * *', last_status: 'error', last_error: 'timed out', failure_streak: 2, state: 'paused', enabled: true, prompt: 'Birch.' },
  ] }));
  const now = Date.parse('2026-10-29T16:00:00-04:00');
  writeFileSync(join(cron, 'usage_audit.jsonl'), [
    { ts: '2026-10-29T11:54:00Z', job_id: 'abc123def456', total_tokens: 120000, duration_ms: 40000, error: null },
    { ts: '2026-10-28T11:54:00Z', job_id: 'abc123def456', total_tokens: 80000, duration_ms: 30000, error: null },
    { ts: '2026-10-29T15:30:00Z', job_id: 'abc123def457', total_tokens: 5000, duration_ms: 9000, error: 'timed out' },
    { ts: '2026-10-01T11:54:00Z', job_id: 'abc123def456', total_tokens: 999999, duration_ms: 1, error: null },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const ex = new DatabaseSync(join(cron, 'executions.db'));
  ex.exec(`CREATE TABLE executions (id TEXT, job_id TEXT, source TEXT, process_id TEXT, pid INTEGER, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT, error TEXT)`);
  ex.prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?)').run('e1', 'abc123def456', 'cron', 'p', 1, 'completed', '2026-10-29T07:50:20-04:00', '2026-10-29T07:50:21-04:00', '2026-10-29T07:54:00-04:00', null);
  ex.prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?)').run('e0', 'abc123def456', 'cron', 'p', 1, 'completed', '2026-10-28T07:50:20-04:00', null, null, null);
  ex.close();
  writeFileSync(join(dir, 'profiles', 'ben', 'memories', 'MEMORY.md'), 'Acme prefers calls after 3 PM.\n§\nCedar posts at 7:30 PM.');
  const ob = new DatabaseSync(join(dir, 'outbox.db'));
  ob.exec('CREATE TABLE always_rules (id INTEGER PRIMARY KEY, created REAL, bot TEXT, client_id INTEGER, client_name TEXT, task_kind TEXT, source_action INTEGER, revoked REAL, revoked_why TEXT)');
  ob.exec('CREATE TABLE actions (id INTEGER PRIMARY KEY, created REAL, bot TEXT, ask TEXT, kind TEXT, client_name TEXT, target_display TEXT, status TEXT, auto INTEGER, result TEXT, decided_at REAL)');
  ob.prepare('INSERT INTO always_rules (created, bot, client_id, client_name, task_kind) VALUES (?,?,?,?,?)').run(1761700000, 'ben', 3, 'Cedar Wellness', 'posts');
  ob.prepare('INSERT INTO always_rules (created, bot, client_id, client_name, task_kind, revoked) VALUES (?,?,?,?,?,?)').run(1761700000, 'ben', 4, 'Acme', 'ads', 1761800000);
  ob.prepare('INSERT INTO actions (created, bot, ask, kind, client_name, target_display, status, auto, result) VALUES (?,?,?,?,?,?,?,?,?)').run(1761700000, 'ben', 'Lighting end date', 'text', 'Acme', 'Pat', 'done', 0, 'Texted Pat.');
  ob.close();
  return { dir, now };
}

test('routines, the week, today, memory, rules and actions come from the bot profile and the outbox', () => {
  const { dir, now } = fixture();
  try {
    const calls = [];
    const hermes = createHermes({ hermesHome: dir, outboxDb: join(dir, 'outbox.db'), revokeCmd: ['revoke-rule'], now: () => now, run: async (cmd, args) => { calls.push([cmd, ...args]); return '{"ok": true, "rule": 1, "status": "revoked"}'; } });
    const a = hermes.agent('ben');
    assert.deepEqual(a.jobs.map((j) => j.name), ['Morning sweep', 'Birch check'], 'the [bot:] tag is dropped');
    assert.equal(a.jobs[1].paused, true);
    assert.equal(a.jobs[1].failures, 2);
    assert.deepEqual(a.week, { runs: 3, failed: 1, tokens: 205000, ms: 79000 }, 'only the last 7 days count');
    assert.equal(a.jobs[0].week.tokens, 200000);
    assert.equal(a.memory.notes.split('§').length, 2);
    assert.deepEqual(a.rules.map((r) => r.client), ['Cedar Wellness'], 'revoked rules are left out');
    assert.equal(a.actions[0].ask, 'Lighting end date');
    const runs = hermes.runs();
    const ben = runs.bots.find((b) => b.id === 'ben');
    assert.equal(ben.today.length, 1, 'only today\'s attempts');
    assert.equal(runs.bots.find((b) => b.id === 'dora').jobs.length, 0, 'a profile with no routines is empty, not an error');
    return Promise.all([
      hermes.act('ben', 'abc123def456', 'pause').then(() => assert.deepEqual(calls[0].slice(1), ['-p', 'ben', 'cron', 'pause', 'abc123def456'])),
      assert.rejects(hermes.act('ben', 'ffffffffffff', 'run'), /no such routine/),
      assert.rejects(hermes.act('ben', 'abc123def456', 'remove'), /no such action/),
      assert.rejects(() => Promise.resolve().then(() => hermes.agent('alex')), /no such bot/),
      hermes.revoke('1').then((r) => assert.deepEqual(r, { ok: true, rule: 1 })),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a routine added or changed from the app goes to hermes cron create/edit in the team shape', async () => {
  const { dir, now } = fixture();
  const jobsFile = join(dir, 'profiles', 'ben', 'cron', 'jobs.json');
  try {
    const calls = [];
    // The fake Hermes adds the job to jobs.json the way the real one does and prints its confirmation.
    const run = async (cmd, args) => {
      calls.push(args);
      if (args[3] === 'create') {
        const d = JSON.parse(readFileSync(jobsFile, 'utf8'));
        const at = args.indexOf('--name');
        d.jobs.push({ id: 'fedcba987654', name: args[at + 1], schedule_display: args.at(-2), state: 'scheduled', enabled: true, prompt: args.at(-1) });
        writeFileSync(jobsFile, JSON.stringify(d));
        return 'warning: cache 0123456789ab is old\nCreated job: fedcba987654\n';
      }
      return '';
    };
    mkdirSync(join(dir, 'w', 'ben'), { recursive: true });
    const hermes = createHermes({ hermesHome: dir, outboxDb: join(dir, 'outbox.db'), workdirs: join(dir, 'w'), now: () => now, run });
    const job = await hermes.create('ben', { name: '  Friday   recap ', schedule: '0 15 * * 5', prompt: 'Pull the week and tell me cost per lead.', quiet: true });
    assert.deepEqual(calls[0], ['-p', 'ben', 'cron', 'create', '--name', '[bot:ben] Friday recap', '--deliver', 'holler', '--workdir', join(dir, 'w', 'ben'), '0 15 * * 5', `Pull the week and tell me cost per lead.\n\n${QUIET}`]);
    assert.equal(job.id, 'fedcba987654', 'the id comes from the "Created job" line, not the first hex in the output');
    assert.equal(job.name, 'Friday recap');
    assert.equal(job.quiet, true);
    assert.equal(job.prompt, 'Pull the week and tell me cost per lead.', 'the quiet line is hidden from the instructions');

    await hermes.create('ben', { name: 'Once', schedule: '30 9 2 11 *', prompt: 'Remind me about the Birch call today.', once: true });
    assert.deepEqual(calls[1].slice(10, 12), ['--repeat', '1'], 'Once runs a single time');

    await assert.rejects(hermes.create('ben', { name: 'x [bot] y', schedule: '0 9 * * *', prompt: 'Twenty characters or more here.' }), /short name/);
    await assert.rejects(hermes.create('ben', { name: 'Ok', schedule: 'every day', prompt: 'Twenty characters or more here.' }), /schedule/);
    await assert.rejects(hermes.create('ben', { name: 'Ok', schedule: '0 9 * * *', prompt: 'too short' }), /sentence or more/);
    await assert.rejects(hermes.create('alex', { name: 'Ok', schedule: '0 9 * * *', prompt: 'Twenty characters or more here.' }), /no such bot/);
    assert.equal(calls.length, 2, 'bad input never reaches Hermes');

    await hermes.edit('ben', 'abc123def456', { name: 'Morning sweep', schedule: '45 7 * * 1-5', prompt: 'Morning sweep, shorter.', quiet: false });
    assert.deepEqual(calls[2], ['-p', 'ben', 'cron', 'edit', 'abc123def456', '--name', '[bot:ben] Morning sweep', '--schedule', '45 7 * * 1-5', '--prompt', 'Morning sweep, shorter.']);
    await hermes.edit('ben', 'abc123def456', { schedule: '0 8 * * 1-5' });
    assert.deepEqual(calls[3].slice(5), ['--schedule', '0 8 * * 1-5'], 'only what changed is sent');
    await assert.rejects(hermes.edit('ben', 'abc123def456', {}), /nothing to change/);
    await assert.rejects(hermes.edit('ben', 'ffffffffffff', { schedule: '0 8 * * *' }), /no such routine/);
    assert.equal(calls.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
