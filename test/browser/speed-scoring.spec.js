/**
 * Speed scoring, and what the slower player is told.
 *
 * Both halves matter. The scoring tiers are the game's whole tension, and the
 * loser's message was a specific request: a correct answer that arrived second
 * must not look like a rejected answer. A regression here silently makes the
 * game feel broken.
 */
const assert = require('assert');
const { twoPlayers, startGame, playRound } = require('./helpers');

module.exports.needsDatabase = false;
module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await startGame(pageA, pageB);

    const { winnerText, loserText } = await playRound(pageA, pageB, {
      teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah',
    });

    // Fastest tier is worth 3 points and says so.
    const points = (await pageA.textContent('#verdictPoints')).trim();
    assert.strictEqual(points, '+3', `a sub-5s answer should score +3, got "${points}"`);
    assert.ok(/saniyede buldun/.test(winnerText), `winner text unexpected: "${winnerText}"`);

    // The loser learns they were beaten on time, not that they were wrong, and
    // sees what the winner earned.
    assert.ok(/hızlıydı/.test(loserText), `loser should be told they were beaten: "${loserText}"`);
    assert.ok(/\+3/.test(loserText), `loser should see what the winner earned: "${loserText}"`);
    assert.ok(/Mohamed Salah/.test(loserText), `loser should see the answer: "${loserText}"`);

    const score = (await pageA.textContent('#myScore')).trim();
    assert.strictEqual(score, '3', `winner's score should be 3, got ${score}`);

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return `hızlı cevap ${points}; kaybeden mesajı: "${loserText.replace(/\n/g, ' / ')}"`;
  } finally {
    await close();
  }
};
