/**
 * M2/M7: error events, the recovery notice and its replay, and what must never
 * reach the measurement table. Needs a real, isolated PostgreSQL.
 *
 * Every failure here is produced for real, not faked in the table:
 *   - a socket handler that throws (fixture knob: matching explodes on a word);
 *   - an HTTP route whose database call fails — a real lock plus a short
 *     statement timeout, the same technique account-integrity uses;
 *   - a Wikidata outage, through the real lookup code (the query service
 *     answers 503);
 *   - a client reporting its own error over the socket;
 *   - a real Socket.IO connection-state recovery in the middle of a round.
 *
 * And every one of them is given a secret to leak — a password, a session token,
 * a username, a typed answer, a request body — and the whole table is then
 * searched for each of them.
 */
const assert = require('assert');
const { Client } = require('pg');
const { startTestServer, connectClient, waitFor, waitForAll, waitForAccounts, submit } = require('./helpers');
const { recoverySummary } = require('../server/betaMetrics');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SECRETS = {
  password: 'GIZLI-parola-7731',
  username: 'gizli_oyuncu_42',
  guess: 'GIZLI-CEVAP-9981',
  body: 'GIZLI-GOVDE-5512',
  clientText: 'GIZLI-ISTEMCI-3303',
};

async function openDb(url) {
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function rows(db, where = 'TRUE', params = []) {
  return (await db.query(
    `SELECT event_id, event_type, game_id, attempt_id, seat, source, reason_code, details
       FROM telemetry_events WHERE ${where} ORDER BY stored_at`, params)).rows;
}

async function until(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > deadline) return value;
    await sleep(50);
  }
}

async function pair(server, authA = {}, authB = {}) {
  const [a, b] = await Promise.all([
    connectClient(server.url, authA), connectClient(server.url, authB),
  ]);
  const matched = Promise.all([waitFor(a, 'matched', 8000), waitFor(b, 'matched', 8000)]);
  a.emit('joinQueue', { name: 'Ali' });
  b.emit('joinQueue', { name: 'Veli' });
  await matched;
  return [a, b];
}

async function toGuessPhase(a, b) {
  await waitForAll([a, b], 'openTeamSubmit', 15000);
  const revealed = waitFor(a, 'teamsRevealed', 15000);
  submit(a, 'submitTeam', { team: 'Chelsea' });
  submit(b, 'submitTeam', { team: 'Liverpool' });
  await revealed;
  await waitForAll([a, b], 'openGuess', 15000);
}

module.exports = async function run({ databaseUrl }) {
  const notes = [];
  const db = await openDb(databaseUrl);
  const base = {
    DATABASE_URL: databaseUrl,
    TELEMETRY_ENABLED: '1',
    TELEMETRY_ENVIRONMENT: 'test',
    MAX_ROUNDS: '2',
    RECOVERY_WINDOW_MS: '30000',
    RECONNECT_GRACE_MS: '30000',
    DB_QUERY_TIMEOUT_MS: '1500',
    TEST_THROW_ON_GUESS: SECRETS.guess,
  };
  const server = await startTestServer(base);
  const sockets = [];
  let token = null;

  try {
    await waitForAccounts(server);
    await db.query('TRUNCATE telemetry_events');

    // A signed-in player, so a real password and a real session token exist.
    const reg = await fetch(`${server.url}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: SECRETS.username, password: SECRETS.password }),
    });
    token = (await reg.json()).token;
    assert.ok(token, 'registration failed');

    // --- 1. a socket handler throws ---------------------------------------
    {
      const [a, b] = await pair(server, { token }, {});
      sockets.push(a, b);
      await toGuessPhase(a, b);
      submit(a, 'submitGuess', { guess: `Salah ${SECRETS.guess}` });
      const found = await until(async () => (await rows(db, "event_type = 'server_error'")).length > 0 && rows(db, "event_type = 'server_error'"));
      assert.ok(found && found.length, 'a throwing socket handler left no server_error');
      const e = found[0];
      assert.strictEqual(e.reason_code, 'socket_handler');
      assert.strictEqual(e.details.where, 'submitGuess');
      assert.strictEqual(e.details.error_kind, 'Error');
      assert.ok(e.game_id, 'the error is not tied to the game it happened in');
      assert.ok(e.seat === 'A' || e.seat === 'B');
      // The round is still playable: the error broke one message, not the game.
      const next = waitFor(a, 'roundResult', 10000);
      submit(b, 'submitGuess', { guess: 'Mohamed Salah' });
      await next;
      notes.push('soket işleyicisi hata fırlattı: server_error/socket_handler, where=submitGuess, maça ve koltuğa bağlı; '
        + 'tur yine oynandı');

      // --- 2. the recovery notice, and its replay --------------------------
      // A real connection-state recovery in the middle of the next round.
      await waitForAll([a, b], 'openTeamSubmit', 15000);
      const id = a.id;
      const down = waitFor(a, 'disconnect', 5000);
      a.io.engine.close();
      await down;
      const synced = waitFor(a, 'phaseSync', 8000);
      const up = waitFor(a, 'connect', 8000);
      a.connect();
      await up;
      assert.strictEqual(a.id, id, 'this was a new connection, not a recovery');
      assert.strictEqual(a.recovered, true);
      const sync = await synced;

      // Before the client confirms, the recovery is recorded but not "visible".
      const disconnects = await until(async () => {
        const r = await rows(db, "event_type IN ('disconnect_observed','recovery_finished')");
        return r.length >= 2 && r;
      });
      const episodeId = disconnects.find((r) => r.event_type === 'disconnect_observed').event_id;
      const finished = disconnects.find((r) => r.event_type === 'recovery_finished');
      assert.strictEqual(finished.reason_code, 'recovered');
      assert.strictEqual(finished.details.episode_id, episodeId, 'the recovery does not name its disconnection');
      let summary = recoverySummary(await rows(db));
      assert.strictEqual(summary.recoveredNotConfirmed, 1, JSON.stringify(summary));
      assert.strictEqual(summary.recoveredVisible, 0);

      // A notice for an OLDER attempt confirms nothing.
      a.emit('phaseRendered', { attempt: sync.attempt - 1, phase: sync.state });
      // A notice for the right attempt but the wrong phase confirms nothing.
      a.emit('phaseRendered', { attempt: sync.attempt, phase: 'player-submit' });
      await sleep(300);
      assert.strictEqual((await rows(db, "event_type = 'phase_rendered'")).length, 0,
        'a stale or wrong-phase notice was accepted as the recovered screen');

      // The real one, then the same one replayed three times.
      for (let i = 0; i < 4; i += 1) a.emit('phaseRendered', { attempt: sync.attempt, phase: sync.state });
      const rendered = await until(async () => {
        const r = await rows(db, "event_type = 'phase_rendered'");
        return r.length && r;
      });
      await sleep(300);
      const allRendered = await rows(db, "event_type = 'phase_rendered'");
      assert.strictEqual(allRendered.length, 1, `a replayed notice was stored ${allRendered.length} times`);
      assert.strictEqual(rendered[0].details.episode_id, episodeId);
      assert.strictEqual(rendered[0].attempt_id, sync.attempt);
      assert.strictEqual(rendered[0].source, 'client');

      // The report side: a duplicated recovery_finished for the same episode
      // (a redelivery under a different event id) still counts once.
      const withDuplicate = [...await rows(db), { ...finished, event_id: 'dup-of-recovery' }];
      summary = recoverySummary(withDuplicate);
      assert.deepStrictEqual(
        [summary.episodes, summary.recoveredVisible, summary.recoveredNotConfirmed, summary.contradictory],
        [1, 1, 0, 0], `replays changed the count: ${JSON.stringify(summary)}`);
      // Two different outcomes for one episode are a contradiction, not a success.
      const contradicted = recoverySummary([...withDuplicate,
        { ...finished, event_id: 'other-outcome', reason_code: 'window_expired' }]);
      assert.strictEqual(contradicted.contradictory, 1);
      assert.strictEqual(contradicted.recoveredVisible, 0);
      notes.push('gerçek recovery: onaydan önce "geri döndü, ekran doğrulanmadı"; eski deneme ve yanlış faz bildirimi '
        + 'kabul edilmedi; doğru bildirim 4 kez gönderildi, 1 kez yazıldı; aynı bölüm için ikinci recovery olayı '
        + 'tek sayıldı, çelişen sonuç "çelişkili"');
    }

    // --- 3. a real database failure behind an HTTP route -------------------
    {
      const blocker = await openDb(databaseUrl);
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE players IN ACCESS EXCLUSIVE MODE');
        const res = await fetch(`${server.url}/api/leaderboard`);
        assert.strictEqual(res.status, 500);
        await blocker.query('COMMIT');
      } finally {
        await blocker.end().catch(() => {});
      }
      const dep = await until(async () => {
        const r = await rows(db, "event_type = 'dependency_error' AND reason_code = 'database'");
        return r.length && r;
      });
      assert.ok(dep, 'a failed database call left no dependency_error');
      assert.strictEqual(dep[0].details.operation, 'leaderboard');
      assert.ok(/^[A-Za-z0-9_]{1,40}$/.test(dep[0].details.error_kind), `error_kind is not a code: ${dep[0].details.error_kind}`);
      notes.push(`gerçek kilit + zaman aşımı: dependency_error/database, operation=leaderboard, error_kind=${dep[0].details.error_kind}`);
    }

    // --- 4. a client's own error: kinds from a list, five at most ----------
    {
      const c = await connectClient(server.url, { token });
      sockets.push(c);
      const before = (await rows(db, "event_type = 'client_error'")).length;
      c.emit('clientError', { kind: 'script_error', screen: 'lobby', message: SECRETS.clientText, stack: SECRETS.clientText });
      c.emit('clientError', { kind: `evil ${SECRETS.clientText}`, screen: 'lobby' }); // not a kind
      c.emit('clientError', { kind: 'unhandled_rejection', screen: SECRETS.clientText }); // not a screen
      for (let i = 0; i < 10; i += 1) c.emit('clientError', { kind: 'resource_error', screen: 'game' });
      await sleep(600);
      const client = (await rows(db, "event_type = 'client_error'")).slice(before);
      assert.strictEqual(client.length, 5, `${client.length} client errors stored from one connection (cap 5)`);
      assert.ok(client.every((r) => r.source === 'client'));
      assert.ok(!client.some((r) => String(r.reason_code).includes('evil')), 'a free-text kind was stored');
      const screens = client.map((r) => r.details.screen);
      assert.ok(screens.every((s) => ['lobby', 'unknown', 'game'].includes(s)), `screens: ${screens.join(',')}`);
      // Junk from a client must not mark the MEASUREMENT as broken — that would
      // let any client switch the beta report to OBSERVABILITY_GAP.
      const degraded = await rows(db, "event_type = 'telemetry_degraded'");
      assert.strictEqual(degraded.length, 0, `client junk degraded the measurement: ${JSON.stringify(degraded)}`);
      notes.push('istemci hatası: listedeki tür kabul edildi, uydurma tür reddedildi, bilinmeyen ekran "unknown" oldu, '
        + 'bağlantı başına 5 sınırı tuttu, istemci çöpü ölçümü "bozuk" işaretlemedi');
    }

    // --- 5. a malformed request is the CLIENT's error ------------------------
    {
      const before = (await rows(db, "event_type = 'server_error'")).length;
      const bad = await fetch(`${server.url}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: `{"username": "${SECRETS.body}", broken`,
      });
      assert.strictEqual(bad.status, 400, `malformed JSON answered ${bad.status}`);
      assert.strictEqual((await bad.json()).error, 'bad_request');
      const huge = await fetch(`${server.url}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x'.repeat(20000) }),
      });
      assert.strictEqual(huge.status, 413, `an oversized body answered ${huge.status}`);
      await sleep(300);
      assert.strictEqual((await rows(db, "event_type = 'server_error'")).length, before,
        'a malformed or oversized request was counted as a server error');
      notes.push('bozuk JSON 400, 8 KB üstü gövde 413 döndü (önceden ikisi de 500 "server_error"); sunucu hatası sayılmadı');
    }
  } finally {
    for (const s of sockets) s.close();
    await server.stop();
  }

  // --- 6. a Wikidata outage, through the real lookup code -------------------
  {
    const down = await startTestServer({ ...base, TEST_WIKIDATA_DOWN: '1', TEST_THROW_ON_GUESS: '' });
    const clients = [];
    try {
      await waitForAccounts(down);
      const [a, b] = await pair(down);
      clients.push(a, b);
      await toGuessPhase(a, b);
      const rejected = waitFor(a, 'guessRejected', 15000);
      submit(a, 'submitGuess', { guess: 'Mohamed Salah' });
      assert.strictEqual((await rejected).reason, 'lookup_failed');
      const dep = await until(async () => {
        const r = await rows(db, "event_type = 'dependency_error' AND reason_code = 'wikidata'");
        return r.length && r;
      });
      assert.ok(dep, 'a Wikidata outage left no dependency_error');
      assert.strictEqual(dep[0].details.operation, 'common_players');
      assert.ok(dep[0].game_id, 'the outage is not tied to the game it broke');
      notes.push('Wikidata 503 (gerçek arama kodu üzerinden): oyuncuya lookup_failed, dependency_error/wikidata '
        + 'operation=common_players, maça bağlı');
    } finally {
      for (const s of clients) s.close();
      await down.stop();
    }
  }

  // --- 7. nothing that identifies a person, or a secret, anywhere ------------
  {
    const all = JSON.stringify((await db.query('SELECT * FROM telemetry_events')).rows);
    const leaked = Object.entries({ ...SECRETS, token }).filter(([, v]) => v && all.includes(v)).map(([k]) => k);
    assert.deepStrictEqual(leaked, [], `secrets reached the measurement table: ${leaked.join(', ')}`);
    const total = (await db.query('SELECT count(*)::int AS n FROM telemetry_events')).rows[0].n;
    notes.push(`${total} olay satırının tamamı tarandı: parola, oturum jetonu, kullanıcı adı, yazılan cevap, `
      + 'istek gövdesi ve istemci metni hiçbirinde yok (hata mesajı ve stack hiç saklanmıyor)');
  }

  await db.end().catch(() => {});
  return notes.join(' · ');
};

module.exports.needsDatabase = true;
