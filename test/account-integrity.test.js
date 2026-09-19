/**
 * Account and match-record integrity. Needs a real, isolated PostgreSQL.
 *
 * Four problems, all of them about the gap between "the application meant to"
 * and "the database will let you":
 *
 *   1. Nothing stopped one account being on BOTH sides of a game. Two tabs
 *      signed into the same account could be matched with each other, and the
 *      stats query counts a row once per player — so that row is a win against
 *      nobody, available on demand.
 *
 *   2. A match was recorded by a plain INSERT, so anything that saved the same
 *      game twice put two games in everybody's record.
 *
 *   3. Ending a session only touched the database. Connections already holding
 *      that identity kept it, and recovery restored it after a drop.
 *
 *   4. Deleting an account ran as two independent statements, so a failure
 *      between them signed the player out everywhere without deleting them. Its
 *      tombstone username was `silinmis_<id>` — which any player could have
 *      registered first, making the deletion fail on the UNIQUE constraint.
 */
const assert = require('assert');
const { Client } = require('pg');
const { startTestServer, connectClient, waitFor, waitForAll, submit } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A direct connection, for asserting on rows rather than on what the API says. */
async function openDb(url) {
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function registerAccount(server, username, password = 'sifre123') {
  const res = await fetch(`${server.url}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  assert.ok(body.token, `register failed for ${username}: ${JSON.stringify(body)}`);
  return body;
}

module.exports = async function run({ databaseUrl }) {
  // server/db.js reads DATABASE_URL when it is first loaded, so the module is
  // required here — after pointing it at the THROWAWAY database this test was
  // given. It is set explicitly rather than inherited: an inherited value could
  // be a production one, and these tests write.
  process.env.DATABASE_URL = databaseUrl;
  // eslint-disable-next-line global-require
  const accounts = require('../server/accounts');
  // Requiring it opens a connection pool in THIS process. Left open, it keeps
  // handles and work in the event loop for every test that runs after this one —
  // which is how a later test with tight timing started failing only when a
  // database was present.
  // eslint-disable-next-line global-require
  const accountsDb = require('../server/db');

  const notes = [];
  const server = await startTestServer({ DATABASE_URL: databaseUrl, MAX_ROUNDS: '1' });
  const db = await openDb(databaseUrl);

  try {
    // --- 1. one account cannot be matched against itself --------------------
    {
      const mine = await registerAccount(server, 'ayni_hesap');
      const other = await registerAccount(server, 'baska_hesap');

      // Two tabs, one account.
      const [tabA, tabB] = await Promise.all([
        connectClient(server.url, { token: mine.token }),
        connectClient(server.url, { token: mine.token }),
      ]);
      const matches = [];
      tabA.on('matched', (m) => matches.push(m.opponentName));
      tabB.on('matched', (m) => matches.push(m.opponentName));

      tabA.emit('joinQueue', { name: 'Ali' });
      await waitFor(tabA, 'waiting', 8000);
      tabB.emit('joinQueue', { name: 'Ali' });
      await sleep(800);

      assert.deepStrictEqual(matches, [],
        `an account was matched against itself (${matches.join(', ')})`);

      // A different account still finds a game immediately, so the queue was
      // not simply broken. Note the stranger has to be found BEHIND the player's
      // own second tab: an earlier version of this stopped scanning at the
      // same-account socket, which left both of them waiting for nobody.
      const third = await connectClient(server.url, { token: other.token });
      const paired = waitFor(tabA, 'matched', 8000);
      third.emit('joinQueue', { name: 'Veli' });
      await paired;

      // tabB is still waiting, and a fourth player finds IT rather than nobody:
      // being set aside must not drop you out of the queue.
      const fourth = await connectClient(server.url);
      const pairedB = waitFor(tabB, 'matched', 8000);
      fourth.emit('joinQueue', { name: 'Dordu' });
      await pairedB;

      notes.push('aynı hesap kendisiyle eşleşmiyor; arkadaki yabancı bulunuyor, kenara alınan sekme kuyrukta kalıyor');
      tabA.close();
      tabB.close();
      third.close();
      fourth.close();
    }

    // --- 2. and cannot join its own invite ----------------------------------
    {
      const mine = await registerAccount(server, 'davet_hesabi');
      const [host, guest] = await Promise.all([
        connectClient(server.url, { token: mine.token }),
        connectClient(server.url, { token: mine.token }),
      ]);

      const created = waitFor(host, 'privateRoomCreated', 8000);
      host.emit('createPrivateRoom', { name: 'Ali' });
      const { code } = await created;

      const refused = waitFor(guest, 'errorMessage', 8000);
      const matched = [];
      guest.on('matched', (m) => matched.push(m));
      guest.emit('joinPrivateRoom', { name: 'Ali', code });
      const message = (await refused).message;
      await sleep(400);

      assert.deepStrictEqual(matched, [], 'an account joined its own invite');
      assert.ok(/kendinle/i.test(message), `unexpected refusal: "${message}"`);

      notes.push(`kendi davetine aynı hesapla katılma reddedildi: "${message}"`);
      host.close();
      guest.close();
    }

    // --- 3. the database refuses a self-match even if the code does not -----
    {
      const { rows } = await db.query("SELECT id FROM players WHERE username = 'baska_hesap'");
      const id = rows[0].id;
      let failed = null;
      try {
        await db.query(
          `INSERT INTO matches (player_a, player_b, score_a, score_b, winner_id, match_uid)
           VALUES ($1, $1, 3, 3, $1, 'elle-yazilmis')`,
          [id],
        );
      } catch (err) {
        failed = err.constraint || err.message;
      }
      assert.ok(failed, 'the database accepted a match with one player on both sides');
      assert.strictEqual(failed, 'matches_distinct_players',
        `refused, but by the wrong rule: ${failed}`);

      notes.push('veritabanı kısıtı aynı oyuncuyu iki tarafta reddediyor (matches_distinct_players)');
    }

    // --- 4. saving the same game twice writes one row -----------------------
    {
      const a = await registerAccount(server, 'kayit_bir');
      const b = await registerAccount(server, 'kayit_iki');
      const ids = await db.query(
        "SELECT id, username FROM players WHERE username IN ('kayit_bir','kayit_iki') ORDER BY username",
      );
      const [idA, idB] = ids.rows.map((r) => r.id);
      assert.ok(a.token && b.token);

      const uid = 'ayni-oyun-kimligi';
      const first = await accounts.recordMatch({
        matchUid: uid, playerAId: idA, playerBId: idB, scoreA: 9, scoreB: 3, winnerId: idA,
      });
      const second = await accounts.recordMatch({
        matchUid: uid, playerAId: idA, playerBId: idB, scoreA: 9, scoreB: 3, winnerId: idA,
      });
      assert.strictEqual(first, true, 'the first save should write the row');
      assert.strictEqual(second, false, 'the second save should write nothing');

      const { rows: saved } = await db.query('SELECT COUNT(*)::int AS n FROM matches WHERE match_uid = $1', [uid]);
      assert.strictEqual(saved[0].n, 1, `${saved[0].n} rows for one game`);

      // And the code refuses a self-match before the database has to.
      const selfMatch = await accounts.recordMatch({
        matchUid: 'kendine-karsi', playerAId: idA, playerBId: idA, scoreA: 1, scoreB: 1, winnerId: idA,
      });
      assert.strictEqual(selfMatch, false, 'recordMatch accepted one player on both sides');

      notes.push('aynı oyun kimliğiyle iki kayıt denemesi -> 1 satır; kendine karşı kayıt reddedildi');
    }

    // --- 5. a real game is recorded exactly once, a rematch separately ------
    {
      const a = await registerAccount(server, 'mac_bir');
      const b = await registerAccount(server, 'mac_iki');
      const [x, y] = await Promise.all([
        connectClient(server.url, { token: a.token }),
        connectClient(server.url, { token: b.token }),
      ]);
      const matched = Promise.all([waitFor(x, 'matched', 8000), waitFor(y, 'matched', 8000)]);
      x.emit('joinQueue', { name: 'Ali' });
      y.emit('joinQueue', { name: 'Veli' });
      await matched;

      const playOneRound = async () => {
        await waitForAll([x, y], 'openTeamSubmit', 15000);
        const accepted = Promise.all([waitFor(x, 'teamAccepted', 8000), waitFor(y, 'teamAccepted', 8000)]);
        submit(x, 'submitTeam', { team: 'Chelsea' });
        submit(y, 'submitTeam', { team: 'Liverpool' });
        await accepted;
        await waitForAll([x, y], 'openGuess', 15000);
        const over = Promise.all([waitFor(x, 'gameOver', 20000), waitFor(y, 'gameOver', 20000)]);
        submit(x, 'submitGuess', { guess: 'Mohamed Salah' });
        await over;
      };

      await playOneRound();
      await sleep(600);
      let { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM matches m
         JOIN players pa ON pa.id = m.player_a JOIN players pb ON pb.id = m.player_b
         WHERE pa.username = 'mac_bir' AND pb.username = 'mac_iki'`,
      );
      assert.strictEqual(rows[0].n, 1, `one game recorded ${rows[0].n} times`);

      // Rematch: the same room, a new game, so a second row with its own id.
      const restarting = waitFor(x, 'rematchStarting', 10000);
      x.emit('requestRematch', {});
      y.emit('requestRematch', {});
      await restarting;
      await playOneRound();
      await sleep(600);

      ({ rows } = await db.query(
        `SELECT COUNT(*)::int AS n, COUNT(DISTINCT match_uid)::int AS ids FROM matches m
         JOIN players pa ON pa.id = m.player_a
         WHERE pa.username = 'mac_bir'`,
      ));
      assert.strictEqual(rows[0].n, 2, `after a rematch there should be 2 games, found ${rows[0].n}`);
      assert.strictEqual(rows[0].ids, 2, 'the rematch reused the first game\'s id');

      notes.push('gerçek maç 1 satır, rövanş ayrı satır (2 farklı oyun kimliği)');
      x.close();
      y.close();
    }

    // --- 6. signing out reaches the connection, not just the database -------
    {
      const a = await registerAccount(server, 'cikis_hesabi');
      const socket = await connectClient(server.url, { token: a.token });
      const ended = waitFor(socket, 'sessionEnded', 8000);

      const res = await fetch(`${server.url}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.token}` },
      });
      assert.strictEqual(res.status, 200, 'logout should succeed');
      await ended;

      // The token is dead on the server too.
      const me = await fetch(`${server.url}/api/me`, {
        headers: { Authorization: `Bearer ${a.token}` },
      });
      assert.strictEqual(me.status, 401, `the revoked token still works (${me.status})`);

      notes.push('çıkış açık bağlantıya "sessionEnded" olarak ulaştı, jeton sunucuda da ölü');
      socket.close();
    }

    // --- 7. and revocation survives a reconnect -----------------------------
    // Recovery restores socket.data and skips the middlewares, so the identity
    // that comes back is the one from before the drop. It is re-checked.
    //
    // The player has to be inside a match before dropping: Socket.IO only keeps
    // a recovery session for a connection that has state to recover, so a socket
    // that has merely connected comes back as a brand new one (measured — a bare
    // connect/drop/reconnect gives recovered === false).
    {
      const a = await registerAccount(server, 'kurtarma_hesabi');
      const other = await registerAccount(server, 'kurtarma_rakip');
      const [mine, opponent] = await Promise.all([
        connectClient(server.url, { token: a.token }),
        connectClient(server.url, { token: other.token }),
      ]);
      const matched = Promise.all([waitFor(mine, 'matched', 8000), waitFor(opponent, 'matched', 8000)]);
      mine.emit('joinQueue', { name: 'Ali' });
      opponent.emit('joinQueue', { name: 'Veli' });
      await matched;
      await waitForAll([mine, opponent], 'openTeamSubmit', 15000);

      const originalId = mine.id;
      const down = waitFor(mine, 'disconnect', 5000);
      mine.io.engine.close();
      await down;

      // Signed out from somewhere else while this connection was away.
      const out = await fetch(`${server.url}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.token}` },
      });
      assert.strictEqual(out.status, 200, 'logout should succeed');

      const ended = waitFor(mine, 'sessionEnded', 8000);
      const up = waitFor(mine, 'connect', 8000);
      mine.connect();
      await up;
      assert.strictEqual(mine.id, originalId, 'this should be a recovered connection');
      assert.strictEqual(mine.recovered, true, 'connection state recovery did not happen');
      await ended;

      // The token really is dead, and the identity really is gone: the game
      // finishes but is not recorded against the signed-out player.
      const me = await fetch(`${server.url}/api/me`, {
        headers: { Authorization: `Bearer ${a.token}` },
      });
      assert.strictEqual(me.status, 401, `the revoked token still works (${me.status})`);

      await waitForAll([mine, opponent], 'openTeamSubmit', 25000);
      const accepted = Promise.all([waitFor(mine, 'teamAccepted', 8000), waitFor(opponent, 'teamAccepted', 8000)]);
      submit(mine, 'submitTeam', { team: 'Chelsea' });
      submit(opponent, 'submitTeam', { team: 'Liverpool' });
      await accepted;
      await waitForAll([mine, opponent], 'openGuess', 15000);
      const over = Promise.all([waitFor(mine, 'gameOver', 20000), waitFor(opponent, 'gameOver', 20000)]);
      submit(mine, 'submitGuess', { guess: 'Mohamed Salah' });
      await over;
      await sleep(700);

      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM matches m
         JOIN players p ON p.id = m.player_a OR p.id = m.player_b
         WHERE p.username = 'kurtarma_hesabi'`,
      );
      assert.strictEqual(rows[0].n, 0,
        'a game was recorded for an identity whose session had been revoked');

      notes.push('yeniden bağlanma iptal edilmiş oturumu geri getirmiyor; maç bitti ama kayda geçmedi');
      mine.close();
      opponent.close();
    }

    // --- 8. deletion is atomic, and its tombstone cannot collide ------------
    {
      // Somebody has already taken the name the OLD tombstone would have used.
      const victim = await registerAccount(server, 'silinecek');
      const { rows: vrows } = await db.query("SELECT id FROM players WHERE username = 'silinecek'");
      const victimId = vrows[0].id;
      const squatter = `silinmis_${victimId}`;
      await registerAccount(server, squatter);

      // Two delete requests at once.
      const deleteOnce = () => fetch(`${server.url}/api/account/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${victim.token}` },
        body: JSON.stringify({ password: 'sifre123' }),
      }).then((r) => r.status);

      const [first, second] = await Promise.all([deleteOnce(), deleteOnce()]);
      const statuses = [first, second].sort();
      assert.ok(statuses.includes(200),
        `neither concurrent delete succeeded (${statuses.join(', ')})`);
      assert.ok(!statuses.every((code) => code === 200),
        'both concurrent deletes reported success; the second should find nothing to do');

      const { rows } = await db.query(
        'SELECT username, display_name, password_hash, deleted_at FROM players WHERE id = $1',
        [victimId],
      );
      assert.strictEqual(rows[0].username, `deleted:${victimId}`,
        `tombstone username is "${rows[0].username}"`);
      assert.ok(rows[0].deleted_at, 'the account was not marked deleted');
      assert.strictEqual(rows[0].password_hash, '', 'the password hash was left behind');

      const { rows: sess } = await db.query('SELECT COUNT(*)::int AS n FROM sessions WHERE player_id = $1', [victimId]);
      assert.strictEqual(sess[0].n, 0, 'sessions survived the deletion');

      // The squatter is untouched, and the tombstone could never be registered
      // anyway: usernames are [a-z0-9_], so a colon is unreachable.
      const { rows: sq } = await db.query('SELECT deleted_at FROM players WHERE username = $1', [squatter]);
      assert.ok(sq[0] && !sq[0].deleted_at, 'the unrelated account was affected');
      const taken = await fetch(`${server.url}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `deleted:${victimId}`, password: 'sifre123' }),
      });
      assert.strictEqual(taken.status, 400,
        `the tombstone username was registerable (${taken.status})`);

      notes.push(`eşzamanlı iki silme: ${statuses.join('/')}; mezar taşı "deleted:${victimId}" (kayıt edilemez), oturumlar silindi, "${squatter}" etkilenmedi`);
    }

    // --- 9. a route that throws answers, rather than hanging -----------------
    // Express 4 does not catch a rejection from an async handler, so a failing
    // route used to answer nothing at all: the client waited out its own
    // timeout, which looks exactly like the server being down. Found while
    // reproducing the deletion collision above — the UNIQUE violation hung that
    // request for almost six minutes instead of failing it.
    //
    // A separate server is pointed at a database that is not there. isEnabled()
    // is true (the pool exists), so the request goes through to a query that
    // cannot succeed — the only way to reach the throwing path deliberately.
    {
      const broken = await startTestServer({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/yok' });
      try {
        const started = Date.now();
        const res = await fetch(`${broken.url}/api/me`, {
          headers: { Authorization: 'Bearer herhangi' },
        });
        const took = Date.now() - started;

        assert.strictEqual(res.status, 500, `expected 500 from a broken database, got ${res.status}`);
        const body = await res.json().catch(() => ({}));
        assert.strictEqual(body.error, 'server_error', `unexpected body: ${JSON.stringify(body)}`);
        assert.ok(took < 8000, `the request took ${took}ms — it should fail, not hang`);
        assert.ok(broken.isAlive(), 'a failing request killed the server');

        // The game itself does not need the database and still works.
        const health = await fetch(`${broken.url}/healthz`);
        assert.strictEqual(health.status, 200, 'the server stopped answering after a failed query');

        notes.push(`veritabanı ölüyken istek ${took}ms içinde 500 döndü (askıda kalmıyor), sunucu ayakta`);
      } finally {
        await broken.stop();
      }
    }

    return notes.join(' · ');
  } finally {
    await db.end().catch(() => {});
    await accountsDb.close().catch(() => {});
    await server.stop();
  }
};

// Set AFTER the assignment above: `module.exports = fn` replaces the whole
// object, so a flag written before it is thrown away — and the runner then
// skipped the truncate and ran this against the previous run's rows.
module.exports.needsDatabase = true;
