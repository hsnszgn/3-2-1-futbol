/**
 * A session ended while the connection was away must not come back with it.
 *
 * Connection state recovery restores `socket.data` and skips the middlewares, so
 * whatever identity the socket had is simply handed back — including a session
 * that was signed out, or an account deleted, in the meantime. The server
 * re-checks it instead; this drives that in a real browser, where the client has
 * to do the matching thing: stop presenting a token that no longer works, and
 * keep the player in their match rather than throwing them out of it.
 *
 * The revocation is real: an /api/logout with this page's own token, sent from
 * the other player's page while the first one is offline and cannot send it
 * itself.
 */
const assert = require('assert');
const { twoPlayers, register, sleep } = require('./helpers');

module.exports.needsDatabase = true;
module.exports.env = { MAX_ROUNDS: '1', TEAM_SUBMIT_MS: '20000' };

module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    const stamp = Date.now().toString().slice(-6);
    await register(pageA, `kesil${stamp}`);
    await register(pageB, `duran${stamp}`);

    // Signed-in players are named by their accounts, so the name field is hidden.
    await pageA.click('#btnQuickMatch');
    await pageB.click('#btnQuickMatch');
    await Promise.all([
      pageA.waitForSelector('#screen-game.active', { timeout: 20000 }),
      pageB.waitForSelector('#screen-game.active', { timeout: 20000 }),
    ]);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });

    const key = await pageA.evaluate(() => (window.__BRAND && window.__BRAND.storageKeys.token) || '321futbol.token');
    const token = await pageA.evaluate((k) => localStorage.getItem(k), key);
    assert.ok(token, 'the signed-in page had no session token');
    const socketBefore = await pageA.evaluate(() => socket.id);

    // Away — and while away, signed out from "another device".
    await pageA.context().setOffline(true);
    await pageA.waitForFunction(() => socket.disconnected, null, { timeout: 15000 });
    const logoutStatus = await pageB.evaluate(async (bearer) => {
      const res = await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } });
      return res.status;
    }, token);
    assert.strictEqual(logoutStatus, 200, `revoking the session answered ${logoutStatus}`);

    await pageA.context().setOffline(false);
    await pageA.waitForFunction(() => socket.connected, null, { timeout: 30000 });
    assert.strictEqual(await pageA.evaluate(() => socket.recovered), true,
      'the socket did not recover, so the revoked-identity path was never taken');
    assert.strictEqual(await pageA.evaluate(() => socket.id), socketBefore,
      'recovery produced a different socket id');

    // The client must stop presenting a credential that no longer works.
    await pageA.waitForFunction(() => Accounts.getMe() === null, null, { timeout: 15000 });
    assert.strictEqual(await pageA.evaluate((k) => localStorage.getItem(k), key), null,
      'the revoked token was kept in storage');
    assert.ok(await pageA.isHidden('#accountCard'),
      'the page still showed a signed-in card for an ended session');

    // The match is not collateral damage: it carries on, unranked.
    assert.ok(await pageA.isVisible('#screen-game.active'),
      'the player was thrown out of the match by their own session ending');
    await pageA.fill('#teamInput', 'Chelsea');
    await pageA.click('#btnSubmitTeam');
    await pageB.fill('#teamInput', 'Liverpool');
    await pageB.click('#btnSubmitTeam');
    await pageA.waitForSelector('#guessPhase:not(.hidden)', { timeout: 25000 });
    await pageA.fill('#guessInput', 'Mohamed Salah');
    await pageA.click('#btnSubmitGuess');
    await pageA.waitForSelector('#resultPhase:not(.hidden)', { timeout: 25000 });
    await pageA.waitForSelector('#screen-over.active', { timeout: 25000 });

    // And the ended session does not reappear on the next connection either.
    await pageA.click('#btnBackToLobby');
    await pageA.reload();
    await sleep(800);
    assert.strictEqual(await pageA.evaluate(() => Accounts.getMe()), null,
      'the revoked session came back after a reload');

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return 'kopma sırasında iptal edilen oturum geri gelmedi: jeton silindi, kart gizlendi, maç misafir olarak tamamlandı';
  } finally {
    await close();
  }
};
