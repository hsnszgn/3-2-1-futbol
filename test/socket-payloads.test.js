/**
 * Hostile socket payloads must not take the server down — proven per handler.
 *
 * An earlier version of this test fired every payload down one connection and
 * counted client-side emit() calls. That was wrong twice over: an oversized
 * payload tripped the 16 KiB limit and closed the socket, so most events never
 * reached the server at all, and the "147 payloads" figure measured the client,
 * not the server. Counting emits proves nothing.
 *
 * This version proves delivery instead. Each event gets its own connection, and
 * after the hostile barrage a known-good message must still get its normal
 * reply on that same connection — which is only possible if the socket is open
 * and the server processed what came before it.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Small, malformed payloads. Nothing here is near the size limit, so every one
// of them must reach a handler.
const HOSTILE = [
  undefined,
  null,
  0,
  -1,
  '',
  'merhaba',
  true,
  false,
  [],
  [1, 2, 3],
  {},
  { name: null },
  { name: 123 },
  { name: {} },
  { name: [] },
  { name: true },
  { team: null },
  { team: 42 },
  { team: { toString: 'not a function' } },
  { guess: null },
  { guess: [] },
  { code: null },
  { code: {} },
  { code: 999 },
  { __proto__: { polluted: true } },
  { name: 'a', code: { nested: { deep: true } } },
];

/**
 * Events split into two honest groups.
 *
 * `replies` events answer every message, so the number of replies received is a
 * direct, server-side measure of how many hostile payloads were processed.
 *
 * `silent` events are no-ops outside a game and answer nothing, so delivery
 * cannot be observed from the client. For those the claim is narrower: the
 * connection survives and still round-trips. They ARE proven delivered in the
 * in-game section below, where they do reply.
 */
const REPLYING_EVENTS = [
  { event: 'joinQueue', reply: 'waiting' },
  { event: 'createPrivateRoom', reply: 'privateRoomCreated' },
  // Every hostile payload normalises to an empty invite code, which the handler
  // answers with "no such room". Nothing is merged into these payloads: an
  // earlier version spread a valid-looking { code } over each one, which turned
  // raw null and 42 into well-formed objects before they ever left the client —
  // so the handler was never actually shown the malformed input.
  { event: 'joinPrivateRoom', reply: 'errorMessage' },
];

const SILENT_EVENTS = ['submitTeam', 'submitGuess', 'requestRematch', 'leaveRoom'];

module.exports = async function run() {
  const server = await startTestServer();
  const notes = [];

  try {
    // --- 1a. events that reply: delivery is counted, not assumed ------------
    let measured = 0;
    for (const { event, reply } of REPLYING_EVENTS) {
      const socket = await connectClient(server.url);
      let dropped = false;
      socket.on('disconnect', () => { dropped = true; });

      // Count the server's answers. Each hostile payload normalises to an
      // object the handler still acts on, so one reply per payload is the
      // server telling us it processed that message.
      let replies = 0;
      socket.on(reply, () => { replies += 1; });

      // Sent exactly as they are — no client-side normalisation.
      for (const payload of HOSTILE) socket.emit(event, payload);
      await sleep(600);

      assert.ok(!dropped, `connection was closed by hostile "${event}" payloads`);
      assert.strictEqual(replies, HOSTILE.length,
        `"${event}": server answered ${replies} of ${HOSTILE.length} hostile payloads`);
      measured += replies;
      socket.close();
    }

    // A well-formed invite code that does not exist is a separate case: the
    // sweep above only proves the empty-code path.
    {
      const socket = await connectClient(server.url);
      const refused = waitFor(socket, 'errorMessage', 6000);
      socket.emit('joinPrivateRoom', { name: 'Prob', code: 'YOKBOYLE' });
      const message = (await refused).message;
      assert.ok(/bulunamadı|süresi/i.test(message),
        `an unknown invite code should be refused by name, got "${message}"`);
      socket.close();
    }

    // --- 1b. events that answer nothing outside a game ---------------------
    // Delivery is not observable here, so the claim stops at: the connection
    // survives and still works afterwards.
    for (const event of SILENT_EVENTS) {
      const socket = await connectClient(server.url);
      let dropped = false;
      socket.on('disconnect', () => { dropped = true; });

      for (const payload of HOSTILE) socket.emit(event, payload);
      await sleep(200);

      assert.ok(!dropped, `connection was closed by hostile "${event}" payloads`);
      const reply = waitFor(socket, 'waiting', 6000);
      socket.emit('joinQueue', { name: 'Prob' });
      await reply;
      socket.close();
    }

    assert.ok(server.isAlive(), 'server died during the hostile payload sweep');
    notes.push(`${measured} mesaj sunucu yanıtıyla ölçülerek teslim edildi (${REPLYING_EVENTS.length} olay); yanıt vermeyen ${SILENT_EVENTS.length} olayda bağlantı ayakta kaldı ve sonrasında çalıştı`);

    // --- 2. an oversized payload closes that ONE socket, nothing else -------
    {
      // A game already in progress, so the blast radius is measured against a
      // live match rather than against a client that connects afterwards.
      const [x, y] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
      const bothMatched = Promise.all([waitFor(x, 'matched', 8000), waitFor(y, 'matched', 8000)]);
      x.emit('joinQueue', { name: 'Devam' });
      y.emit('joinQueue', { name: 'Eden' });
      await bothMatched;
      await waitFor(x, 'openTeamSubmit', 12000);

      const victim = await connectClient(server.url);
      let victimDropped = false;
      victim.on('disconnect', () => { victimDropped = true; });
      // Comfortably over the 16 KiB frame limit.
      victim.emit('joinQueue', { name: 'x'.repeat(100000) });

      const deadline = Date.now() + 5000;
      while (!victimDropped && Date.now() < deadline) await sleep(100);
      assert.ok(victimDropped,
        'an oversized payload must close that connection; it stayed open');
      assert.ok(server.isAlive(), 'an oversized payload killed the server');
      victim.close();

      // The match that was already running is untouched and still playable.
      assert.ok(x.connected && y.connected, 'the in-progress match lost a connection');
      const acceptedX = waitFor(x, 'teamAccepted', 8000);
      const acceptedY = waitFor(y, 'teamAccepted', 8000);
      x.emit('submitTeam', { team: 'Chelsea' });
      y.emit('submitTeam', { team: 'Liverpool' });
      await Promise.all([acceptedX, acceptedY]);

      notes.push('100 KB payload: sadece o bağlantı kapandı, devam eden maç etkilenmedi');
      x.close();
      y.close();
    }

    // --- 3. hostile payloads inside a live game -----------------------------
    {
      const [a, b] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
      const matchedA = waitFor(a, 'matched', 8000);
      const matchedB = waitFor(b, 'matched', 8000);
      a.emit('joinQueue', { name: 'Ali' });
      b.emit('joinQueue', { name: 'Veli' });
      await Promise.all([matchedA, matchedB]);

      // Wait for the team phase to actually open.
      await waitFor(a, 'openTeamSubmit', 10000);

      // Every rejection is itself proof the payload reached the handler.
      const rejections = [];
      a.on('teamRejected', (r) => rejections.push(r && r.reason));

      for (const payload of HOSTILE) a.emit('submitTeam', payload);
      await sleep(400);

      assert.ok(a.connected && b.connected, 'hostile submitTeam closed a player connection');
      assert.ok(server.isAlive(), 'hostile submitTeam killed the server');
      assert.ok(rejections.length >= HOSTILE.length,
        `expected a rejection per hostile submitTeam, got ${rejections.length}/${HOSTILE.length}`);
      assert.ok(rejections.includes('unknown_team'), 'malformed teams should be rejected as unknown');
      assert.ok(rejections.includes('too_many_attempts'),
        'the per-round attempt budget should kick in when a client spams');

      // That round is now spent for A, so it times out and replays. The next
      // round must be completely normal.
      await waitFor(a, 'roundVoid', 20000);
      await waitFor(a, 'openTeamSubmit', 20000);

      const acceptedA = waitFor(a, 'teamAccepted', 8000);
      const acceptedB = waitFor(b, 'teamAccepted', 8000);
      a.emit('submitTeam', { team: 'Chelsea' });
      b.emit('submitTeam', { team: 'Liverpool' });
      await Promise.all([acceptedA, acceptedB]);

      // Guesses only count once the server opens the guess window.
      await waitFor(a, 'teamsRevealed', 12000);
      await waitFor(a, 'openGuess', 12000);

      const guessRejections = [];
      a.on('guessRejected', (r) => guessRejections.push(r && r.reason));
      for (const payload of HOSTILE) a.emit('submitGuess', payload);
      // A well-formed but wrong guess proves the handler is reachable: the
      // malformed ones are dropped before they reach the matcher.
      a.emit('submitGuess', { guess: 'Yok Böyle Bir Oyuncu' });
      await sleep(500);

      assert.ok(a.connected, 'hostile submitGuess closed the player connection');
      assert.ok(server.isAlive(), 'hostile submitGuess killed the server');
      assert.ok(guessRejections.includes('player_not_found'),
        `submitGuess handler unreachable after hostile payloads (got ${JSON.stringify(guessRejections)})`);

      // A real guess still resolves the round.
      const result = waitFor(a, 'roundResult', 15000);
      a.emit('submitGuess', { guess: 'Mohamed Salah' });
      const round = await result;
      assert.ok(round && round.playerName, 'the round should still resolve after hostile guesses');

      notes.push(`oyun içi: ${rejections.length} takım reddi + ${guessRejections.length} tahmin reddi (teslim kanıtı), sonraki tur normal tamamlandı ("${round.playerName}")`);
      a.close();
      b.close();
    }

    // --- 4. hostile rematch requests in the game-over state ------------------
    // requestRematch only does anything once the game is actually over, so
    // firing it mid-game (as this test used to) proved nothing. A one-round
    // server gets us to game-over cheaply, and there the handler answers every
    // request with rematchWaiting — so delivery is measured, not assumed.
    {
      const shortGame = await startTestServer({ MAX_ROUNDS: '1' });
      try {
        const [a, b] = await Promise.all([
          connectClient(shortGame.url), connectClient(shortGame.url),
        ]);

        const over = Promise.all([waitFor(a, 'gameOver', 25000), waitFor(b, 'gameOver', 25000)]);
        const matched = Promise.all([waitFor(a, 'matched', 8000), waitFor(b, 'matched', 8000)]);
        a.emit('joinQueue', { name: 'Ali' });
        b.emit('joinQueue', { name: 'Veli' });
        await matched;

        await waitFor(a, 'openTeamSubmit', 12000);
        const accepted = Promise.all([waitFor(a, 'teamAccepted', 8000), waitFor(b, 'teamAccepted', 8000)]);
        a.emit('submitTeam', { team: 'Chelsea' });
        b.emit('submitTeam', { team: 'Liverpool' });
        await accepted;

        // Answers are only accepted once the server opens the window, so wait
        // for that rather than firing at the reveal.
        await waitFor(a, 'openGuess', 15000);
        a.emit('submitGuess', { guess: 'Mohamed Salah' });
        await over;

        let waitingReplies = 0;
        a.on('rematchWaiting', () => { waitingReplies += 1; });
        for (const payload of HOSTILE) a.emit('requestRematch', payload);
        await sleep(600);

        assert.ok(shortGame.isAlive(), 'hostile requestRematch killed the server');
        assert.ok(a.connected && b.connected, 'hostile requestRematch dropped a connection');
        assert.strictEqual(waitingReplies, HOSTILE.length,
          `game-over requestRematch: ${waitingReplies} of ${HOSTILE.length} hostile payloads answered`);

        // And a real rematch still starts, so the barrage did not corrupt the
        // room's pending-request state.
        const starting = waitFor(a, 'rematchStarting', 8000);
        b.emit('requestRematch', {});
        await starting;

        notes.push(`oyun sonu: ${waitingReplies} bozuk rövanş isteği yanıtlandı, ardından gerçek rövanş başladı`);
        a.close();
        b.close();
      } finally {
        await shortGame.stop();
      }
    }

    const health = await fetch(`${server.url}/healthz`);
    assert.strictEqual(health.status, 200, 'health endpoint should still answer');

    return notes.join(' · ');
  } finally {
    await server.stop();
  }
};
