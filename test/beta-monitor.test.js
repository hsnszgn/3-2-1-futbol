/**
 * M6: the observation window, the stored report, the alerts, and the scheduler
 * that runs them. Needs a real, isolated PostgreSQL.
 *
 * The rule under test is the user's: no data, a gap in the measurement, or a
 * failed check must never come out as PASS. And the scheduler and the alerts
 * are not only written — they are RUN: a real server with measurement on, short
 * intervals, a local webhook receiver standing in for the alert channel, a real
 * inconsistency planted in the table and a real hard kill of the process.
 *
 * What this cannot prove, and does not claim: delivery to a real alert channel
 * (none is configured anywhere yet), and continuous observation on the real
 * host over a real 72 hours.
 */
const assert = require('assert');
const http = require('http');
const { Client } = require('pg');
const { observe } = require('../server/observation');
const { buildReport } = require('../server/betaReport');
const alerts = require('../server/alerts');
const { startTestServer, waitForAccounts } = require('./helpers');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serial = 0;
function ev(overrides) {
  serial += 1;
  return {
    event_id: `mon-${serial}-${Math.random().toString(36).slice(2, 8)}`,
    schema_version: 1,
    event_type: 'game_started',
    game_id: null,
    attempt_id: null,
    seat: null,
    server_occurred_at: new Date(),
    environment: 'beta',
    traffic_kind: 'human_beta',
    beta_cohort_id: 'mon',
    release_sha: 'mon-sha',
    process_instance_id: 'mon-proc',
    source: 'server',
    reason_code: null,
    details: {},
    ...overrides,
  };
}

async function insert(db, rows) {
  for (const r of rows) {
    await db.query(
      `INSERT INTO telemetry_events (event_id, schema_version, event_type, game_id, attempt_id, seat,
        server_occurred_at, environment, traffic_kind, beta_cohort_id, release_sha, process_instance_id,
        source, reason_code, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [r.event_id, r.schema_version, r.event_type, r.game_id, r.attempt_id, r.seat, r.server_occurred_at,
        r.environment, r.traffic_kind, r.beta_cohort_id, r.release_sha, r.process_instance_id, r.source,
        r.reason_code, JSON.stringify(r.details)]);
  }
}

/** Heartbeats every `stepMs` from `from` to `to`, skipping any in `holes`. */
function heartbeats(from, to, stepMs, holes = []) {
  const out = [];
  for (let t = from.getTime(); t < to.getTime(); t += stepMs) {
    if (holes.some(([a, b]) => t >= a.getTime() && t < b.getTime())) continue;
    out.push(ev({ event_type: 'telemetry_heartbeat', server_occurred_at: new Date(t), details: { interval_ms: stepMs } }));
  }
  return out;
}

/** A clean, finished guest game starting at `at`. */
function cleanGame(id, at) {
  const t = (s) => new Date(at.getTime() + s * 1000);
  return [
    ev({ game_id: id, event_type: 'game_started', server_occurred_at: t(0) }),
    ev({ game_id: id, event_type: 'round_scored', attempt_id: 1, seat: 'A', server_occurred_at: t(10),
      details: { round: 1, points: 3, scored_seat: 'A' } }),
    ev({ game_id: id, event_type: 'game_finished', server_occurred_at: t(20),
      details: { score_a: 3, score_b: 0, winner_seat: 'A', rounds_played: 1 } }),
    ev({ game_id: id, event_type: 'recording_decided', reason_code: 'guest_seat', server_occurred_at: t(21),
      details: { decision: 'skip', policy: 'both_signed_in' } }),
    ev({ game_id: id, event_type: 'result_rendered', seat: 'A', source: 'client', server_occurred_at: t(22) }),
    ev({ game_id: id, event_type: 'result_rendered', seat: 'B', source: 'client', server_occurred_at: t(22) }),
  ];
}

/** A local HTTP receiver standing in for the alert channel. */
async function receiver() {
  const received = [];
  const unreadable = [];
  let failWith = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (failWith) { res.writeHead(failWith); res.end(); return; }
      try {
        received.push(JSON.parse(body));
      } catch (err) {
        // Recorded, not thrown: an unreadable alert is a finding in itself.
        unreadable.push({ method: req.method, url: req.url, headers: req.headers, body });
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    received,
    unreadable,
    fail(status) { failWith = status; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = async function run({ databaseUrl }) {
  const notes = [];
  const db = new Client({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const reset = () => db.query('TRUNCATE telemetry_events, telemetry_reports, matches, sessions, players RESTART IDENTITY CASCADE');

  try {
    // --- 1. the observation window, by itself ------------------------------
    {
      const now = new Date('2026-10-20T12:00:00Z');
      const from = new Date(now.getTime() - 72 * HOUR);
      const step = 5 * MIN;
      const full = heartbeats(new Date(from.getTime() - step), now, step);
      assert.strictEqual(observe(full, { from, to: now, now, heartbeatMs: step }).status, 'COVERED');

      const hole = [new Date(from.getTime() + 30 * HOUR), new Date(from.getTime() + 30 * HOUR + 20 * MIN)];
      const holed = observe(heartbeats(new Date(from.getTime() - step), now, step, [hole]),
        { from, to: now, now, heartbeatMs: step });
      assert.strictEqual(holed.status, 'GAP', 'a 20-minute hole in 72 hours was called covered');
      assert.strictEqual(holed.gaps.length, 1);

      // One missed beat leaves 10 minutes between two beats: inside the
      // allowance (two 5-minute intervals + 1 minute). Two missed beats (15
      // minutes) would not be.
      const small = [new Date(from.getTime() + 10 * HOUR), new Date(from.getTime() + 10 * HOUR + 4 * MIN)];
      assert.strictEqual(observe(heartbeats(new Date(from.getTime() - step), now, step, [small]),
        { from, to: now, now, heartbeatMs: step }).status, 'COVERED', 'a single missed beat was called a gap');
      const two = [new Date(from.getTime() + 10 * HOUR), new Date(from.getTime() + 10 * HOUR + 9 * MIN)];
      assert.strictEqual(observe(heartbeats(new Date(from.getTime() - step), now, step, [two]),
        { from, to: now, now, heartbeatMs: step }).status, 'GAP', 'two missed beats were not called a gap');

      const stopped = observe(heartbeats(from, new Date(now.getTime() - HOUR), step), { from, to: now, now, heartbeatMs: step });
      assert.strictEqual(stopped.status, 'GAP', 'heartbeats that stopped an hour ago were called covered');

      assert.strictEqual(observe([], { from, to: now, now, heartbeatMs: step }).status, 'GAP', 'no evidence was called covered');
      assert.strictEqual(observe(full, { from, to: new Date(now.getTime() + HOUR), now, heartbeatMs: step }).status,
        'INSUFFICIENT_DATA', 'a window that has not ended was judged');
      const degraded = observe([...full, ev({ event_type: 'telemetry_degraded', server_occurred_at: new Date(now.getTime() - HOUR) })],
        { from, to: now, now, heartbeatMs: step });
      assert.strictEqual(degraded.status, 'GAP', 'a degraded-measurement event inside the window was ignored');
      notes.push('72 saat: kesintisiz kalp atışı COVERED; 20 dk delik GAP; tek kaçan atış COVERED, iki kaçan atış GAP; bir saattir susan '
        + 'kalp atışı GAP; hiç kanıt GAP; bitmemiş pencere INSUFFICIENT_DATA; ölçüm arızası olayı GAP');
    }

    // --- 2. the report: counts AND observation, never PASS without both ----
    {
      const now = new Date();
      const to = new Date(now.getTime() - MIN);
      const from = new Date(to.getTime() - 72 * HOUR);
      const scope = { from, to, cohort: 'mon', trafficKind: 'human_beta' };
      const games = [0, 1, 2].flatMap((i) => cleanGame(`g-${i}`, new Date(from.getTime() + (10 + i) * HOUR)));
      const opts = { now, minGames: 3 };

      await reset();
      await insert(db, [...games, ...heartbeats(new Date(from.getTime() - 5 * MIN), to, 5 * MIN)]);
      const good = await buildReport(db, scope, opts);
      assert.strictEqual(good.status, 'PASS', `positive control: ${good.status} ${good.notes}`);
      assert.strictEqual(good.observation.last72h.status, 'COVERED');
      assert.strictEqual(good.gate, 'PASS');

      await db.query("DELETE FROM telemetry_events WHERE event_type = 'telemetry_heartbeat' AND server_occurred_at BETWEEN $1 AND $2",
        [new Date(from.getTime() + 40 * HOUR), new Date(from.getTime() + 41 * HOUR)]);
      const gap = await buildReport(db, scope, opts);
      assert.strictEqual(gap.status, 'OBSERVABILITY_GAP', `an hour without heartbeats still gave ${gap.status}`);
      assert.strictEqual(gap.gate, 'NOT_PASSED');

      await db.query("DELETE FROM telemetry_events WHERE event_type = 'telemetry_heartbeat'");
      const none = await buildReport(db, scope, opts);
      assert.notStrictEqual(none.status, 'PASS', 'no heartbeats at all still passed');

      await reset();
      await insert(db, [...games, ...heartbeats(new Date(from.getTime() - 5 * MIN), to, 5 * MIN),
        ev({ event_type: 'telemetry_degraded', server_occurred_at: new Date(from.getTime() + 20 * HOUR), details: { fault: 'write_failed' } })]);
      const degraded = await buildReport(db, scope, opts);
      assert.strictEqual(degraded.status, 'OBSERVABILITY_GAP', `a degraded measurement gave ${degraded.status}`);

      // Covered, but nobody played: not a pass.
      await reset();
      await insert(db, heartbeats(new Date(from.getTime() - 5 * MIN), to, 5 * MIN));
      const quiet = await buildReport(db, scope, opts);
      assert.notStrictEqual(quiet.status, 'PASS');
      assert.strictEqual(quiet.observation.last72h.status, 'NO_USAGE', `a quiet window was ${quiet.observation.last72h.status}`);
      assert.strictEqual(quiet.gate, 'NOT_PASSED');

      // A failing query: a report object with OBSERVABILITY_GAP, not an exception
      // and not a pass.
      const broken = { query: async () => { throw new Error('connection terminated'); } };
      const failed = await buildReport(broken, scope, opts);
      assert.strictEqual(failed.status, 'OBSERVABILITY_GAP');
      assert.strictEqual(failed.queryFailed, true);
      assert.strictEqual(failed.gate, 'NOT_PASSED');
      notes.push('rapor: 3 temiz maç + kesintisiz kalp atışı PASS/gate PASS (pozitif kontrol); bir saatlik boşluk, hiç kalp atışı, '
        + 'ölçüm arızası, maç olmayan pencere (NO_USAGE) ve başarısız sorgu — hiçbiri PASS değil');
    }

    // --- 3. alerts, against a local receiver -------------------------------
    {
      const hook = await receiver();
      try {
        const now = new Date();
        await reset();
        const bad = cleanGame('bad-score', new Date(now.getTime() - 10 * MIN));
        bad.find((r) => r.event_type === 'game_finished').details.score_a = 9;
        await insert(db, [
          ...bad,
          // a process that vanished without saying so, replaced by a newer one
          ev({ event_type: 'process_started', process_instance_id: 'proc-dead', server_occurred_at: new Date(now.getTime() - 30 * MIN) }),
          ev({ event_type: 'process_started', process_instance_id: 'proc-new', server_occurred_at: new Date(now.getTime() - 20 * MIN) }),
          // a graceful one, which must NOT be called a crash
          ev({ event_type: 'process_started', process_instance_id: 'proc-clean', server_occurred_at: new Date(now.getTime() - 50 * MIN) }),
          ev({ event_type: 'process_stopping', process_instance_id: 'proc-clean', server_occurred_at: new Date(now.getTime() - 45 * MIN) }),
          ev({ event_type: 'telemetry_degraded', process_instance_id: 'proc-new', server_occurred_at: new Date(now.getTime() - 5 * MIN), details: { fault: 'queue_overflow' } }),
          ...heartbeats(new Date(now.getTime() - 61 * MIN), now, MIN),
        ]);
        const found = await alerts.evaluate(db, { now, lookbackMs: HOUR, heartbeatMs: MIN, settleMs: 0 });
        const kinds = found.map((a) => a.key).sort();
        assert.ok(kinds.includes('inconsistency:bad-score'), `no inconsistency alert: ${kinds}`);
        assert.ok(kinds.includes('crash:proc-dead'), `no crash alert: ${kinds}`);
        assert.ok(!kinds.some((k) => k.includes('proc-clean')), `a graceful stop was called a crash: ${kinds}`);
        assert.ok(kinds.includes('measurement:proc-new:queue_overflow'), `no measurement alert: ${kinds}`);

        // Stable keys. A running process whose heartbeats stopped for a while
        // and came back: the stretch before the look-back window's edge must not
        // produce a key tied to "when the check looked", or every check sends a
        // new alert. The same data, checked a minute apart, gives the same keys.
        await db.query('TRUNCATE telemetry_events');
        await insert(db, [
          ...heartbeats(new Date(now.getTime() - 3 * HOUR), new Date(now.getTime() - 2 * HOUR), MIN),
          ...heartbeats(new Date(now.getTime() - 30 * MIN), now, MIN),
          // and a silence that starts at a real heartbeat, inside the window
          ...heartbeats(new Date(now.getTime() - 3 * HOUR - 10 * MIN), new Date(now.getTime() - 3 * HOUR), MIN)
            .map((r) => ({ ...r, process_instance_id: 'other' })),
        ]);
        const keysAt = async (when) => (await alerts.evaluate(db, { now: when, lookbackMs: HOUR, heartbeatMs: MIN, settleMs: 0 }))
          .filter((a) => a.kind === 'measurement_loss').map((a) => a.key).sort();
        const k1 = await keysAt(now);
        const k2 = await keysAt(new Date(now.getTime() + MIN));
        assert.deepStrictEqual(k1, k2, `alert keys moved with the clock: ${k1} vs ${k2}`);
        await db.query('TRUNCATE telemetry_events');
        await insert(db, [
          ...bad,
          ev({ event_type: 'process_started', process_instance_id: 'proc-dead', server_occurred_at: new Date(now.getTime() - 30 * MIN) }),
          ev({ event_type: 'process_started', process_instance_id: 'proc-new', server_occurred_at: new Date(now.getTime() - 20 * MIN) }),
          ev({ event_type: 'process_started', process_instance_id: 'proc-clean', server_occurred_at: new Date(now.getTime() - 50 * MIN) }),
          ev({ event_type: 'process_stopping', process_instance_id: 'proc-clean', server_occurred_at: new Date(now.getTime() - 45 * MIN) }),
          ev({ event_type: 'telemetry_degraded', process_instance_id: 'proc-new', server_occurred_at: new Date(now.getTime() - 5 * MIN), details: { fault: 'queue_overflow' } }),
          ...heartbeats(new Date(now.getTime() - 61 * MIN), now, MIN),
        ]);

        // Settling: a game that JUST finished is not checked yet.
        const fresh = await alerts.evaluate(db, { now, lookbackMs: HOUR, heartbeatMs: MIN, settleMs: 20 * MIN });
        assert.ok(!fresh.some((a) => a.key === 'inconsistency:bad-score'), 'an unsettled game was alerted on');

        const first = await alerts.deliver(db, found, { now, webhookUrl: hook.url });
        assert.ok(first.every((o) => o.status === 'SENT'), JSON.stringify(first));
        assert.strictEqual(hook.received.length, found.length);
        for (const body of hook.received) {
          assert.deepStrictEqual(Object.keys(body).sort(), ['detectedAt', 'key', 'kind', 'summary'],
            `an alert carried more than it should: ${JSON.stringify(body)}`);
        }
        // Seen again on the next check: not sent again.
        const second = await alerts.deliver(db, found, { now: new Date(now.getTime() + MIN), webhookUrl: hook.url });
        assert.ok(second.every((o) => o.status === 'SUPPRESSED'), JSON.stringify(second));
        assert.strictEqual(hook.received.length, found.length, 'a known problem was alerted twice');

        // The channel fails: stored as DELIVERY_FAILED, and retried next time.
        const retryAlert = [{ kind: 'measurement_loss', key: 'test:retry', summary: 'x' }];
        hook.fail(500);
        const failedOnce = await alerts.deliver(db, retryAlert, { now, webhookUrl: hook.url });
        assert.strictEqual(failedOnce[0].status, 'DELIVERY_FAILED');
        hook.fail(0);
        const retried = await alerts.deliver(db, retryAlert, { now: new Date(now.getTime() + MIN), webhookUrl: hook.url });
        assert.strictEqual(retried[0].status, 'SENT', 'a failed delivery was not retried');

        // Nowhere to send it: visible, not silent.
        const unset = await alerts.deliver(db, [{ kind: 'process_crash', key: 'test:unset', summary: 'x' }], { now, webhookUrl: '' });
        assert.strictEqual(unset[0].status, 'NOT_CONFIGURED');
        const insecure = await alerts.deliver(db, [{ kind: 'process_crash', key: 'test:insecure', summary: 'x' }], { now, webhookUrl: 'http://alerts.example.com/hook' });
        assert.strictEqual(insecure[0].status, 'NOT_CONFIGURED');
        const stored = (await db.query("SELECT status, body FROM telemetry_reports WHERE kind = 'alert' AND body->>'key' LIKE 'test:%' ORDER BY id")).rows;
        assert.deepStrictEqual(stored.map((r) => r.status), ['DELIVERY_FAILED', 'SENT', 'NOT_CONFIGURED', 'NOT_CONFIGURED']);
        assert.strictEqual(stored[3].body.error, 'insecure_url');
        notes.push(`alarm: skor tutarsızlığı, sessiz ölen süreç ve ölçüm arızası bulundu (${found.length}), düzgün kapanan süreç çökme sayılmadı, aynı veri bir dakika arayla aynı alarm anahtarlarını verdi, `
          + 'yeni biten maç yerleşmeden kontrol edilmedi; gönderildi, ikinci kontrolde bastırıldı; kanal 500 verince DELIVERY_FAILED '
          + 'kaydedildi ve sonra yeniden gönderildi; adres yokken/şifresiz uzak adreste NOT_CONFIGURED kaydedildi; yük yalnız '
          + 'tür/anahtar/özet/zaman');
      } finally {
        await hook.close();
      }
    }

    // --- 4. the scheduler, run for real ------------------------------------
    {
      await reset();
      const hook = await receiver();
      const env = {
        DATABASE_URL: databaseUrl,
        TELEMETRY_ENABLED: '1',
        TELEMETRY_ENVIRONMENT: 'beta',
        TELEMETRY_TRAFFIC_KIND: 'human_beta',
        TELEMETRY_HEARTBEAT_MS: '200',
        BETA_ALERT_INTERVAL_MS: '300',
        BETA_REPORT_INTERVAL_MS: '700',
        BETA_ALERT_LOOKBACK_MS: String(10 * MIN),
        BETA_ALERT_SETTLE_MS: '0',
        BETA_ALERT_WEBHOOK_URL: hook.url,
      };
      const first = await startTestServer(env);
      try {
        await waitForAccounts(first);
        await sleep(1500);
        const beats = (await db.query("SELECT count(*)::int AS n FROM telemetry_events WHERE event_type = 'telemetry_heartbeat'")).rows[0].n;
        assert.ok(beats >= 4, `only ${beats} heartbeats in 1.5s at a 200ms interval`);
        const reports = (await db.query("SELECT status, body FROM telemetry_reports WHERE kind = 'daily'")).rows;
        assert.ok(reports.length >= 1, 'the scheduled report never ran');
        assert.ok(reports.every((r) => r.status !== 'PASS'), `a report with no games passed: ${reports.map((r) => r.status)}`);
        assert.ok(reports.every((r) => !('games' in r.body)), 'a stored report kept the per-game list');
        // A freshly started, healthy server raises nothing. The first version
        // alerted every 300 ms here: the stretch before the first heartbeat was
        // called a gap, keyed on the moving edge of the look-back window, so
        // de-duplication never matched.
        assert.deepStrictEqual(hook.received.filter((a) => a.kind === 'measurement_loss'), [],
          `a healthy start raised measurement alerts: ${JSON.stringify(hook.received.slice(0, 3))}`);

        // A real inconsistency appears in the table: the scheduler must alert
        // without anyone running anything, and only once.
        const bad = cleanGame('sched-bad', new Date(Date.now() - MIN));
        bad.find((r) => r.event_type === 'game_finished').details.score_a = 7;
        await insert(db, bad);
        let got = [];
        for (let i = 0; i < 40 && !got.length; i += 1) {
          await sleep(100);
          got = hook.received.filter((a) => a.key === 'inconsistency:sched-bad');
        }
        assert.strictEqual(got.length, 1, 'the scheduler did not alert on a planted inconsistency');
        await sleep(1000);
        assert.strictEqual(hook.received.filter((a) => a.key === 'inconsistency:sched-bad').length, 1,
          'the scheduler alerted on the same problem more than once');
        const keys = hook.received.map((a) => a.key);
        assert.strictEqual(new Set(keys).size, keys.length, `an alert key arrived twice: ${keys.join(', ')}`);
        // Every alert that arrived was a real, readable alert (the fixture once
        // dropped fetch options, and webhooks arrived as empty GETs).
        assert.deepStrictEqual(hook.unreadable, [], `unreadable alerts: ${JSON.stringify(hook.unreadable.slice(0, 2))}`);
      } finally {
        await first.stop(); // SIGKILL: a real crash
      }

      // The next process notices the one before it died without a word.
      const firstInstance = (await db.query(
        "SELECT process_instance_id FROM telemetry_events WHERE event_type = 'process_started' ORDER BY server_occurred_at LIMIT 1")).rows[0].process_instance_id;
      const second = await startTestServer(env);
      try {
        await waitForAccounts(second);
        let crash = [];
        for (let i = 0; i < 50 && !crash.length; i += 1) {
          await sleep(100);
          crash = hook.received.filter((a) => a.key === `crash:${firstInstance}`);
        }
        assert.strictEqual(crash.length, 1, 'a hard-killed process raised no crash alert after restart');
        // And the graceful stop that follows must not be a crash.
      } finally {
        await second.terminate();
      }
      const secondInstance = (await db.query(
        "SELECT process_instance_id FROM telemetry_events WHERE event_type = 'process_stopping' ORDER BY server_occurred_at DESC LIMIT 1")).rows[0];
      assert.ok(secondInstance, 'a graceful stop wrote no process_stopping');
      const third = await startTestServer(env);
      try {
        await waitForAccounts(third);
        await sleep(1200);
        const wrong = hook.received.filter((a) => a.key === `crash:${secondInstance.process_instance_id}`);
        assert.strictEqual(wrong.length, 0, 'a graceful stop was reported as a crash');
      } finally {
        await third.stop();
        await hook.close();
      }
      notes.push('zamanlayıcı gerçekten koştu: 200 ms kalp atışları yazıldı, günlük rapor kendiliğinden saklandı (maç yokken '
        + 'PASS değil, maç listesi saklanmadı), tabloya eklenen tutarsızlık için kendiliğinden tek alarm gitti; SIGKILL ile '
        + 'öldürülen süreç yeniden başlatmada çökme alarmı üretti, SIGTERM ile kapanan üretmedi');
    }
  } finally {
    await db.end().catch(() => {});
  }
  return notes.join(' · ');
};

module.exports.needsDatabase = true;
