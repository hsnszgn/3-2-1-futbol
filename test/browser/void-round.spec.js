/**
 * Two clubs with nobody in common must void the round, not hand the round to
 * whoever is luckier.
 *
 * This was a real complaint: when no shared player existed, the timer ran out
 * and the opponent effectively won a round nobody could have answered. The
 * round now replays without consuming one of the five.
 */
const assert = require('assert');
const { twoPlayers, startGame } = require('./helpers');

module.exports.needsDatabase = false;
module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await startGame(pageA, pageB);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });

    const roundBefore = (await pageA.textContent('#roundLabel')).trim();

    // Arsenal shares nobody with Napoli in the test data set.
    await pageA.fill('#teamInput', 'Arsenal');
    await pageA.click('#btnSubmitTeam');
    await pageB.fill('#teamInput', 'Napoli');
    await pageB.click('#btnSubmitTeam');

    await pageA.waitForSelector('#resultPhase:not(.hidden)', { timeout: 30000 });
    const message = (await pageA.textContent('#resultText')).trim();
    assert.ok(/birlikte oynamış futbolcu yok/i.test(message),
      `expected a void-round message, got "${message}"`);

    // Nobody scored, and the round number did not advance.
    const score = (await pageA.textContent('#myScore')).trim();
    const oppScore = (await pageA.textContent('#oppScore')).trim();
    assert.strictEqual(score, '0', 'a void round must not score');
    assert.strictEqual(oppScore, '0', 'a void round must not score for the opponent');

    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 30000 });
    const roundAfter = (await pageA.textContent('#roundLabel')).trim();
    assert.strictEqual(roundAfter, roundBefore,
      `a void round consumed a turn: ${roundBefore} -> ${roundAfter}`);

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return `ortak oyuncu yok -> tur geçersiz, skor 0-0, tur ${roundBefore} olarak tekrarlandı`;
  } finally {
    await close();
  }
};
