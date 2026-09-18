/**
 * What a returning player may do, and what they are shown.
 *
 * Socket.IO connection state recovery keeps the socket id and socket.data
 * across a dropped transport. That is what makes the game survive a tunnel or a
 * locked phone — and it is also what makes two things go wrong, both found by
 * the sixth independent audit:
 *
 *   1. A client that loses its transport does not drop what it was sending: it
 *      queues it and delivers it on reconnect. So a club chosen for a window
 *      that has since closed arrived afterwards and was entered into the NEXT
 *      attempt, spending that attempt's one team choice on something the player
 *      never picked for it. Checking the room's current attempt when the
 *      message arrives cannot catch this — by then it IS the current attempt.
 *      The submission has to name the attempt it was typed for.
 *
 *   2. Recovery also replays the events the client MISSED, with their original
 *      payloads. A player who dropped just after the guess window opened came
 *      back and was handed that window's original length — a full-length timer
 *      on a round with two seconds left. Relative durations cannot survive a
 *      replay; absolute deadlines can.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor, waitForAll, submit } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pair(server) {
  const [a, b] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
  for (const s of [a, b]) s.on('clock', ({ serverNow }) => { s.clockOffset = serverNow - Date.now(); });
  const matched = Promise.all([waitFor(a, 'matched', 8000), waitFor(b, 'matched', 8000)]);
  a.emit('joinQueue', { name: 'Ali' });
  b.emit('joinQueue', { name: 'Veli' });
  await matched;
  return [a, b];
}

/** Drops the transport and waits until the client knows it is gone. */
async function goOffline(socket) {
  const id = socket.id;
  const down = waitFor(socket, 'disconnect', 5000);
  socket.io.engine.close();
  await down;
  return id;
}

/** Reconnects and proves it was a recovery, not a new connection. */
async function comeBack(socket, previousId) {
  const up = waitFor(socket, 'connect', 8000);
  socket.connect();
  await up;
  assert.strictEqual(socket.id, previousId,
    `reconnected as a new socket (${previousId} -> ${socket.id}); this is not recovery`);
  assert.strictEqual(socket.recovered, true,
    'reconnected without Socket.IO connection state recovery');
}

/**
 * Remaining time the way the client works it out.
 *
 * The clock offset comes from the `clock` event this connection received, NOT
 * from the payload's own serverNow: a replayed event's timestamp is as stale as
 * its duration, and using it would hide the very bug this measures.
 */
function remainingByServerClock(socket, payload, closesAtKey = 'closesAt') {
  return payload[closesAtKey] - (Date.now() + socket.clockOffset);
}

module.exports = async function run() {
  const notes = [];

  // --- 1. a club queued while offline cannot spend the next attempt ----------
  {
    const server = await startTestServer({ TEAM_SUBMIT_MS: '1500', NEXT_ROUND_DELAY_MS: '200' });
    try {
      const [a, b] = await pair(server);
      await waitForAll([a, b], 'openTeamSubmit', 15000);

      const rejections = [];
      const accepted = [];
      a.on('teamRejected', (r) => rejections.push(r && r.reason));
      a.on('teamAccepted', (t) => accepted.push(t.display));

      // Typed for THIS window, stamped with it, then the transport dies before
      // it can leave. Socket.IO holds it in sendBuffer.
      const attemptTypedFor = a.currentAttempt;
      const previousId = await goOffline(a);
      submit(a, 'submitTeam', { team: 'Chelsea' });
      assert.strictEqual(a.sendBuffer.length, 1,
        'the submission should be queued on the client while it is offline');

      // The window closes with nobody submitting, and the round is replayed.
      const replayOpen = waitFor(b, 'openTeamSubmit', 15000);
      await waitFor(b, 'roundVoid', 10000);
      await replayOpen;

      await comeBack(a, previousId);
      await sleep(1000);

      assert.deepStrictEqual(accepted, [],
        `a club queued for attempt ${attemptTypedFor} was accepted in a later one (${accepted.join(', ')})`);
      assert.deepStrictEqual(rejections, ['stale_round'],
        `expected one stale_round refusal, got ${JSON.stringify(rejections)}`);
      assert.ok(a.currentAttempt > attemptTypedFor,
        'the replay should be a later attempt than the one the club was typed for');

      // And the player can still play the replay normally.
      await waitForAll([a, b], 'openTeamSubmit', 20000);
      const ok = waitFor(a, 'teamAccepted', 10000);
      submit(a, 'submitTeam', { team: 'Chelsea' });
      assert.strictEqual((await ok).display, 'Chelsea',
        'the returning player should be able to submit to the current attempt');

      notes.push(`çevrimdışı kuyruktaki takım reddedildi (deneme ${attemptTypedFor} -> ${a.currentAttempt}), sonra normal gönderim kabul edildi`);
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  // --- 2. a returning player gets the real remaining time -------------------
  {
    const server = await startTestServer({ PLAYER_GUESS_MS: '6000', NEXT_ROUND_DELAY_MS: '200' });
    try {
      const [a, b] = await pair(server);
      await waitForAll([a, b], 'openTeamSubmit', 15000);

      const accepted = waitFor(a, 'teamAccepted', 10000);
      submit(a, 'submitTeam', { team: 'Chelsea' });
      await accepted;

      // A drops BEFORE the teams are revealed, so it never sees the reveal or
      // the opening — both will be replayed to it on the way back.
      const previousId = await goOffline(a);

      const opened = waitFor(b, 'openGuess', 15000);
      submit(b, 'submitTeam', { team: 'Liverpool' });
      const original = await opened;
      const openedAt = Date.now();

      // Sit out a third of the window, then come back.
      const replayedOpen = waitFor(a, 'openGuess', 10000);
      const synced = waitFor(a, 'phaseSync', 10000);
      await sleep(2200);
      await comeBack(a, previousId);
      const replayed = await replayedOpen;
      const sync = await synced;
      const backAt = Date.now();

      // The replayed event still carries the ORIGINAL duration — that is how
      // recovery works and is not something the server can prevent.
      assert.strictEqual(replayed.timeoutMs, original.timeoutMs,
        'the replayed opening should be the original event, unchanged');

      // What matters is that it also carries an absolute deadline, so the same
      // event yields the real remaining time instead of the original length.
      const trueRemaining = remainingByServerClock(a, replayed);
      const elapsed = backAt - openedAt;
      assert.ok(trueRemaining < replayed.timeoutMs - 1500,
        `the absolute deadline still overstates the time left: ${Math.round(trueRemaining)}ms of ${replayed.timeoutMs}ms after ${elapsed}ms away`);
      assert.ok(Math.abs(trueRemaining - (replayed.timeoutMs - elapsed)) < 700,
        `remaining ${Math.round(trueRemaining)}ms does not match the ${replayed.timeoutMs - elapsed}ms that should be left`);

      // And the explicit sync says where the room actually is.
      assert.strictEqual(sync.state, 'player-submit', `phaseSync reported state "${sync.state}"`);
      assert.strictEqual(sync.attempt, a.currentAttempt, 'phaseSync should carry the current attempt');
      assert.ok(sync.resolved && Object.keys(sync.resolved).length === 2,
        'phaseSync should restore both revealed clubs');
      const syncRemaining = remainingByServerClock(a, sync, 'guessClosesAt');
      assert.ok(Math.abs(syncRemaining - trueRemaining) < 700,
        `phaseSync (${Math.round(syncRemaining)}ms) and the deadline (${Math.round(trueRemaining)}ms) disagree`);

      // The window really does close on the server's schedule.
      const voided = await waitFor(b, 'roundVoid', 10000);
      const closedAt = Date.now();
      assert.strictEqual(voided.reason, 'timeout_guess', `unexpected void reason "${voided.reason}"`);
      assert.ok(Math.abs((closedAt - backAt) - trueRemaining) < 900,
        `the round closed ${closedAt - backAt}ms after the return, but ${Math.round(trueRemaining)}ms was advertised`);

      notes.push(`dönen oyuncuya gerçek kalan süre: replay ${replayed.timeoutMs}ms taşıyor ama mutlak bitiş ${Math.round(trueRemaining)}ms veriyor; `
        + `tur ${closedAt - backAt}ms sonra kapandı; phaseSync state=${sync.state}`);
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  // --- 3. an answer queued while offline cannot score on a later attempt -----
  {
    const server = await startTestServer({ PLAYER_GUESS_MS: '2500', NEXT_ROUND_DELAY_MS: '200' });
    try {
      const [a, b] = await pair(server);
      await waitForAll([a, b], 'openTeamSubmit', 15000);
      const accepted = Promise.all([waitFor(a, 'teamAccepted', 10000), waitFor(b, 'teamAccepted', 10000)]);
      submit(a, 'submitTeam', { team: 'Chelsea' });
      submit(b, 'submitTeam', { team: 'Liverpool' });
      await accepted;
      await waitForAll([a, b], 'openGuess', 15000);

      const results = [];
      const refusals = [];
      a.on('roundResult', (r) => results.push(r.points));
      a.on('guessTooLate', (r) => refusals.push(r && r.reason));

      // The right answer, typed for this window, stranded by a dead transport.
      const attemptTypedFor = a.currentAttempt;
      const previousId = await goOffline(a);
      submit(a, 'submitGuess', { guess: 'Mohamed Salah' });
      assert.strictEqual(a.sendBuffer.length, 1, 'the answer should be queued while offline');

      // The window closes unanswered and the game moves on.
      await waitFor(b, 'roundVoid', 10000);
      await waitFor(b, 'openTeamSubmit', 20000);
      await comeBack(a, previousId);
      await sleep(1200);

      assert.deepStrictEqual(results, [],
        `an answer queued for attempt ${attemptTypedFor} scored later (+${results.join(', +')})`);
      assert.deepStrictEqual(refusals, ['stale_round'],
        `expected one stale_round refusal, got ${JSON.stringify(refusals)}`);

      notes.push(`çevrimdışı kuyruktaki cevap puan yazmadı (deneme ${attemptTypedFor}, "stale_round")`);
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  return notes.join(' · ');
};
