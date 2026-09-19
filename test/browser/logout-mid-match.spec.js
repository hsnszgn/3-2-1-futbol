/**
 * Signing out during a live match must not throw the player out of it.
 *
 * The server takes the identity off the connection and lets the game finish
 * unranked. The client has to do the matching thing — and it did not: clearing
 * the token ran through the same path as switching accounts, which reconnects
 * the socket to hand over a new token. A deliberate reconnect is not a recovery,
 * so the new socket had no room, while the player was left looking at a game
 * screen whose submissions went nowhere.
 *
 * This drives it in a real browser: log out from the page while a round is open,
 * then keep playing.
 */
const assert = require('assert');
const { twoPlayers, register, sleep } = require('./helpers');

module.exports.needsDatabase = true;
module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    const stamp = Date.now().toString().slice(-6);
    await register(pageA, `cikan${stamp}`);
    await register(pageB, `kalan${stamp}`);

    // A signed-in player's name comes from their account, so the name field is
    // hidden and the shared startGame helper (which fills it) does not apply.
    await pageA.click('#btnQuickMatch');
    await pageB.click('#btnQuickMatch');
    await Promise.all([
      pageA.waitForSelector('#screen-game.active', { timeout: 20000 }),
      pageB.waitForSelector('#screen-game.active', { timeout: 20000 }),
    ]);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });

    // Signed out from somewhere else — the same thing the server does when the
    // account is deleted, driven here over HTTP with this page's own token.
    const status = await pageA.evaluate(async () => {
      const key = (window.__BRAND && window.__BRAND.storageKeys.token) || "321futbol.token";
      const token = localStorage.getItem(key);
      const res = await fetch('/api/logout', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      return res.status;
    });
    assert.strictEqual(status, 200, `logout returned ${status}`);

    // Wait for the server's sessionEnded to land and be acted on.
    await pageA.waitForFunction(
      () => {
      const key = (window.__BRAND && window.__BRAND.storageKeys.token) || "321futbol.token";
        return !localStorage.getItem(key);
      },
      { timeout: 15000 },
    );

    // Still in the match, on the same connection, and still able to play.
    const stillInGame = await pageA.evaluate(() =>
      document.getElementById('screen-game').classList.contains('active'));
    assert.ok(stillInGame, 'the player was thrown out of the game screen');

    // Whether the connection survived is not read from the page — nothing
    // exposes the socket id, and adding a hook to the app for a test would be
    // the wrong trade. The round completing below is the proof: a client that
    // replaced its socket has no room on the server, and the submission is
    // dropped without a word.

    await pageA.fill('#teamInput', 'Chelsea');
    await pageA.click('#btnSubmitTeam');
    await pageB.fill('#teamInput', 'Liverpool');
    await pageB.click('#btnSubmitTeam');

    // The round proceeds, which only happens if the submissions reached a room.
    await pageA.waitForSelector('#revealPhase:not(.hidden), #guessPhase:not(.hidden)', { timeout: 25000 });
    await pageA.waitForSelector('#guessPhase:not(.hidden)', { timeout: 25000 });
    await pageA.fill('#guessInput', 'Mohamed Salah');
    await pageA.click('#btnSubmitGuess');
    await pageA.waitForSelector('#resultPhase:not(.hidden)', { timeout: 25000 });

    const result = (await pageA.textContent('#resultText')).trim();
    assert.ok(/Mohamed Salah/.test(result), `the round did not resolve: "${result}"`);

    // And the account card is gone — the player really is signed out.
    const signedOut = await pageA.evaluate(() =>
      document.getElementById('accountCard').classList.contains('hidden'));
    assert.ok(signedOut, 'the UI still shows the player as signed in');

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    return `maç sırasında çıkış: aynı bağlantı korundu, tur misafir olarak tamamlandı ("${result.replace(/\n/g, ' / ')}"), hesap kartı kapandı`;
  } finally {
    await close();
  }
};
