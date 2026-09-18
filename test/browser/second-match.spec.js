/**
 * A player's SECOND match must work as well as their first.
 *
 * Submissions and phase events now carry an attempt number, and the client
 * ignores anything older than what it already has — that is what stops a
 * reconnecting player from being handed a closed round's clock. But each room
 * counts its attempts from the start, so a second match is not a continuation:
 * its attempt 1 is lower than whatever the last game reached.
 *
 * Left unhandled, every event of the second match looks like a replay of the
 * first and is dropped, and the player sits on a screen that never advances.
 * Nothing in the socket tests catches this, because they each open fresh
 * clients for one match; only a client that plays twice does.
 */
const assert = require('assert');
const { twoPlayers, startGame, playRound, sleep } = require('./helpers');

module.exports.needsDatabase = false;
// Two rounds, not one. The first match has to reach a HIGHER attempt number
// than the second match's first attempt, or there is nothing to get wrong: with
// one round each they both sit on attempt 1 and even the broken client works.
module.exports.env = { MAX_ROUNDS: '2' };
module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    // First match: play it out, so its attempt counter climbs past 1.
    await startGame(pageA, pageB);
    // The winner is told what they found; the points appear in the loser's
    // message. Check the answer landed, not a points string that lives on the
    // other screen.
    let first;
    for (let round = 0; round < 2; round += 1) {
      first = await playRound(pageA, pageB, {
        teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah', winner: 'A',
      });
      assert.ok(/Mohamed Salah/.test(first.winnerText),
        `round ${round + 1} of the first match should resolve normally: "${first.winnerText}"`);
    }

    // Both rounds played, so this is game over.
    await Promise.all([
      pageA.waitForSelector('#screen-over.active', { timeout: 20000 }),
      pageB.waitForSelector('#screen-over.active', { timeout: 20000 }),
    ]);
    // Only one of them needs to leave: the other is sent back to the lobby by
    // opponentLeft, and its game-over screen is gone by the time a second click
    // could land.
    await pageA.click('#btnBackToLobby');
    await Promise.all([
      pageA.waitForSelector('#screen-lobby.active', { timeout: 15000 }),
      pageB.waitForSelector('#screen-lobby.active', { timeout: 15000 }),
    ]);
    await sleep(300);

    // Second match, same two browser contexts — same clients, new room.
    await startGame(pageA, pageB);
    // Reaching the team phase at all is the thing that used to break: the
    // openTeamSubmit for the new room carries a lower attempt number.
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 20000 });
    const second = await playRound(pageA, pageB, {
      teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah', winner: 'B',
    });
    assert.ok(/Mohamed Salah/.test(second.winnerText),
      `the second match should resolve normally: "${second.winnerText}"`);
    assert.ok(/\+3|\+2|\+1/.test(second.loserText),
      `the second match should score normally: "${second.loserText}"`);

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    return `iki ardışık maç aynı istemcide oynandı; ikinci maçın sonucu: "${second.loserText.replace(/\n/g, ' / ')}"`;
  } finally {
    await close();
  }
};
