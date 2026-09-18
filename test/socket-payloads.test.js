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
 * Each event is paired with a message that must still work afterwards, and the
 * reply that proves the server handled it.
 */
const EVENTS = [
  { event: 'joinQueue', probe: { name: 'Prob' }, expect: 'waiting' },
  { event: 'createPrivateRoom', probe: { name: 'Prob' }, expect: 'privateRoomCreated' },
  { event: 'joinPrivateRoom', probe: { name: 'Prob', code: 'YOKBOYLE' }, expect: 'errorMessage' },
  // These three are no-ops outside a game; the in-game test below drives them
  // in the state where they actually do something.
  { event: 'submitTeam', probe: { name: 'Prob' }, expect: null },
  { event: 'submitGuess', probe: { name: 'Prob' }, expect: null },
  { event: 'requestRematch', probe: {}, expect: null },
  { event: 'leaveRoom', probe: {}, expect: null },
];

module.exports = async function run() {
  const server = await startTestServer();
  const notes = [];

  try {
    // --- 1. small hostile payloads reach their handler and are survived -----
    let delivered = 0;
    for (const { event, probe, expect } of EVENTS) {
      const socket = await connectClient(server.url);
      let dropped = false;
      socket.on('disconnect', () => { dropped = true; });

      for (const payload of HOSTILE) socket.emit(event, payload);
      await sleep(200);

      assert.ok(!dropped, `connection was closed by hostile "${event}" payloads`);
      assert.ok(socket.connected, `socket died sending hostile "${event}" payloads`);
      delivered += HOSTILE.length;

      // The proof that the channel is still live and the server still listening.
      if (expect) {
        const reply = waitFor(socket, expect, 6000);
        socket.emit(event, probe);
        await reply;
      } else {
        // No reply to assert on, so verify the connection still round-trips.
        const reply = waitFor(socket, 'waiting', 6000);
        socket.emit(event, probe);
        socket.emit('joinQueue', { name: 'Prob' });
        await reply;
      }

      socket.close();
    }
    assert.ok(server.isAlive(), 'server died during the hostile payload sweep');
    notes.push(`${EVENTS.length} olay × ${HOSTILE.length} bozuk payload = ${delivered} mesaj teslim edildi, her olayda sonrasında normal yanıt alındı`);

    // --- 2. an oversized payload closes that ONE socket, nothing else -------
    {
      const victim = await connectClient(server.url);
      const closed = new Promise((resolve) => victim.on('disconnect', resolve));
      // Comfortably over the 16 KiB frame limit.
      victim.emit('joinQueue', { name: 'x'.repeat(100000) });
      await Promise.race([closed, sleep(3000)]);

      assert.ok(server.isAlive(), 'an oversized payload killed the server');
      notes.push(`100 KB payload: bağlantı kapandı (${victim.connected ? 'hâlâ açık' : 'kapandı'}), sunucu ayakta`);
      victim.close();

      // Another player is completely unaffected.
      const bystander = await connectClient(server.url);
      const waiting = waitFor(bystander, 'waiting', 6000);
      bystander.emit('joinQueue', { name: 'Seyirci' });
      await waiting;
      bystander.close();
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

      // Guesses only count once the teams have been revealed.
      await waitFor(a, 'teamsRevealed', 12000);
      await sleep(2000);

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

      for (const payload of HOSTILE) a.emit('requestRematch', payload);
      await sleep(200);
      assert.ok(server.isAlive(), 'hostile requestRematch killed the server');

      notes.push(`oyun içi: ${rejections.length} takım reddi + ${guessRejections.length} tahmin reddi (teslim kanıtı), sonraki tur normal tamamlandı ("${round.playerName}")`);
      a.close();
      b.close();
    }

    const health = await fetch(`${server.url}/healthz`);
    assert.strictEqual(health.status, 200, 'health endpoint should still answer');

    return notes.join(' · ');
  } finally {
    await server.stop();
  }
};
