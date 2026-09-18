/**
 * The round/time model: who may answer, when, and what it is worth.
 *
 * Four separate problems live in this one area, and all of them are about the
 * gap between "the server decided something" and "the answer arrived":
 *
 *   1. The elapsed time was read AFTER awaiting the Wikidata lookup, so the
 *      score depended on how slow Wikidata happened to be. The same answer,
 *      typed at the same moment, was worth +3 on a fast day and +1 on a slow
 *      one — the player was charged for someone else's latency.
 *
 *   2. Answers sent before the reveal finished were accepted and scored as
 *      elapsed 0, i.e. a guaranteed top-tier +3 for answering before the
 *      question was officially open.
 *
 *   3. A voided round is replayed under the same round NUMBER, so the number
 *      cannot identify an attempt. An answer still in flight from the
 *      abandoned attempt could land on the replay and score there.
 *
 *   4. The client ran its own full-length timer starting after the reveal,
 *      while the server's had been running through the reveal — so the bar
 *      still showed time left after the round had already closed.
 *
 * The fix is one idea applied everywhere: every attempt at a round has its own
 * id, the window is decided and published by the server, and the arrival time
 * is read before any await.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queues two clients and returns them once the game screen would be up. */
async function pair(server) {
  const [a, b] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
  const matched = Promise.all([waitFor(a, 'matched', 8000), waitFor(b, 'matched', 8000)]);
  a.emit('joinQueue', { name: 'Ali' });
  b.emit('joinQueue', { name: 'Veli' });
  await matched;
  return [a, b];
}

/** Submits the two clubs and returns the reveal payload plus the open payload. */
async function reachGuessPhase(a, b, teams = ['Chelsea', 'Liverpool']) {
  await waitFor(a, 'openTeamSubmit', 15000);
  const revealed = waitFor(a, 'teamsRevealed', 15000);
  const opened = waitFor(a, 'openGuess', 15000);
  const accepted = Promise.all([waitFor(a, 'teamAccepted', 8000), waitFor(b, 'teamAccepted', 8000)]);
  a.emit('submitTeam', { team: teams[0] });
  b.emit('submitTeam', { team: teams[1] });
  await accepted;
  return { reveal: await revealed, open: await opened };
}

module.exports = async function run() {
  const notes = [];

  // --- 1. the window is the server's, and it is published --------------------
  {
    const server = await startTestServer();
    try {
      const [a, b] = await pair(server);
      const revealedAt = Date.now();
      const { reveal, open } = await reachGuessPhase(a, b);
      const openedAt = Date.now();

      assert.strictEqual(typeof reveal.opensInMs, 'number',
        'the reveal must say when the guess window opens');
      assert.strictEqual(typeof open.timeoutMs, 'number',
        'the opening must say how long the window lasts');

      // The client no longer needs to know the reveal hold: it is told.
      const heldFor = openedAt - revealedAt;
      assert.ok(heldFor >= reveal.opensInMs - 200,
        `the window opened ${heldFor}ms after the teams were submitted, before the announced ${reveal.opensInMs}ms hold`);
      // And the remaining time is the real remaining time, not the full window
      // restarted after the reveal — that difference is what let the old client
      // show time left on a round the server had already closed.
      assert.ok(open.timeoutMs <= reveal.timeoutMs,
        `the opening advertised more time (${open.timeoutMs}ms) than the window has (${reveal.timeoutMs}ms)`);

      notes.push(`pencere sunucudan: ${reveal.opensInMs}ms bekleme, ${open.timeoutMs}ms kalan süre yayınlandı`);
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  // --- 2. answering before the window opens is refused, not rewarded ---------
  {
    const server = await startTestServer();
    try {
      const [a, b] = await pair(server);
      await waitFor(a, 'openTeamSubmit', 15000);
      const revealed = waitFor(a, 'teamsRevealed', 15000);
      a.emit('submitTeam', { team: 'Chelsea' });
      b.emit('submitTeam', { team: 'Liverpool' });
      await revealed;

      // Straight in, during the reveal. The right answer, too early.
      const early = waitFor(a, 'guessTooEarly', 8000);
      a.emit('submitGuess', { guess: 'Mohamed Salah' });
      const payload = await early;
      assert.ok(payload.opensInMs > 0,
        'a too-early answer should say how long is left before the window opens');

      // It must not have scored, and the round must still be winnable.
      await waitFor(a, 'openGuess', 15000);
      const result = waitFor(a, 'roundResult', 15000);
      a.emit('submitGuess', { guess: 'Mohamed Salah' });
      const round = await result;
      assert.strictEqual(round.winnerSocketId, a.id, 'the round should be won normally afterwards');

      notes.push(`erken cevap reddedildi (${payload.opensInMs}ms kaldı), tur sonra normal kazanıldı`);
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  // --- 3. the score does not depend on how slow the lookup is ----------------
  // The same answer is given at the same moment against a fast and a very slow
  // lookup. Both must be worth the same. Before the fix the slow one dropped a
  // tier or two, because the clock was read after the await.
  {
    const measured = [];
    for (const delay of [20, 4000]) {
      const server = await startTestServer({ TEST_LOOKUP_DELAY_MS: String(delay) });
      try {
        const [a, b] = await pair(server);
        await reachGuessPhase(a, b);

        const result = waitFor(a, 'roundResult', 25000);
        a.emit('submitGuess', { guess: 'Mohamed Salah' });
        const round = await result;
        measured.push({ delay, points: round.points, elapsedMs: round.elapsedMs });
        a.close();
        b.close();
      } finally {
        await server.stop();
      }
    }

    const [fast, slow] = measured;
    assert.strictEqual(fast.points, 3,
      `an immediate answer should score +3, got +${fast.points}`);
    assert.strictEqual(slow.points, fast.points,
      `a ${slow.delay}ms lookup changed the score: +${fast.points} -> +${slow.points}`);
    // The reported elapsed time must be the player's, not the service's.
    assert.ok(slow.elapsedMs < 2000,
      `the slow lookup leaked into the elapsed time (${slow.elapsedMs}ms)`);

    notes.push(`gecikmeden bağımsız puan: ${fast.delay}ms -> +${fast.points} (${fast.elapsedMs}ms), `
      + `${slow.delay}ms -> +${slow.points} (${slow.elapsedMs}ms)`);
  }

  // --- 4. the speed tiers, at their real boundaries --------------------------
  // +3 within 5s, +2 within 12s, +1 after. Only the +3 tier was ever verified
  // before; these two wait out the clock.
  {
    const server = await startTestServer();
    try {
      for (const { waitMs, expected } of [{ waitMs: 7000, expected: 2 }, { waitMs: 14000, expected: 1 }]) {
        const [a, b] = await pair(server);
        await reachGuessPhase(a, b);

        await sleep(waitMs);
        const result = waitFor(a, 'roundResult', 25000);
        a.emit('submitGuess', { guess: 'Mohamed Salah' });
        const round = await result;

        assert.strictEqual(round.points, expected,
          `an answer after ${waitMs}ms should score +${expected}, got +${round.points} (elapsed ${round.elapsedMs}ms)`);
        assert.ok(Math.abs(round.elapsedMs - waitMs) < 1500,
          `elapsed ${round.elapsedMs}ms does not match the ${waitMs}ms wait`);

        notes.push(`${waitMs}ms -> +${round.points} (ölçülen ${round.elapsedMs}ms)`);
        a.close();
        b.close();
      }
    } finally {
      await server.stop();
    }
  }

  // --- 5. an answer whose lookup outlives its round cannot score later -------
  // The real hole is the guess-window timeout. Unlike the no-common-players
  // void, it never sets playerGuessResolved — so an answer sent inside the
  // window, whose lookup is still in flight when the window closes, used to
  // wake up during a LATER round and score there. The round number is no help:
  // it had already moved on, and the checks were on state, not on identity.
  //
  // The windows are shortened so the race is reachable in seconds, and the
  // numbers are chosen to land the stale lookup inside the NEXT round's guess
  // phase. A lookup is three sequential request waves, so ~3x the per-request
  // delay: 3000 here means ~9s, while round 1 closes at ~4.6s and round 2
  // reaches its guess phase at ~8.5s.
  {
    const server = await startTestServer({
      PLAYER_GUESS_MS: '3000',
      NEXT_ROUND_DELAY_MS: '500',
      TEST_LOOKUP_DELAY_MS: '3000',
    });
    try {
      const [a, b] = await pair(server);
      await waitFor(a, 'openTeamSubmit', 15000);

      const voided = waitFor(a, 'roundVoid', 20000);
      a.emit('submitTeam', { team: 'Chelsea' });
      b.emit('submitTeam', { team: 'Liverpool' });
      await waitFor(a, 'teamsRevealed', 15000);
      await waitFor(a, 'openGuess', 15000);

      // A correct answer, inside the window — but the lookup will not come back
      // before the window closes.
      a.emit('submitGuess', { guess: 'Mohamed Salah' });

      const reason = (await voided).reason;
      assert.strictEqual(reason, 'timeout_guess',
        `the window should have timed out, got "${reason}"`);

      const results = [];
      a.on('roundResult', (r) => results.push({ round: r.round, points: r.points }));

      // The next round: new attempt, new lookup, and the stale answer's lookup
      // resolves right about here.
      const next = await waitFor(a, 'roundStart', 20000);
      await waitFor(a, 'openTeamSubmit', 15000);
      const accepted = Promise.all([waitFor(a, 'teamAccepted', 8000), waitFor(b, 'teamAccepted', 8000)]);
      a.emit('submitTeam', { team: 'Chelsea' });
      b.emit('submitTeam', { team: 'Liverpool' });
      await accepted;
      await waitFor(a, 'teamsRevealed', 15000);

      // Sit through the moment the old lookup resolves (~9s after round 1's
      // teams), which falls inside this round's guess phase.
      await sleep(4000);

      assert.deepStrictEqual(results, [],
        `an answer from round 1 scored during round ${next.round}`);

      notes.push(`süresi geçen turun cevabı sonraki tura yazılmadı (tur ${next.round}, eski arama uçuştayken)`);
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  // --- 6. a club resolved for an abandoned attempt cannot enter the replay ---
  // submitTeam has the same shape of race as submitGuess: resolving the club
  // name goes to the network, and the team-submit window can time out while
  // that is in flight. The round is then replayed under the same number, and
  // the late-resolving club used to be entered into the replay — giving a
  // player a team they never chose for that round, and starting the round
  // without them having typed anything.
  {
    const server = await startTestServer({
      TEAM_SUBMIT_MS: '2000',
      NEXT_ROUND_DELAY_MS: '500',
      TEST_LOOKUP_DELAY_MS: '2500',
    });
    try {
      const [a, b] = await pair(server);
      await waitFor(a, 'openTeamSubmit', 15000);

      const accepted = [];
      a.on('teamAccepted', (t) => accepted.push(t.display));

      const voided = waitFor(a, 'roundVoid', 15000);
      // Only A submits. The club is deliberately one that is NOT in the
      // built-in team list, so resolving it goes to the network and takes
      // longer than the window — the built-in clubs resolve locally in under a
      // millisecond and cannot reach this path at all.
      a.emit('submitTeam', { team: 'Deneme Kulubu' });
      const reason = (await voided).reason;
      assert.strictEqual(reason, 'timeout_team',
        `the team window should have timed out, got "${reason}"`);

      // Sit past the moment the club finishes resolving (~2.5s after it was
      // sent, i.e. shortly after the void). That is the moment it used to be
      // accepted into the attempt that had already ended.
      const statuses = [];
      a.on('opponentTeamStatus', (st) => statuses.push(st.submittedBy.length));
      await sleep(2000);

      assert.deepStrictEqual(accepted, [],
        `a club from the abandoned attempt was accepted (${accepted.join(', ')})`);
      assert.deepStrictEqual(statuses, [],
        'the replay started with a team already submitted');

      // The replay opens its own team window, and a freshly typed club is
      // accepted there normally — retiring the old attempt must not break the
      // new one. Chelsea is in the built-in list, so it resolves instantly and
      // comfortably inside the shortened window.
      await waitFor(a, 'openTeamSubmit', 20000);
      const ok = waitFor(a, 'teamAccepted', 10000);
      a.emit('submitTeam', { team: 'Chelsea' });
      assert.strictEqual((await ok).display, 'Chelsea', 'the replay should accept a new club');

      notes.push('süresi geçen turun takımı tekrara girmiyor, tekrar normal takım kabul ediyor');
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  return notes.join(' · ');
};
