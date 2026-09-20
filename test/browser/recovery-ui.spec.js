/**
 * What a dropped connection looks like to the player.
 *
 * The recovery path was verified at socket level only: events arrive, the
 * attempt gate holds. None of that says what the SCREEN does, and the screen is
 * where the failures a player notices live — a phase that does not come back, a
 * countdown that restarts and hands one side extra seconds, an answer typed
 * while offline landing in the next round, or a game that is over on the server
 * while the client still shows its timer.
 *
 * Driven here in real Chromium, with the network actually taken away
 * (context.setOffline) rather than the client asked politely to disconnect, and
 * with every wait tied to an observable event rather than a sleep — the first
 * version used fixed sleeps, raced the room teardown, and passed or failed
 * depending on which won.
 *
 * These three scenarios are all about coming back to a room that is still
 * there. What happens when it is NOT — the room torn down while the player was
 * away, and the recovery window exceeded — is in recovery-roomgone.spec.js and
 * recovery-expired.spec.js, because each needs the server configured
 * differently and mixing them into one server is what made this test race.
 */
const assert = require('assert');
const { twoPlayers, startGame, sleep } = require('./helpers');

// Short windows so a round can be outlived inside a test, and two rounds so
// there is a NEXT round for a stale answer to leak into.
module.exports.env = {
  MAX_ROUNDS: '2',
  TEAM_SUBMIT_MS: '9000',
  PLAYER_GUESS_MS: '6000',
  // These scenarios are about coming BACK to a live room, so the room must not
  // be torn down while they run. With the production twelve seconds, outliving
  // an answer window (scenario 3) races the teardown and the test measures
  // whichever won — that is how it failed once and passed twice. The teardown
  // itself is a different scenario, with its own spec: recovery-roomgone.
  RECONNECT_GRACE_MS: '90000',
};

/**
 * Records what the client is told about the phase windows.
 *
 * The timer BAR is no measure of time: it is scaled to whatever window it was
 * handed, so it starts at 100% again after a recovery even when the deadline is
 * seconds away. What "the countdown must not lengthen" really means is that the
 * absolute deadline does not move and the remaining time only shrinks — which is
 * what the client is given, so that is what this reads.
 */
async function watchPhases(page) {
  await page.evaluate(() => {
    window.__phases = [];
    for (const name of ['openTeamSubmit', 'openGuess', 'phaseSync']) {
      socket.on(name, (p) => window.__phases.push({
        name,
        at: Date.now(),
        attempt: p && p.attempt,
        closesAt: (p && (p.closesAt || p.teamClosesAt || p.guessClosesAt)) || 0,
        teamClosesAt: (p && p.teamClosesAt) || 0,
        guessClosesAt: (p && p.guessClosesAt) || 0,
        state: p && p.state,
      }));
    }
  });
}

/** The client's own view of how long is left on a deadline, by the server clock. */
const remainingFor = (page, closesAt) => page.evaluate(
  (deadline) => remainingMs(deadline, 0), closesAt);

/** The last recorded event of a kind, as the page saw it. */
const lastPhase = (page, name) => page.evaluate(
  (kind) => [...window.__phases].reverse().find((p) => p.name === kind) || null, name);

/** Takes the network away from one page's context and waits for the client to notice. */
async function goOffline(page) {
  await page.context().setOffline(true);
  await page.waitForFunction(() => socket.disconnected, null, { timeout: 15000 });
}

async function goOnline(page) {
  await page.context().setOffline(false);
  await page.waitForFunction(() => socket.connected, null, { timeout: 30000 });
}

module.exports.run = async ({ browser, baseUrl }) => {
  const notes = [];
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await watchPhases(pageA);
    await startGame(pageA, pageB, ['Kopan', 'Kalan']);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });

    // --- 1. dropped inside the team window -----------------------------------
    const teamOpen = await lastPhase(pageA, 'openTeamSubmit');
    assert.ok(teamOpen && teamOpen.closesAt, 'the team window arrived with no deadline');
    const teamRemainingBefore = await remainingFor(pageA, teamOpen.closesAt);
    await goOffline(pageA);
    // The player is told, rather than left wondering why nothing responds.
    const notice = (await pageA.textContent('#teamFeedback')).trim();
    assert.ok(/koptu/.test(notice), `no disconnect notice was shown: "${notice}"`);
    await sleep(1200);
    await goOnline(pageA);

    assert.strictEqual(await pageA.evaluate(() => socket.recovered), true,
      'the connection did not recover inside the window');
    assert.ok(await pageA.isVisible('#teamPhase:not(.hidden)'),
      'the team window did not come back after recovery');

    // The truth after recovery comes from phaseSync, not from the replayed
    // openTeamSubmit: replays carry the ORIGINAL payload, timers and all.
    const syncAfterTeam = await lastPhase(pageA, 'phaseSync');
    assert.ok(syncAfterTeam, 'recovery brought no phaseSync, so the client is guessing');
    assert.strictEqual(syncAfterTeam.state, 'team-submit',
      `the server put the room in "${syncAfterTeam.state}" rather than the team window`);
    assert.strictEqual(syncAfterTeam.teamClosesAt, teamOpen.closesAt,
      'the team deadline moved across the drop, which is extra time for one side');
    const teamRemainingAfter = await remainingFor(pageA, syncAfterTeam.teamClosesAt);
    assert.ok(teamRemainingAfter < teamRemainingBefore,
      `the countdown got longer across the drop (${teamRemainingBefore}ms -> ${teamRemainingAfter}ms)`);
    assert.ok(await pageA.isVisible('#screen-game.active'), 'the player lost the game screen');
    notes.push(`takım penceresinde kopma: faz geri döndü, bitiş anı değişmedi, kalan süre ${teamRemainingBefore}ms → ${teamRemainingAfter}ms`);

    // The round then plays on normally — recovery is not a dead end.
    await pageA.fill('#teamInput', 'Chelsea');
    await pageA.click('#btnSubmitTeam');
    await pageB.fill('#teamInput', 'Liverpool');
    await pageB.click('#btnSubmitTeam');
    await pageA.waitForSelector('#guessPhase:not(.hidden)', { timeout: 25000 });

    // --- 2. dropped inside the answer window ---------------------------------
    const guessOpen = await lastPhase(pageA, 'openGuess');
    assert.ok(guessOpen && guessOpen.closesAt, 'the answer window arrived with no deadline');
    const guessRemainingBefore = await remainingFor(pageA, guessOpen.closesAt);
    await goOffline(pageA);
    await sleep(1200);
    await goOnline(pageA);
    assert.strictEqual(await pageA.evaluate(() => socket.recovered), true,
      'the connection did not recover inside the answer window');
    await pageA.waitForSelector('#guessPhase:not(.hidden)', { timeout: 10000 });
    const syncAfterGuess = await lastPhase(pageA, 'phaseSync');
    assert.strictEqual(syncAfterGuess.state, 'player-submit',
      `the server put the room in "${syncAfterGuess.state}" rather than the answer window`);
    assert.strictEqual(syncAfterGuess.guessClosesAt, guessOpen.closesAt,
      'the answer deadline moved across the drop');
    const guessRemainingAfter = await remainingFor(pageA, syncAfterGuess.guessClosesAt);
    assert.ok(guessRemainingAfter < guessRemainingBefore,
      `the answer countdown got longer across the drop (${guessRemainingBefore}ms -> ${guessRemainingAfter}ms)`);
    notes.push(`cevap penceresinde kopma: faz geri döndü, bitiş anı değişmedi, kalan süre ${guessRemainingBefore}ms → ${guessRemainingAfter}ms`);

    // --- 3. an answer typed while offline does not land in the next round ----
    // The client queues emits while the transport is down and replays them on
    // reconnect. Replayed after the window closed, an answer must be refused:
    // it was typed for a round that is over.
    await goOffline(pageA);
    await pageA.fill('#guessInput', 'Mohamed Salah');
    await pageA.click('#btnSubmitGuess');           // queued, not sent

    // Wait for the SERVER to move on, not for a stopwatch: the opponent's screen
    // is the readout. A fixed sleep here would be guessing how long the round
    // takes to close, and the offline player's own screen cannot say — it is
    // receiving nothing.
    await pageB.waitForSelector('#teamPhase:not(.hidden)', { timeout: 30000 });
    const roundOnB = (await pageB.textContent('#roundLabel')).trim();
    assert.ok(/2/.test(roundOnB), `the server did not start a new round: "${roundOnB}"`);
    assert.ok(await pageB.isVisible('#screen-game.active'),
      'the room was torn down while the answer window was being outlived, so this scenario proved nothing');

    await goOnline(pageA);
    assert.strictEqual(await pageA.evaluate(() => socket.recovered), true,
      'the drop outlasted the recovery window, so this scenario proved nothing');

    // Round 2 is what both sides are on now, and the stale answer scored nothing.
    await pageB.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });
    const scoreA = (await pageA.textContent('#myScore')).trim();
    assert.strictEqual(scoreA, '0',
      `the answer queued while offline was scored in the next round (score ${scoreA})`);
    const roundText = (await pageA.textContent('#roundLabel')).trim();
    assert.ok(/2/.test(roundText), `the client is not on the new round: "${roundText}"`);
    notes.push(`çevrimdışı yazılan cevap yeni tura taşınmadı (skor ${scoreA}, "${roundText}")`);

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return notes.join(' · ');
  } finally {
    await close();
  }
};
