/**
 * The result screen needs the room too.
 *
 * A rematch is played in the room the match was played in, so the connection
 * matters just as much on the result screen as it does mid-round. That screen was
 * left out of the room lifecycle: a player whose connection dropped there was
 * told nothing, the recovery window passed, and the rematch button then sent its
 * request from a brand-new socket with no room. The server had nothing to answer,
 * so the button sat disabled forever with no explanation.
 *
 * Both halves are driven here, because a fix that simply disables the rematch
 * would "pass" the failing half while breaking the normal one:
 *   1. recovery succeeds  -> the rematch still works, end to end;
 *   2. recovery is refused -> the rematch is disabled WITH a reason, before any
 *      click, and the lobby is still reachable.
 */
const assert = require('assert');
const { twoPlayers, startGame, playRound, sleep } = require('./helpers');

// One round, so the result screen is two submissions away. The room outlives
// everything here: this is about a refused recovery, not a torn-down room.
//
// The recovery window has to serve both scenarios from the same server, and the
// first version got that wrong: at 1200ms it was shorter than Socket.IO's own
// reconnect delay (1s plus up to 50% jitter, plus the handshake), so the quick
// drop in scenario 1 sometimes came back too late and the server rightly refused
// it — the test then failed waiting for a recovery that was never going to
// happen. 4s is comfortably longer than one reconnect attempt and comfortably
// shorter than the 8s scenario 2 stays away.
module.exports.env = {
  MAX_ROUNDS: '1',
  RECOVERY_WINDOW_MS: '4000',
  RECONNECT_GRACE_MS: '90000',
};

async function playToGameOver(pageA, pageB) {
  await playRound(pageA, pageB, {
    teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah', winner: 'A',
  });
  await Promise.all([
    pageA.waitForSelector('#screen-over.active', { timeout: 25000 }),
    pageB.waitForSelector('#screen-over.active', { timeout: 25000 }),
  ]);
}

module.exports.run = async ({ browser, baseUrl }) => {
  const notes = [];
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    // --- 1. a recovered connection keeps its rematch --------------------------
    await startGame(pageA, pageB, ['Kopan', 'Kalan']);
    await playToGameOver(pageA, pageB);

    const socketBefore = await pageA.evaluate(() => socket.id);
    // A brief drop, inside the recovery window: the room, and the rematch, survive.
    await pageA.evaluate(() => socket.io.engine.close());
    await pageA.waitForFunction(() => socket.connected, null, { timeout: 20000 });
    assert.strictEqual(await pageA.evaluate(() => socket.recovered), true,
      'the quick drop did not recover — the recovery window is too short for one reconnect attempt');
    assert.strictEqual(await pageA.evaluate(() => socket.id), socketBefore,
      'a recovered connection came back with a different socket id');
    assert.ok(await pageA.isEnabled('#btnRematch'),
      'a recovered connection lost its rematch button');

    await pageA.click('#btnRematch');
    await pageB.click('#btnRematch');
    await Promise.all([
      pageA.waitForSelector('#screen-game.active', { timeout: 25000 }),
      pageB.waitForSelector('#screen-game.active', { timeout: 25000 }),
    ]);
    notes.push('kısa kopma sonrası recovery: rövanş düğmesi çalışıyor, yeni maç başladı');

    // --- 2. a refused recovery says so, before anything is clicked -----------
    await playToGameOver(pageA, pageB);
    const idBefore = await pageA.evaluate(() => socket.id);

    await pageA.context().setOffline(true);
    await pageA.waitForFunction(() => socket.disconnected, null, { timeout: 15000 });
    // Told immediately, on the screen the player is looking at.
    const whileOffline = (await pageA.textContent('#rematchStatus')).trim();
    assert.ok(/koptu/.test(whileOffline),
      `nothing was said while the connection was down: "${whileOffline}"`);

    await sleep(8000); // past the 4s window, nowhere near the room's 90s grace
    await pageA.context().setOffline(false);
    await pageA.waitForFunction(() => socket.connected, null, { timeout: 30000 });

    assert.strictEqual(await pageA.evaluate(() => socket.recovered), false,
      'the connection recovered, so the refused-recovery case was never reached');
    assert.notStrictEqual(await pageA.evaluate(() => socket.id), idBefore,
      'a refused recovery kept the old socket id');

    // The rematch is off BEFORE any click, with a reason — not dead after one.
    await pageA.waitForFunction(
      () => document.getElementById('btnRematch').disabled, null, { timeout: 15000 });
    const reason = (await pageA.textContent('#rematchStatus')).trim();
    assert.ok(/maç sona erdi/.test(reason) && /lobi/i.test(reason),
      `the rematch was disabled without telling the player what to do: "${reason}"`);
    // The score is still on screen: there is no reason to take that away.
    assert.ok(await pageA.isVisible('#screen-over.active'),
      'the player was thrown off the result screen');
    assert.ok((await pageA.textContent('#overScore')).trim().length > 0,
      'the final score was cleared');

    // And the way on actually works.
    await pageA.click('#btnBackToLobby');
    await pageA.waitForSelector('#screen-lobby.active', { timeout: 10000 });
    assert.ok(await pageA.isVisible('#btnQuickMatch'), 'no way back into a new match');
    notes.push(`recovery reddedildikçe rövanş tıklanmadan önce kapatıldı ve sebebi yazıldı ("${reason}")`);

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return notes.join(' · ');
  } finally {
    await close();
  }
};
