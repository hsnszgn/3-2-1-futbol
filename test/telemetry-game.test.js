/**
 * M2: the measurement events a REAL game produces, end to end. Needs a real,
 * isolated PostgreSQL.
 *
 * The unit tests prove the module stores what it is given. This one proves the
 * server gives it the right things at the right moments — by playing games
 * through the real server and reading the rows back — and that the report's
 * classifier, fed those rows, reaches the right class. A hook in the wrong place
 * (a "finished" event before the score is frozen, a start event after the first
 * round, a client notice accepted for someone else's game) passes every unit
 * test and fails here.
 *
 * Not covered here, and not claimed: phase_rendered and client_error are not
 * implemented yet; a real browser drawing the result screen is covered by the
 * browser suite, not by these socket clients.
 */
const assert = require('assert');
const { Client } = require('pg');
const { startTestServer, connectClient, waitFor, waitForAll, waitForAccounts, submit } = require('./helpers');
const { classifyGames } = require('../server/betaMetrics');
const { reconcile } = require('../scripts/check-match-integrity');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openDb(url) {
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function register(server, username) {
  await waitForAccounts(server);
  const res = await fetch(`${server.url}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'sifre123' }),
  });
  const body = await res.json();
  assert.ok(body.token, `register failed for ${username}: ${JSON.stringify(body)}`);
  return body;
}

/** Plays one single-round game to the end and returns both gameOver payloads. */
async function playOneRound(x, y) {
  await waitForAll([x, y], 'openTeamSubmit', 15000);
  const accepted = Promise.all([waitFor(x, 'teamAccepted', 8000), waitFor(y, 'teamAccepted', 8000)]);
  submit(x, 'submitTeam', { team: 'Chelsea' });
  submit(y, 'submitTeam', { team: 'Liverpool' });
  await accepted;
  await waitForAll([x, y], 'openGuess', 15000);
  const over = Promise.all([waitFor(x, 'gameOver', 20000), waitFor(y, 'gameOver', 20000)]);
  submit(x, 'submitGuess', { guess: 'Mohamed Salah' });
  return over;
}

async function pair(server, authA, authB) {
  const [x, y] = await Promise.all([
    connectClient(server.url, authA),
    connectClient(server.url, authB),
  ]);
  const matched = Promise.all([waitFor(x, 'matched', 8000), waitFor(y, 'matched', 8000)]);
  x.emit('joinQueue', { name: 'Ali' });
  y.emit('joinQueue', { name: 'Veli' });
  await matched;
  return [x, y];
}

/** Waits until the queue has written what the test is about to read. */
async function eventsFor(db, gameId, { until, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query(
      `SELECT event_id, event_type, game_id, attempt_id, seat, source, reason_code, details,
              traffic_kind, environment, beta_cohort_id, release_sha, process_instance_id,
              server_occurred_at, stored_at
         FROM telemetry_events WHERE game_id = $1 ORDER BY server_occurred_at, stored_at`, [gameId]);
    if (!until || until(rows) || Date.now() > deadline) return rows;
    await sleep(50);
  }
}

const types = (rows) => rows.map((r) => r.event_type);
const count = (rows, type) => rows.filter((r) => r.event_type === type).length;

module.exports = async function run({ databaseUrl }) {
  const notes = [];
  const db = await openDb(databaseUrl);
  const env = {
    DATABASE_URL: databaseUrl,
    MAX_ROUNDS: '1',
    TELEMETRY_ENABLED: '1',
    TELEMETRY_ENVIRONMENT: 'beta',
    TELEMETRY_TRAFFIC_KIND: 'human_beta',
    TELEMETRY_COHORT_ID: 'beta-e2e',
    RELEASE_SHA: 'e2e-sha',
  };
  const server = await startTestServer(env);
  const sockets = [];

  try {
    await waitForAccounts(server);

    // --- 1. a guest game: the whole sequence, in order, and classified C ----
    {
      const [x, y] = await pair(server, {}, {});
      sockets.push(x, y);
      const [overX, overY] = await playOneRound(x, y);
      assert.ok(overX.gameId && overX.gameId === overY.gameId, 'gameOver does not name the game');
      const gameId = overX.gameId;
      // The real client sends this after drawing the result screen. These socket
      // clients send it for the same game id, once each.
      x.emit('resultRendered', { gameId });
      y.emit('resultRendered', { gameId });

      const rows = await eventsFor(db, gameId, { until: (r) => count(r, 'result_rendered') === 2 });
      const seq = types(rows);
      assert.strictEqual(seq[0], 'game_started', `the first event is ${seq[0]}: ${seq.join(', ')}`);
      assert.strictEqual(count(rows, 'game_started'), 1);
      assert.strictEqual(count(rows, 'round_scored'), 1, `rounds: ${seq.join(', ')}`);
      assert.strictEqual(count(rows, 'game_finished'), 1);
      // The finish comes after the scored round, not before it.
      assert.ok(seq.indexOf('round_scored') < seq.indexOf('game_finished'),
        `game_finished was recorded before the round it depends on: ${seq.join(', ')}`);

      const scored = rows.find((r) => r.event_type === 'round_scored');
      const finished = rows.find((r) => r.event_type === 'game_finished');
      assert.strictEqual(scored.details.points, 3);
      assert.ok(Number.isInteger(scored.attempt_id), 'the scored round is not tied to its attempt');
      const winnerSeat = scored.details.scored_seat;
      const expected = winnerSeat === 'A' ? [3, 0] : [0, 3];
      assert.deepStrictEqual([finished.details.score_a, finished.details.score_b], expected,
        `the final score does not match the scored round: ${JSON.stringify(finished.details)}`);
      assert.strictEqual(finished.details.winner_seat, winnerSeat);

      const decided = rows.find((r) => r.event_type === 'recording_decided');
      assert.ok(decided, 'no recording decision for a guest game');
      assert.strictEqual(decided.details.decision, 'skip');
      assert.strictEqual(decided.reason_code, 'guest_seat',
        `a guest game's skipped record was explained as ${decided.reason_code}`);

      const rendered = rows.filter((r) => r.event_type === 'result_rendered');
      assert.deepStrictEqual(rendered.map((r) => r.seat).sort(), ['A', 'B']);
      assert.ok(rendered.every((r) => r.source === 'client'), 'a screen notice was stored as a server fact');

      // The contract's labels, from SERVER configuration.
      assert.ok(rows.every((r) => r.traffic_kind === 'human_beta' && r.environment === 'beta'
        && r.beta_cohort_id === 'beta-e2e' && r.release_sha === 'e2e-sha'), 'labels are missing or mixed');
      // Nothing that identifies a person.
      const all = JSON.stringify(rows);
      for (const needle of ['Ali', 'Veli', 'Mohamed Salah', 'Chelsea', 'Liverpool']) {
        assert.ok(!all.includes(needle), `"${needle}" reached the measurement table`);
      }

      const klass = classifyGames(rows, { liveProcesses: new Set() }).get(gameId);
      assert.strictEqual(klass.klass, 'C', `a clean guest game classified as ${JSON.stringify(klass)}`);
      notes.push(`misafir maçı: ${seq.join(' → ')}; skor turdan türüyor, kayıt kararı "guest_seat", `
        + 'iki ekran bildirimi source=client, isim/cevap/takım tabloya girmedi, sınıflandırma C');

      // --- 2. notices that must NOT count ----------------------------------
      x.emit('resultRendered', { gameId }); // a replay
      y.emit('resultRendered', { gameId: 'someone-elses-game' }); // wrong game
      y.emit('resultRendered', {}); // no game at all
      const stranger = await connectClient(server.url, {});
      sockets.push(stranger);
      stranger.emit('resultRendered', { gameId }); // not seated in this room
      await sleep(400);
      const after = await eventsFor(db, gameId);
      assert.strictEqual(count(after, 'result_rendered'), 2,
        `replayed/foreign notices were stored: ${count(after, 'result_rendered')} result_rendered rows`);
      const foreign = await db.query("SELECT 1 FROM telemetry_events WHERE game_id = 'someone-elses-game'");
      assert.strictEqual(foreign.rowCount, 0, 'a notice for a game the socket is not in was stored');
      notes.push('tekrar edilen, başka maça ait, maç kimliksiz ve odada olmayan soketten gelen bildirimler yazılmadı');

      // --- 3. a rematch is a new game; a late notice for the old one is dropped
      const rematch = Promise.all([waitFor(x, 'rematchStarting', 8000), waitFor(y, 'rematchStarting', 8000)]);
      x.emit('requestRematch');
      y.emit('requestRematch');
      await rematch;
      const [second] = await playOneRound(x, y);
      assert.notStrictEqual(second.gameId, gameId, 'the rematch reused the first game id');
      const secondRows = await eventsFor(db, second.gameId, { until: (r) => count(r, 'game_finished') === 1 });
      const secondStart = secondRows.find((r) => r.event_type === 'game_started');
      assert.strictEqual(secondStart.details.rematch_of, gameId, 'the rematch does not name the game it followed');
      // Neither player has confirmed the SECOND game yet. Two notices arrive
      // that must not confirm it: the first game's id, late, from a seat that
      // has not confirmed game two; and a made-up id from the other seat. The
      // danger is not the old game's count — it is a notice about one game
      // being credited to another, which would make an unseen result look seen.
      const lateCountBefore = count(await eventsFor(db, gameId), 'result_rendered');
      x.emit('resultRendered', { gameId });
      y.emit('resultRendered', { gameId: 'someone-elses-game' });
      await sleep(400);
      assert.strictEqual(count(await eventsFor(db, gameId), 'result_rendered'), lateCountBefore,
        'a late notice for the previous game was accepted after the rematch');
      assert.strictEqual(count(await eventsFor(db, second.gameId), 'result_rendered'), 0,
        'a notice naming another game was credited to the current one');
      // The genuine notices for game two are then accepted.
      x.emit('resultRendered', { gameId: second.gameId });
      y.emit('resultRendered', { gameId: second.gameId });
      const confirmed = await eventsFor(db, second.gameId, { until: (r) => count(r, 'result_rendered') === 2 });
      assert.strictEqual(count(confirmed, 'result_rendered'), 2);
      notes.push('rövanş yeni maç kimliği ve rematch_of taşıyor; eski maça geç gelen ve uydurma kimlikli '
        + 'bildirimler YENİ maça da yazılmadı, gerçek bildirimler kabul edildi');

      // --- 4. an explicit leave mid-game is V, and says so -----------------
      const rematch2 = Promise.all([waitFor(x, 'rematchStarting', 8000), waitFor(y, 'rematchStarting', 8000)]);
      x.emit('requestRematch');
      y.emit('requestRematch');
      await rematch2;
      await waitForAll([x, y], 'openTeamSubmit', 15000);
      const third = (await db.query(
        `SELECT game_id FROM telemetry_events WHERE event_type = 'game_started'
           AND details->>'rematch_of' = $1`, [second.gameId])).rows[0].game_id;
      const left = waitFor(y, 'opponentLeft', 8000);
      x.emit('leaveRoom');
      await left;
      const thirdRows = await eventsFor(db, third, { until: (r) => count(r, 'game_aborted') === 1 });
      const aborted = thirdRows.find((r) => r.event_type === 'game_aborted');
      assert.ok(aborted, `no abort event for a game left mid-way: ${types(thirdRows).join(', ')}`);
      assert.strictEqual(aborted.reason_code, 'left');
      assert.strictEqual(count(thirdRows, 'game_finished'), 0);
      const thirdClass = classifyGames(thirdRows, { liveProcesses: new Set() }).get(third);
      assert.strictEqual(thirdClass.klass, 'V', `an explicit leave classified as ${JSON.stringify(thirdClass)}`);
      notes.push('maç ortasında açık ayrılma: game_aborted/left, sınıflandırma V, game_finished yok');
    }

    // --- 5. a signed-in game is persisted, and reconciliation agrees ---------
    {
      const a = await register(server, 'olcum_bir');
      const b = await register(server, 'olcum_iki');
      const [x, y] = await pair(server, { token: a.token }, { token: b.token });
      sockets.push(x, y);
      const [over] = await playOneRound(x, y);
      x.emit('resultRendered', { gameId: over.gameId });
      y.emit('resultRendered', { gameId: over.gameId });
      const rows = await eventsFor(db, over.gameId, {
        until: (r) => count(r, 'match_persisted') === 1 && count(r, 'result_rendered') === 2,
      });
      const decided = rows.find((r) => r.event_type === 'recording_decided');
      assert.strictEqual(decided.details.decision, 'persist');
      assert.strictEqual(decided.reason_code, 'both_signed_in');
      assert.strictEqual(count(rows, 'match_persisted'), 1, `events: ${types(rows).join(', ')}`);
      const matchRows = (await db.query(
        'SELECT id, match_uid, player_a, player_b, score_a, score_b, winner_id FROM matches WHERE match_uid = $1',
        [over.gameId])).rows;
      assert.strictEqual(matchRows.length, 1, 'the persisted game has no row');
      const { findings } = reconcile({ events: rows, matchRows });
      assert.deepStrictEqual(findings, [], `reconciliation disagrees with a clean game: ${JSON.stringify(findings)}`);
      assert.strictEqual(classifyGames(rows, {}).get(over.gameId).klass, 'C');
      notes.push('girişli maç: recording_decided/persist → match_persisted, matches satırı var, '
        + 'uzlaştırma bulgu üretmedi, sınıflandırma C');
    }
  } finally {
    for (const s of sockets) s.close();
    await server.stop();
  }

  // --- 6. the durable-start gate (M3), against a database that is down -------
  {
    // Accounts are off (the database is unreachable), but a DATABASE_URL is
    // configured, so measurement is SUPPOSED to work. With the gate on, a game
    // must not start unmeasured: both players are told why and nothing is played.
    const gated = await startTestServer({
      ...env,
      DATABASE_URL: 'postgres://postgres@127.0.0.1:59999/postgres',
      TELEMETRY_REQUIRE_DURABLE_START: '1',
      TELEMETRY_MAX_ATTEMPTS: '2',
      TELEMETRY_RETRY_BASE_MS: '50',
      MIGRATE_RETRY_MS: '600000',
    });
    const clients = [];
    try {
      const [x, y] = await pair(gated, {}, {});
      clients.push(x, y);
      let roundOpened = false;
      x.on('openTeamSubmit', () => { roundOpened = true; });
      const [goneX, goneY] = await Promise.all([waitFor(x, 'roomGone', 15000), waitFor(y, 'roomGone', 15000)]);
      assert.strictEqual(goneX.reason, 'measurement_unavailable');
      assert.strictEqual(goneY.reason, 'measurement_unavailable');
      await sleep(300);
      assert.strictEqual(roundOpened, false, 'a round started although the game start could not be stored');
      notes.push('kalıcı başlangıç kapısı açıkken veritabanı erişilemez: tur hiç açılmadı, iki oyuncuya '
        + '"measurement_unavailable" ile söylendi');
    } finally {
      for (const s of clients) s.close();
      await gated.stop();
    }

    // And with the gate on and the database working, the start is stored BEFORE
    // the first round opens.
    const working = await startTestServer({ ...env, TELEMETRY_REQUIRE_DURABLE_START: '1' });
    const clients2 = [];
    try {
      await waitForAccounts(working);
      const [x, y] = await pair(working, {}, {});
      clients2.push(x, y);
      await waitForAll([x, y], 'openTeamSubmit', 15000);
      const openedAt = new Date();
      const { rows } = await db.query(
        `SELECT stored_at FROM telemetry_events WHERE event_type = 'game_started'
          ORDER BY stored_at DESC LIMIT 1`);
      assert.ok(rows.length && rows[0].stored_at <= openedAt,
        'the first round opened before the game start was stored');
      notes.push('kapı açık ve veritabanı çalışıyor: game_started ilk tur açılmadan önce saklandı');
    } finally {
      for (const s of clients2) s.close();
      await working.stop();
    }
  }

  // --- 7. switched off (the default): a real game stores nothing ------------
  // The events are not in the data inventory with a retention rule yet, so the
  // deployment default must be to collect nothing. This is the evidence that
  // shipping this code does not start collecting on its own.
  {
    const { rows: [{ n: before }] } = await db.query('SELECT count(*)::int AS n FROM telemetry_events');
    const offEnv = { ...env };
    delete offEnv.TELEMETRY_ENABLED;
    const off = await startTestServer(offEnv);
    const clients = [];
    try {
      await waitForAccounts(off);
      const [x, y] = await pair(off, {}, {});
      clients.push(x, y);
      const [over] = await playOneRound(x, y);
      x.emit('resultRendered', { gameId: over.gameId });
      y.emit('resultRendered', { gameId: over.gameId });
      await sleep(600);
      const { rows: [{ n: after }] } = await db.query('SELECT count(*)::int AS n FROM telemetry_events');
      assert.strictEqual(after, before,
        `with TELEMETRY_ENABLED unset a game still wrote ${after - before} measurement row(s)`);
      notes.push('TELEMETRY_ENABLED ayarlı değilken (varsayılan) tam bir maç oynandı: tabloya 0 satır yazıldı');
    } finally {
      for (const s of clients) s.close();
      await off.stop();
    }
  }

  await db.end().catch(() => {});
  return notes.join(' · ');
};

module.exports.needsDatabase = true;
