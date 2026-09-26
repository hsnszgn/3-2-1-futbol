/**
 * Measurement events (roadmap M1/M3/M7). Needs a real, isolated PostgreSQL.
 *
 * The point of this file is not that events can be written — that much any
 * INSERT does. It is the four ways measurement quietly lies:
 *
 *   1. A retried delivery counted twice, so the denominator grows by itself.
 *   2. A contradiction (the same event id carrying a different result) dropped
 *      by ON CONFLICT DO NOTHING, so the report never sees it.
 *   3. A test run or a client labelling itself as real beta traffic, so `H`
 *      includes games no human played.
 *   4. Events lost — queue full, database unreachable — while the report still
 *      reads as success.
 *
 * Each scenario runs in its own child process (see fixtures/telemetry-probe.js)
 * and the assertions are made against the ROWS, not against what the module
 * says about itself.
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

const PROBE = path.join(__dirname, 'fixtures', 'telemetry-probe.js');

async function openDb(url) {
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/**
 * Runs one scenario and returns what it reported.
 *
 * A scenario that kills itself (the crash case) has no exit code worth reading,
 * so the JSON line is the result and the signal is expected.
 */
function runProbe(scenario, env, { allowSignal = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, scenario], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => {
      const line = stdout.split('\n').find((l) => l.startsWith('__PROBE__'));
      if (!line) {
        reject(new Error(`${scenario}: probe printed no result (code ${code}, signal ${signal})\n${stderr}`));
        return;
      }
      if (code !== 0 && !(allowSignal && signal)) {
        reject(new Error(`${scenario}: probe exited ${code} ${signal || ''}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice('__PROBE__'.length)));
    });
  });
}

module.exports = async function run({ databaseUrl }) {
  const notes = [];
  const db = await openDb(databaseUrl);
  const base = {
    DATABASE_URL: databaseUrl,
    TELEMETRY_ENVIRONMENT: 'beta',
    TELEMETRY_TRAFFIC_KIND: 'human_beta',
    TELEMETRY_COHORT_ID: 'beta-test',
    RELEASE_SHA: 'testsha',
  };
  const rowsFor = async (gameId) => (await db.query(
    `SELECT event_id, event_type, game_id, attempt_id, seat, source, traffic_kind,
            environment, beta_cohort_id, release_sha, process_instance_id,
            reason_code, details, server_occurred_at, stored_at
       FROM telemetry_events WHERE game_id = $1 ORDER BY stored_at, event_type`,
    [gameId])).rows;

  try {
    await db.query('TRUNCATE telemetry_events');

    // --- 1. a retried delivery is one event, not two ------------------------
    {
      const gameId = 'g-idempotent';
      const result = await runProbe('idempotent', { ...base, PROBE_GAME_ID: gameId });
      assert.strictEqual(result.flushed.remaining, 0, 'the queue did not drain');
      const rows = await rowsFor(gameId);
      assert.strictEqual(rows.length, 1, `a redelivered event was stored ${rows.length} times`);
      assert.strictEqual(rows[0].event_type, 'game_started');
      // The contract's own fields, checked once here rather than in every case.
      assert.strictEqual(rows[0].environment, 'beta');
      assert.strictEqual(rows[0].beta_cohort_id, 'beta-test');
      assert.strictEqual(rows[0].release_sha, 'testsha');
      assert.ok(rows[0].process_instance_id, 'the event is not tied to a process');
      assert.ok(rows[0].server_occurred_at <= rows[0].stored_at,
        'the event was stored before it happened');
      const conflicts = await db.query(
        "SELECT 1 FROM telemetry_events WHERE event_type = 'telemetry_conflict'");
      assert.strictEqual(conflicts.rowCount, 0,
        'an identical redelivery was reported as a contradiction');
      assert.strictEqual(result.health.degraded, null,
        `an identical redelivery degraded the process: ${result.health.degraded}`);
      notes.push('aynı olay iki kez teslim edildi: tek satır, çelişki üretilmedi, süreç sağlam');
    }

    // --- 2. the same id with different content is reported ------------------
    {
      const gameId = 'g-conflict';
      const result = await runProbe('conflict', { ...base, PROBE_GAME_ID: gameId });
      const rows = await rowsFor(gameId);
      const finished = rows.filter((r) => r.event_type === 'game_finished');
      assert.strictEqual(finished.length, 1, 'a conflicting id overwrote or duplicated the result');
      assert.strictEqual(finished[0].details.score_a, 3, 'the stored result was rewritten');
      const conflict = rows.find((r) => r.event_type === 'telemetry_conflict');
      assert.ok(conflict, 'a conflicting redelivery was dropped silently');
      assert.strictEqual(conflict.details.conflicts_with, 'probe-event-conflict');
      assert.strictEqual(result.health.degraded, 'event_id_conflict',
        `the contradiction did not degrade the process: ${result.health.degraded}`);
      notes.push('aynı kimlikle çelişen içerik: ilk satır korundu, telemetry_conflict yazıldı, '
        + 'süreç "event_id_conflict" olarak işaretlendi');
    }

    // --- 3. nobody can label their own traffic as a real human ---------------
    {
      const gameId = 'g-claim';
      // The server here is configured as AUTOMATED, and the client notice asks
      // for human_beta. The configuration must win.
      await runProbe('client-cannot-claim-human', {
        ...base,
        TELEMETRY_TRAFFIC_KIND: 'automated',
        PROBE_GAME_ID: gameId,
      });
      const rows = await rowsFor(gameId);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].traffic_kind, 'automated',
        'a client-supplied traffic kind was stored, so H can be inflated from the client');
      assert.strictEqual(rows[0].source, 'client',
        'a client notice was stored as if the server had observed it');
      notes.push('istemci kendini human_beta ilan etti: sunucu yapılandırması kazandı '
        + '(traffic_kind=automated, source=client)');
    }

    // --- 4. only the contract's fields are stored ---------------------------
    {
      const gameId = 'g-allowlist';
      await runProbe('details-allowlist', { ...base, PROBE_GAME_ID: gameId });
      const rows = await rowsFor(gameId);
      assert.strictEqual(rows.length, 1);
      const details = rows[0].details;
      assert.deepStrictEqual(Object.keys(details).sort(),
        ['elapsed_ms', 'points', 'round', 'scored_seat'],
        `stored fields outside the contract: ${JSON.stringify(details)}`);
      // Said explicitly, because this is the failure that matters: a secret in a
      // measurement table is a leak that outlives the game.
      const serialised = JSON.stringify(rows[0]);
      for (const secret of ['sess_secretvalue', 'hunter2', 'Bearer abc', 'Mohamed Salah',
        '203.0.113.7', 'postgres://u:p@host/db', 'ali']) {
        assert.ok(!serialised.includes(secret), `"${secret}" reached the measurement table`);
      }
      notes.push('sözleşme dışı alanlar (jeton, parola, Authorization, ham cevap, kullanıcı adı, '
        + 'IP, bağlantı adresi, iç içe nesne) yazılmadı');
    }

    // --- 5. what the queue cannot hold is counted, not lost quietly ---------
    {
      const result = await runProbe('overflow', {
        ...base,
        // No database on purpose: the queue cannot drain, so it fills.
        DATABASE_URL: '',
        TELEMETRY_MAX_QUEUE: '5',
        PROBE_GAME_ID: 'g-overflow',
      });
      assert.strictEqual(result.accepted, 5, `the queue accepted ${result.accepted}, not its limit of 5`);
      assert.strictEqual(result.health.dropped, 15, `dropped events were not counted: ${result.health.dropped}`);
      assert.strictEqual(result.health.degraded, 'queue_overflow',
        `a full queue did not degrade the process: ${result.health.degraded}`);
      notes.push('kuyruk taştı (sınır 5, 20 olay): 15 düşen olay sayıldı ve süreç '
        + '"queue_overflow" olarak işaretlendi, sessiz kayıp yok');
    }

    // --- 6. an unreachable database is reported, and gives up --------------
    {
      const started = Date.now();
      const result = await runProbe('write-failure', {
        ...base,
        // A port with nothing behind it: every connection is refused at once.
        DATABASE_URL: 'postgres://postgres@127.0.0.1:59999/postgres',
        TELEMETRY_MAX_ATTEMPTS: '2',
        TELEMETRY_RETRY_BASE_MS: '50',
        PROBE_GAME_ID: 'g-writefail',
      });
      const ms = Date.now() - started;
      assert.strictEqual(result.durable, false,
        'recordDurable claimed a game start was stored while the database was unreachable');
      assert.strictEqual(result.health.degraded, 'write_failed',
        `an unreachable database did not degrade the process: ${result.health.degraded}`);
      assert.ok(result.health.failed >= 1, 'the failed write was not counted');
      assert.strictEqual(result.flushed.remaining, 0, 'the queue never gave up, so it would grow forever');
      notes.push(`erişilemeyen veritabanı: recordDurable false döndü (yani maç başlatılmaz), `
        + `bütçe bitince kuyruk boşaldı ve süreç "write_failed" (${ms}ms)`);
    }

    // --- 7. a killed process leaves the game's start behind ----------------
    {
      const gameId = 'g-crash';
      const result = await runProbe('durable-start', { ...base, PROBE_GAME_ID: gameId },
        { allowSignal: true });
      assert.strictEqual(result.durable, true, 'the game start was not stored durably');
      const rows = await rowsFor(gameId);
      const types = rows.map((r) => r.event_type);
      assert.ok(types.includes('game_started'),
        'the start of a game was lost when the process was killed, so the game vanishes from the denominator');
      assert.ok(!types.includes('round_scored'),
        'a queued-but-unflushed event survived a SIGKILL, so this test is not measuring what it claims');
      notes.push('süreç SIGKILL ile öldürüldü: kalıcı yazılan game_started duruyor '
        + '(yarım maç paydada kalır), yalnız kuyrukta olan olay kayıp — ölçülen davranış bu');
    }

    // --- 8. a wrong call is refused, and never reaches the game ------------
    {
      const gameId = 'g-invalid';
      const result = await runProbe('invalid', { ...base, PROBE_GAME_ID: gameId });
      assert.deepStrictEqual(result.accepted, {
        unknownType: false, badReason: false, badSeat: false, badSource: false, good: true,
      }, `validation let something through: ${JSON.stringify(result.accepted)}`);
      const rows = await rowsFor(gameId);
      assert.strictEqual(rows.length, 1, `refused events were stored anyway (${rows.length} rows)`);
      assert.strictEqual(rows[0].reason_code, 'left');
      assert.strictEqual(result.health.degraded, 'invalid_event',
        'a refused event did not mark the measurement as suspect');
      notes.push('bilinmeyen tür, sözlük dışı sebep kodu, geçersiz koltuk ve geçersiz kaynak '
        + 'reddedildi (çağıran çökmedi), geçerli olay yazıldı');
    }
  } finally {
    await db.end().catch(() => {});
  }

  return notes.join(' · ');
};

// Set AFTER the assignment above, which replaces the whole exports object.
module.exports.needsDatabase = true;
