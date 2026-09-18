/**
 * The core loop, end to end, in two real browsers: five rounds, a winner, and
 * a rematch that starts a fresh game without going back to the lobby.
 *
 * This is the spec that would catch the round counter running past the max, a
 * rematch that never starts, and the per-round attempt budget leaking between
 * rounds (which it did catch once already).
 */
const assert = require('assert');
const { twoPlayers, startGame, playRound, sleep } = require('./helpers');

const ROUNDS = [
  { teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah' },
  { teamA: 'Manchester United', teamB: 'Napoli', guess: 'Romelu Lukaku' },
  { teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Fernando Torres' },
  { teamA: 'Manchester United', teamB: 'Napoli', guess: 'Romelu Lukaku' },
  { teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah' },
];

module.exports.needsDatabase = false;
module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await startGame(pageA, pageB);

    for (const round of ROUNDS) await playRound(pageA, pageB, round);

    await pageA.waitForSelector('#screen-over.active', { timeout: 25000 });
    await pageB.waitForSelector('#screen-over.active', { timeout: 25000 });

    const title = (await pageA.textContent('#overTitle')).trim();
    const score = (await pageA.textContent('#overScore')).trim();
    assert.strictEqual(title, 'Kazandın', `A should have won every round, got "${title}"`);

    // The round counter must stop at the maximum, not run past it.
    const label = (await pageA.textContent('#roundLabel')).trim();
    assert.ok(/5\/5$/.test(label), `round label overran the maximum: "${label}"`);

    // Rematch: both ask, a new game starts from 0-0 at round 1.
    await pageA.click('#btnRematch');
    await pageB.click('#btnRematch');
    await pageA.waitForSelector('#screen-game.active', { timeout: 20000 });
    await sleep(500);
    const newLabel = (await pageA.textContent('#roundLabel')).trim();
    const newScore = (await pageA.textContent('#myScore')).trim();
    assert.ok(/1\/5$/.test(newLabel), `rematch should start at round 1, got "${newLabel}"`);
    assert.strictEqual(newScore, '0', 'rematch should start from zero');

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return `5 tur oynandı (${score}), tur sayacı ${label}'te durdu, rövanş ${newLabel} 0-0 başladı`;
  } finally {
    await close();
  }
};
