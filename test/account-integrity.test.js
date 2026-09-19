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
      const save = () => accounts.recordMatch({
        matchUid: uid, playerAId: idA, playerBId: idB, scoreA: 9, scoreB: 3, winnerId: idA,
      });

      // Fired together, not one after the other. Sequential calls only show that
      // the second sees the first's row; they say nothing about two saves racing
      // each other, which is the case the unique index actually has to settle.
      // The pool gives each call its own connection.
      const outcomes = await Promise.all([save(), save(), save(), save()]);
      assert.strictEqual(outcomes.filter(Boolean).length, 1,
        `${outcomes.filter(Boolean).length} of 4 concurrent saves claimed to write the row`);

      const { rows: saved } = await db.query('SELECT COUNT(*)::int AS n FROM matches WHERE match_uid = $1', [uid]);
      assert.strictEqual(saved[0].n, 1, `${saved[0].n} rows for one game`);

      // And the code refuses a self-match before the database has to.
      const selfMatch = await accounts.recordMatch({
        matchUid: 'kendine-karsi', playerAId: idA, playerBId: idA, scoreA: 1, scoreB: 1, winnerId: idA,
      });
      assert.strictEqual(selfMatch, false, 'recordMatch accepted one player on both sides');

      notes.push('aynı kimlikle 4 EŞZAMANLI kayıt denemesi -> 1 satır, 1 çağrı yazdığını söylüyor; kendine karşı kayıt reddedildi');
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

    // --- 5b. a rematch during a delayed save writes its own row --------------
    // The same race as test/session-revocation.test.js proves at the recording
    // boundary, carried through to actual rows.
    //
    // It has to be the IDENTITY check that is slow. An earlier version of this
    // held a lock on the matches table instead, which was measured and does not
    // work: the lock delays the INSERT, and by then the game's id has already
    // been read as an argument. The only wait that happens BEFORE that read is
    // the identity re-check, so that is the one to slow down — with the real
    // database still behind it.
    {
      const slow = await startTestServer({
        DATABASE_URL: databaseUrl,
        MAX_ROUNDS: '1',
        NEXT_ROUND_DELAY_MS: '200',
        AUTH_LOOKUP_DELAY_MS: '3500',
      });
      try {
        const a = await registerAccount(slow, 'yaris_bir');
        const b = await registerAccount(slow, 'yaris_iki');
        const [x, y] = await Promise.all([
          connectClient(slow.url, { token: a.token }),
          connectClient(slow.url, { token: b.token }),
        ]);
        const matched = Promise.all([waitFor(x, 'matched', 8000), waitFor(y, 'matched', 8000)]);
        x.emit('joinQueue', { name: 'Ali' });
        y.emit('joinQueue', { name: 'Veli' });
        await matched;

        const playRound = async (winner) => {
          await waitForAll([x, y], 'openTeamSubmit', 20000);
          const ok = Promise.all([waitFor(x, 'teamAccepted', 10000), waitFor(y, 'teamAccepted', 10000)]);
          submit(x, 'submitTeam', { team: 'Chelsea' });
          submit(y, 'submitTeam', { team: 'Liverpool' });
          await ok;
          await waitForAll([x, y], 'openGuess', 20000);
          const over = Promise.all([waitFor(x, 'gameOver', 25000), waitFor(y, 'gameOver', 25000)]);
          submit(winner, 'submitGuess', { guess: 'Mohamed Salah' });
          await over;
        };

        // The drop has to land so that the identity check is STILL RUNNING when
        // the first game ends — otherwise saveMatch never waits and the race is
        // not reached at all. (Measured: dropping before the team window lets the
        // lookup finish first, and the test then passes even against the bug.)
        // So: play up to the guess window, drop there, come back with a slow
        // lookup, and finish the game immediately.
        await waitForAll([x, y], 'openTeamSubmit', 20000);
        const accepted = Promise.all([waitFor(x, 'teamAccepted', 10000), waitFor(y, 'teamAccepted', 10000)]);
        submit(x, 'submitTeam', { team: 'Chelsea' });
        submit(y, 'submitTeam', { team: 'Liverpool' });
        await accepted;
        await waitForAll([x, y], 'openGuess', 20000);

        const originalId = x.id;
        const down = waitFor(x, 'disconnect', 5000);
        const seen = waitFor(y, 'opponentDisconnectedTemporarily', 8000);
        x.io.engine.close();
        await down;
        await seen;

        await slow.control({ type: 'setLookupMode', mode: 'delay' }, 'modeSet');
        const lookupStarted = slow.nextMessage('lookupPending', 12000);
        const up = waitFor(x, 'connect', 8000);
        x.connect();
        await up;
        await lookupStarted;
        assert.strictEqual(x.id, originalId, 'the player should have recovered');

        // Y wins the first game while the check — and so the save — is waiting.
        const firstOver = Promise.all([waitFor(x, 'gameOver', 20000), waitFor(y, 'gameOver', 20000)]);
        submit(y, 'submitGuess', { guess: 'Mohamed Salah' });
        await firstOver;

        const restarting = Promise.all([
          waitFor(x, 'rematchStarting', 20000), waitFor(y, 'rematchStarting', 20000),
        ]);
        x.emit('requestRematch', {});
        y.emit('requestRematch', {});
        await restarting;

        await playRound(x); // the rematch, won by the first player
        await sleep(2000);

        const { rows } = await db.query(
          `SELECT m.match_uid, w.username AS winner
           FROM matches m
           JOIN players pa ON pa.id = m.player_a
           LEFT JOIN players w ON w.id = m.winner_id
           WHERE pa.username IN ('yaris_bir','yaris_iki')
           ORDER BY m.id`,
        );

        assert.strictEqual(rows.length, 2,
          `two games should have produced two rows, found ${rows.length}`);
        assert.notStrictEqual(rows[0].match_uid, rows[1].match_uid,
          'both games share one match_uid, so one result was silently dropped');
        assert.strictEqual(rows[0].winner, 'yaris_iki', 'the first game was won by the second player');
        assert.strictEqual(rows[1].winner, 'yaris_bir', 'the rematch was won by the first player');

        notes.push('yavaş kimlik kontrolü kayıt beklerken rövanş: gerçek DB\'de 2 satır, 2 farklı match_uid, kazananlar doğru');
        x.close();
        y.close();
      } finally {
        await slow.stop();
      }
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
      // Spelled out exactly. "At least one 200 and not both 200" also accepts a
      // 500, which would mean the second request crashed rather than finding
      // nothing to do — a pass for the wrong reason. The second may be 404 (the
      // account is already gone) or 401 (its session was deleted first).
      assert.strictEqual(statuses[0], 200,
        `neither concurrent delete succeeded (${statuses.join(', ')})`);
      assert.ok([401, 404].includes(statuses[1]),
        `the second concurrent delete answered ${statuses[1]}, expected 404 or 401`);

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

    // --- 8b. the deletion really rolls back ----------------------------------
    // The concurrency test above shows the outcome, not the atomicity: nothing
    // in it forces a failure BETWEEN the two statements. A trigger makes the
    // UPDATE fail, and then neither the sessions nor the account may have
    // changed — a half-done deletion signs a player out without deleting them.
    {
      const victim = await registerAccount(server, 'geri_alma');
      const { rows: vr } = await db.query("SELECT id FROM players WHERE username = 'geri_alma'");
      const victimId = vr[0].id;
      const before = await db.query('SELECT COUNT(*)::int AS n FROM sessions WHERE player_id = $1', [victimId]);
      assert.ok(before.rows[0].n > 0, 'the account should have a session to lose');

      await db.query(`
        CREATE OR REPLACE FUNCTION test_block_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'controlled failure inside the deletion'; END;
        $$ LANGUAGE plpgsql;
      `);
      await db.query(`
        CREATE TRIGGER test_block_delete_trg BEFORE UPDATE ON players
        FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION test_block_delete();
      `);

      let failed = null;
      try {
        const res = await fetch(`${server.url}/api/account/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${victim.token}` },
          body: JSON.stringify({ password: 'sifre123' }),
        });
        failed = res.status;
      } finally {
        await db.query('DROP TRIGGER IF EXISTS test_block_delete_trg ON players');
        await db.query('DROP FUNCTION IF EXISTS test_block_delete()');
      }

      assert.strictEqual(failed, 500, `a failing deletion answered ${failed}, expected 500`);

      const after = await db.query(
        'SELECT username, deleted_at, password_hash FROM players WHERE id = $1', [victimId],
      );
      assert.strictEqual(after.rows[0].username, 'geri_alma', 'the username was changed despite the failure');
      assert.strictEqual(after.rows[0].deleted_at, null, 'the account was marked deleted despite the failure');
      assert.notStrictEqual(after.rows[0].password_hash, '', 'the password hash was cleared despite the failure');

      const sessions = await db.query('SELECT COUNT(*)::int AS n FROM sessions WHERE player_id = $1', [victimId]);
      assert.strictEqual(sessions.rows[0].n, before.rows[0].n,
        'the sessions were deleted even though the deletion failed — the rollback did not happen');

      // And the account still works.
      const me = await fetch(`${server.url}/api/me`, {
        headers: { Authorization: `Bearer ${victim.token}` },
      });
      assert.strictEqual(me.status, 200, `the account was left unusable (${me.status})`);

      notes.push('silme ortasında zorlanmış hata: hesap ve oturumlar değişmedi (rollback), hesap hâlâ çalışıyor');
    }

    // --- 8c. the NOT VALID constraint survives a legacy row ------------------
    // The constraint is added NOT VALID precisely so a deployment whose history
    // contains a same-account row still migrates. That claim needs the situation
    // it describes: an old row that breaks the rule, put in with the constraint
    // dropped, and then the migration run again.
    {
      const legacy = await registerAccount(server, 'eski_satir');
      const { rows: lr } = await db.query("SELECT id FROM players WHERE username = 'eski_satir'");
      const legacyId = lr[0].id;

      await db.query('ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_distinct_players');
      await db.query(
        `INSERT INTO matches (player_a, player_b, score_a, score_b, winner_id, match_uid)
         VALUES ($1, $1, 5, 5, $1, 'tarihsel-bozuk-satir')`,
        [legacyId],
      );

      // Re-running the migration must succeed despite that row.
      const migrated = await accountsDb.migrate();
      assert.strictEqual(migrated, true, 'the migration failed on a schema with a legacy bad row');

      const { rows: has } = await db.query(
        "SELECT convalidated FROM pg_constraint WHERE conname = 'matches_distinct_players'",
      );
      assert.ok(has[0], 'the constraint was not re-created');
      assert.strictEqual(has[0].convalidated, false, 'the constraint should be NOT VALID');

      // The old row is still there — untouched, as intended.
      const { rows: old } = await db.query(
        "SELECT COUNT(*)::int AS n FROM matches WHERE match_uid = 'tarihsel-bozuk-satir'",
      );
      assert.strictEqual(old[0].n, 1, 'the legacy row was removed by the migration');

      // But a NEW row breaking the same rule is refused.
      let refused = null;
      try {
        await db.query(
          `INSERT INTO matches (player_a, player_b, score_a, score_b, winner_id, match_uid)
           VALUES ($1, $1, 1, 1, $1, 'yeni-bozuk-satir')`,
          [legacyId],
        );
      } catch (err) {
        refused = err.constraint;
      }
      assert.strictEqual(refused, 'matches_distinct_players',
        `a new same-account row was not refused (${refused})`);

      await db.query("DELETE FROM matches WHERE match_uid = 'tarihsel-bozuk-satir'");
      notes.push('tarihsel bozuk satır varken migration geçti (kısıt NOT VALID kaldı), eski satır korundu, yeni bozuk satır reddedildi');
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
