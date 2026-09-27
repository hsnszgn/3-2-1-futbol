/**
 * M1 retention: raw measurement events 30 days, stored reports 90 days.
 * Needs a real, isolated PostgreSQL.
 *
 * Three things have to be true, and each is checked against the rows:
 *   1. What is past its limit is gone — including a backlog larger than one
 *      delete batch.
 *   2. What is NOT past its limit stays: the row exactly at the cutoff, the
 *      young rows, and every account, session and match row, however old. A
 *      purge that deleted the right rows and one match would still be a
 *      disaster.
 *   3. The job actually runs where it should (a real server with measurement
 *      on, on its own schedule) and does not run where it should not
 *      (measurement off — today's production).
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const retention = require('../server/retention');
const { startTestServer, waitForAccounts } = require('./helpers');

const DAY = retention.DAY_MS;
const CLI = path.join(__dirname, '..', 'scripts', 'telemetry-retention.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function insertEvent(db, id, occurredAt) {
  await db.query(
    `INSERT INTO telemetry_events (event_id, schema_version, event_type, game_id, server_occurred_at,
       environment, traffic_kind, process_instance_id, source, details)
     VALUES ($1, 1, 'game_started', $1, $2, 'test', 'automated', 'retention-test', 'server', '{}')`,
    [id, occurredAt]);
}

async function insertReport(db, createdAt) {
  const { rows } = await db.query(
    `INSERT INTO telemetry_reports (kind, as_of, status, body, created_at)
     VALUES ('daily', $1, 'INSUFFICIENT_DATA', '{}', $1) RETURNING id`, [createdAt]);
  return rows[0].id;
}

/** Account, session and match rows, all far older than any retention limit. */
async function insertAccountData(db, now) {
  const ancient = new Date(now.getTime() - 400 * DAY);
  const players = (await db.query(
    `INSERT INTO players (username, display_name, password_hash, created_at)
     VALUES ('saklama_a', 'saklama_a', 'x', $1), ('saklama_b', 'saklama_b', 'x', $1) RETURNING id`,
    [ancient])).rows.map((r) => r.id);
  await db.query(
    `INSERT INTO sessions (token, player_id, created_at, expires_at)
     VALUES ('retention-session', $1, $2, $3)`, [players[0], ancient, new Date(now.getTime() + 30 * DAY)]);
  await db.query(
    `INSERT INTO matches (player_a, player_b, score_a, score_b, winner_id, played_at, match_uid)
     VALUES ($1, $2, 3, 1, $1, $3, 'retention-old-match')`, [players[0], players[1], ancient]);
}

async function counts(db) {
  const one = async (sql) => (await db.query(sql)).rows[0].n;
  return {
    events: await one('SELECT count(*)::int AS n FROM telemetry_events'),
    reports: await one('SELECT count(*)::int AS n FROM telemetry_reports'),
    players: await one('SELECT count(*)::int AS n FROM players'),
    sessions: await one('SELECT count(*)::int AS n FROM sessions'),
    matches: await one('SELECT count(*)::int AS n FROM matches'),
  };
}

const reset = (db) => db.query(
  'TRUNCATE telemetry_events, telemetry_reports, matches, sessions, players RESTART IDENTITY CASCADE');

module.exports = async function runTest({ databaseUrl }) {
  const notes = [];
  const db = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    // --- 1. the limits, at their boundaries ---------------------------------
    {
      await reset(db);
      const now = new Date('2026-10-20T12:00:00Z');
      await insertEvent(db, 'ev-31d', new Date(now.getTime() - 31 * DAY));
      await insertEvent(db, 'ev-30d-1ms', new Date(now.getTime() - 30 * DAY - 1));
      await insertEvent(db, 'ev-exactly-30d', new Date(now.getTime() - 30 * DAY));
      await insertEvent(db, 'ev-29d', new Date(now.getTime() - 29 * DAY));
      await insertEvent(db, 'ev-1h', new Date(now.getTime() - 60 * 60 * 1000));
      const oldReport = await insertReport(db, new Date(now.getTime() - 91 * DAY));
      const edgeReport = await insertReport(db, new Date(now.getTime() - 90 * DAY));
      const youngReport = await insertReport(db, new Date(now.getTime() - 89 * DAY));
      // A report older than 30 days but younger than 90 must survive the EVENT
      // cutoff — the two limits are different on purpose.
      const midReport = await insertReport(db, new Date(now.getTime() - 45 * DAY));
      await insertAccountData(db, now);
      const before = await counts(db);

      // A preview deletes nothing.
      const seen = await retention.preview(db, now);
      assert.deepStrictEqual([seen.events, seen.reports], [2, 1], `preview counted ${seen.events}/${seen.reports}`);
      assert.deepStrictEqual(await counts(db), before, 'a preview changed the database');

      const done = await retention.purge(db, now);
      assert.deepStrictEqual([done.events, done.reports], [2, 1], `purge removed ${done.events}/${done.reports}`);
      const events = (await db.query('SELECT event_id FROM telemetry_events ORDER BY event_id')).rows.map((r) => r.event_id);
      assert.deepStrictEqual(events, ['ev-1h', 'ev-29d', 'ev-exactly-30d'],
        `wrong events survived: ${events.join(', ')}`);
      const reports = (await db.query('SELECT id FROM telemetry_reports ORDER BY id')).rows.map((r) => r.id);
      assert.deepStrictEqual(reports, [edgeReport, youngReport, midReport].sort((a, b) => a - b),
        `wrong reports survived: ${reports.join(', ')} (old one was ${oldReport})`);

      // Nothing outside the two measurement tables moved.
      const after = await counts(db);
      assert.deepStrictEqual(
        { players: after.players, sessions: after.sessions, matches: after.matches },
        { players: before.players, sessions: before.sessions, matches: before.matches },
        'retention touched account, session or match rows');
      const match = (await db.query("SELECT match_uid FROM matches WHERE match_uid = 'retention-old-match'")).rows;
      assert.strictEqual(match.length, 1, 'a 400-day-old match row was deleted');

      // Running it again finds nothing: it is safe to repeat.
      const again = await retention.purge(db, now);
      assert.deepStrictEqual([again.events, again.reports], [0, 0]);
      notes.push('31 gün ve 30 gün+1ms olaylar silindi; tam 30 gün, 29 gün, 1 saat kaldı · 91 günlük rapor silindi; '
        + 'tam 90, 89 ve 45 günlük raporlar kaldı · 400 günlük oyuncu/oturum/maç satırlarına dokunulmadı · '
        + 'ön izleme hiçbir şey silmedi · ikinci çalıştırma 0 sildi');
    }

    // --- 2. a backlog larger than one batch --------------------------------
    {
      await reset(db);
      const now = new Date('2026-10-20T12:00:00Z');
      const old = new Date(now.getTime() - 40 * DAY);
      await db.query(
        `INSERT INTO telemetry_events (event_id, schema_version, event_type, server_occurred_at,
           environment, traffic_kind, process_instance_id, source, details)
         SELECT 'bulk-' || g, 1, 'phase_rendered', $1, 'test', 'automated', 'retention-test', 'client', '{}'
           FROM generate_series(1, 2500) AS g`, [old]);
      await insertEvent(db, 'bulk-keeper', new Date(now.getTime() - DAY));
      const done = await retention.purge(db, now, { batchSize: 1000 });
      assert.strictEqual(done.events, 2500, `a backlog of 2500 was purged as ${done.events}`);
      const left = (await db.query('SELECT event_id FROM telemetry_events')).rows.map((r) => r.event_id);
      assert.deepStrictEqual(left, ['bulk-keeper']);
      notes.push('2500 satırlık birikim 1000\'lik partilerle tamamen silindi, genç satır kaldı');
    }

    // --- 3. a bad window deletes nothing ------------------------------------
    {
      await reset(db);
      const now = new Date('2026-10-20T12:00:00Z');
      await insertEvent(db, 'guarded', new Date(now.getTime() - 60 * 1000));
      for (const bad of [{ rawDays: 0 }, { rawDays: -5 }, { reportDays: 0 }, { rawDays: Number.NaN }]) {
        await assert.rejects(() => retention.purge(db, now, bad), /at least one day/,
          `a window of ${JSON.stringify(bad)} was accepted`);
      }
      await assert.rejects(() => retention.purge(db, new Date('nope')), /valid "now"/);
      assert.strictEqual((await counts(db)).events, 1, 'a refused purge still deleted something');
      notes.push('sıfır/negatif/NaN pencere ve geçersiz saat reddedildi, bir dakikalık satır silinmedi');
    }

    // --- 4. the command: dry run by default, --apply to delete --------------
    {
      await reset(db);
      const now = new Date('2026-10-20T12:00:00Z');
      await insertEvent(db, 'cli-old', new Date(now.getTime() - 31 * DAY));
      await insertEvent(db, 'cli-young', new Date(now.getTime() - DAY));
      const env = { REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '' };

      const dry = await run([`--now=${now.toISOString()}`], env);
      assert.strictEqual(dry.code, 0, dry.stderr);
      const dryOut = JSON.parse(dry.stdout);
      assert.strictEqual(dryOut.mode, 'dry-run');
      assert.strictEqual(dryOut.events, 1);
      assert.strictEqual((await counts(db)).events, 2, 'the dry run deleted rows');

      const applied = await run([`--now=${now.toISOString()}`, '--apply'], env);
      assert.strictEqual(applied.code, 0, applied.stderr);
      assert.strictEqual(JSON.parse(applied.stdout).events, 1);
      const left = (await db.query('SELECT event_id FROM telemetry_events')).rows.map((r) => r.event_id);
      assert.deepStrictEqual(left, ['cli-young']);

      // The clock seam cannot be combined with deletion on a non-local database.
      const guarded = await run([`--now=${now.toISOString()}`, '--apply'],
        { REPORT_DATABASE_URL: 'postgres://u:p@db.example.com/app', DATABASE_URL: '' });
      assert.strictEqual(guarded.code, 2, `--now --apply on a remote database exited ${guarded.code}`);
      assert.ok(/refusing --now together with --apply/.test(guarded.stderr), guarded.stderr);
      notes.push('komut varsayılan olarak yalnız saydı (silmedi), --apply ile sildi; '
        + 'saat kaydırma + --apply uzak veritabanında reddedildi');
    }

    // --- 5. the server runs it on its own, only with measurement on ---------
    {
      // Rows aged against the REAL clock, because the server uses real time.
      const seed = async () => {
        await reset(db);
        const now = new Date();
        await insertEvent(db, 'srv-old', new Date(now.getTime() - 31 * DAY));
        await insertEvent(db, 'srv-young', new Date(now.getTime() - DAY));
        await insertReport(db, new Date(now.getTime() - 91 * DAY));
        await insertAccountData(db, now);
      };

      // Off (the default, and production today): nothing is deleted.
      await seed();
      const off = await startTestServer({ DATABASE_URL: databaseUrl, TELEMETRY_RETENTION_INTERVAL_MS: '200' });
      try {
        await waitForAccounts(off);
        await sleep(1200);
        const c = await counts(db);
        assert.deepStrictEqual([c.events, c.reports], [2, 1],
          `with measurement off the server still purged (${c.events} events, ${c.reports} reports left)`);
      } finally {
        await off.stop();
      }

      // On: the purge runs at start-up, then on its interval. The interval is
      // shown to repeat by planting another expired row after the first pass.
      await seed();
      const on = await startTestServer({
        DATABASE_URL: databaseUrl, TELEMETRY_ENABLED: '1', TELEMETRY_RETENTION_INTERVAL_MS: '300',
      });
      try {
        await waitForAccounts(on);
        let c;
        for (let i = 0; i < 50; i += 1) {
          c = await counts(db);
          if (c.reports === 0 && !(await db.query("SELECT 1 FROM telemetry_events WHERE event_id = 'srv-old'")).rowCount) break;
          await sleep(100);
        }
        const firstPass = (await db.query('SELECT event_id FROM telemetry_events WHERE event_id LIKE \'srv-%\' ORDER BY event_id')).rows
          .map((r) => r.event_id);
        assert.deepStrictEqual(firstPass, ['srv-young'], `after start-up: ${firstPass.join(', ')}`);
        assert.strictEqual(c.reports, 0, 'the 91-day report survived start-up');

        await insertEvent(db, 'srv-planted-later', new Date(Date.now() - 45 * DAY));
        let gone = false;
        for (let i = 0; i < 40 && !gone; i += 1) {
          await sleep(100);
          gone = !(await db.query("SELECT 1 FROM telemetry_events WHERE event_id = 'srv-planted-later'")).rowCount;
        }
        assert.ok(gone, 'an expired row planted after start-up was not removed on the next interval');
        const after = await counts(db);
        assert.deepStrictEqual([after.players, after.sessions, after.matches], [2, 1, 1],
          'the server purge touched account, session or match rows');
      } finally {
        await on.stop();
      }
      notes.push('sunucu: ölçüm kapalıyken hiçbir şey silmedi; açıkken açılışta 31 günlük olayı ve 91 günlük raporu sildi, '
        + 'sonradan eklenen süresi dolmuş satırı bir sonraki aralıkta sildi, genç satıra ve hesap/maç verisine dokunmadı');
    }
  } finally {
    await db.end().catch(() => {});
  }
  return notes.join(' · ');
};

module.exports.needsDatabase = true;
