/**
 * When a session ends, everything holding that identity has to let go of it.
 *
 * The eighth independent audit found three ways it did not. All three are about
 * the same thing from different sides: the server treated "who this connection
 * is" as a fact it had already established, rather than something that can be
 * taken away underneath it.
 *
 *   1. The identity re-check on a recovered connection was started and
 *      forgotten. The socket carried on working meanwhile, reading the account
 *      it had before it dropped — so a signed-out player could queue, host and
 *      be matched under their old name in the window before the answer came
 *      back. That window is a database round trip, so it is real.
 *
 *   2. If that lookup FAILED, the old identity was simply kept. A broken query
 *      is exactly when an identity should not be trusted.
 *
 *   3. Revocation walked the list of connected sockets. A player whose transport
 *      has dropped is not in it — but their seat is still in a live room, and
 *      the match can finish inside the twelve-second recovery grace. The result
 *      was then recorded against the account they had just signed out of.
 *
 * The account service is a controlled double here (test/fixtures/auth-server-entry.js):
 * a lookup cannot be made slow or made to fail on demand against a real
 * database, and the point of these tests is what the server does WHILE it is
 * waiting or after it has failed. Everything else is the production path.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor, waitForAll, submit } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startAuthServer(env = {}) {
  return startTestServer({ AUTH_FIXTURE: '1', MAX_ROUNDS: '1', NEXT_ROUND_DELAY_MS: '200', ...env });
}

async function pair(server, tokenA = 'token-ada', tokenB = 'token-bora') {
  const [a, b] = await Promise.all([
    connectClient(server.url, { token: tokenA }),
    connectClient(server.url, { token: tokenB }),
  ]);
  const matched = Promise.all([waitFor(a, 'matched', 8000), waitFor(b, 'matched', 8000)]);
  a.emit('joinQueue', { name: 'Misafir A' });
  b.emit('joinQueue', { name: 'Misafir B' });
  const [mine] = await matched;
  await waitForAll([a, b], 'openTeamSubmit', 12000);
  return { a, b, myName: mine.myName };
}

/** Drops the transport and waits until the SERVER has seen it, not just us. */
async function goOffline(socket, opponent) {
  const id = socket.id;
  const down = waitFor(socket, 'disconnect', 5000);
  const seen = waitFor(opponent, 'opponentDisconnectedTemporarily', 8000);
  socket.io.engine.close();
  await down;
  await seen;
  return id;
}

async function logout(server, token) {
  const res = await fetch(`${server.url}/api/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 200, `logout returned ${res.status}`);
  const me = await fetch(`${server.url}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(me.status, 401, `the token still works after logout (${me.status})`);
}

module.exports = async function run() {
  const notes = [];

  // --- 1. nothing runs under an identity that has not been re-confirmed -----
  for (const mode of ['delay', 'error']) {
    const server = await startAuthServer({ AUTH_LOOKUP_DELAY_MS: '2500' });
    try {
      const { a, b, myName } = await pair(server);
      assert.strictEqual(myName, 'Ada', 'the player should start out signed in');
      const originalId = await goOffline(a, b);
      await logout(server, 'token-ada');

      await server.control({ type: 'setLookupMode', mode }, 'modeSet');

      const ended = [];
      a.on('sessionEnded', () => ended.push(Date.now()));
      const lookupStarted = server.nextMessage('lookupPending', 10000);
      const up = waitFor(a, 'connect', 8000);
      a.connect();
      await up;
      await lookupStarted;
      assert.strictEqual(a.id, originalId, 'this should be a recovered connection');
      assert.strictEqual(a.recovered, true, 'connection state recovery did not happen');

      // The lookup is still in flight. Everything asked for now must WAIT for
      // it — and once it resolves, the identity is gone either way.
      const spare = await connectClient(server.url);
      spare.emit('joinQueue', { name: 'Misafir C' });
      await waitFor(spare, 'waiting', 8000);

      const left = waitFor(b, 'opponentLeft', 8000);
      a.emit('leaveRoom');
      await left;

      const matched = waitFor(a, 'matched', 12000);
      a.emit('joinQueue', { name: 'Misafir Olmali' });
      const result = await matched;

      assert.strictEqual(result.myName, 'Misafir Olmali',
        `matched as "${result.myName}" — the revoked account name was still in use`);
      assert.ok(ended.length >= 1, 'the connection was never told its session had ended');

      notes.push(`${mode}: doğrulama beklenirken hesap yetkisi kullanılamadı, "${result.myName}" olarak eşleşti`);
      a.close();
      b.close();
      spare.close();
    } finally {
      await server.stop();
    }
  }

  // --- 2. signing out while offline clears the seat -------------------------
  // The match finishes without the player ever coming back, so the recovery
  // re-check never runs. Nothing may be recorded for them.
  {
    const server = await startAuthServer();
    try {
      const { a, b } = await pair(server);
      const saves = server.collect('recordMatchCalled');

      const accepted = Promise.all([waitFor(a, 'teamAccepted', 8000), waitFor(b, 'teamAccepted', 8000)]);
      submit(a, 'submitTeam', { team: 'Chelsea' });
      submit(b, 'submitTeam', { team: 'Liverpool' });
      await accepted;
      await waitForAll([a, b], 'openGuess', 12000);

      await goOffline(a, b);
      await logout(server, 'token-ada');

      // The opponent finishes the game alone.
      const over = waitFor(b, 'gameOver', 20000);
      submit(b, 'submitGuess', { guess: 'Mohamed Salah' });
      await over;
      await sleep(800);

      assert.deepStrictEqual(saves, [],
        `the result was recorded after the player signed out: ${JSON.stringify(saves.map((m) => m.data))}`);

      notes.push('çevrimdışıyken çıkış: koltuk temizlendi, maç hiç kaydedilmedi');
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  // --- 3. a token-scoped sign-out leaves the account's other session alone --
  // Revocation has to reach seats as well as sockets, and that is exactly where
  // it could go too far: clearing by account would sign out a second device
  // that is still perfectly valid.
  {
    const server = await startAuthServer();
    try {
      const { a, b } = await pair(server);
      const saves = server.collect('recordMatchCalled');

      // The same account, signed in again somewhere else.
      const otherDevice = await connectClient(server.url, { token: 'token-ada-2' });
      const otherEnded = [];
      otherDevice.on('sessionEnded', () => otherEnded.push(1));

      const ended = waitFor(a, 'sessionEnded', 8000);
      await logout(server, 'token-ada');
      await ended;
      await sleep(500);

      assert.deepStrictEqual(otherEnded, [],
        'the account\'s other session was revoked too');
      const stillMe = await fetch(`${server.url}/api/me`, {
        headers: { Authorization: 'Bearer token-ada-2' },
      });
      assert.notStrictEqual(stillMe.status, 401, 'the other session\'s token was invalidated');

      // And the revoked one really is revoked: finishing this game records nothing.
      const acceptedT = Promise.all([waitFor(a, 'teamAccepted', 8000), waitFor(b, 'teamAccepted', 8000)]);
      submit(a, 'submitTeam', { team: 'Chelsea' });
      submit(b, 'submitTeam', { team: 'Liverpool' });
      await acceptedT;
      await waitForAll([a, b], 'openGuess', 12000);
      const over = waitFor(b, 'gameOver', 20000);
      submit(b, 'submitGuess', { guess: 'Mohamed Salah' });
      await over;
      await sleep(800);
      assert.deepStrictEqual(saves, [], 'the revoked session\'s game was recorded');

      notes.push('jetona özel çıkış aynı hesabın diğer oturumunu düşürmüyor; iptal edilen oturumun maçı kaydedilmiyor');
      a.close();
      b.close();
      otherDevice.close();
    } finally {
      await server.stop();
    }
  }

  return notes.join(' · ');
};
