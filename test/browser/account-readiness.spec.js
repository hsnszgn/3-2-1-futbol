/**
 * A page that is already open must come back when the account service does.
 *
 * `/api/config` was read exactly once, at load. A deployment whose migration
 * had not finished yet — or a database that was slow to accept connections —
 * answered `accountsConfigured: true, accountsEnabled: false`, and the client
 * hid the whole sign-in surface for the lifetime of the page. When the server
 * became ready seconds later, nothing on that page changed: a signed-in player
 * stayed signed out, the leaderboard stayed gone, and only a reload fixed it.
 *
 * Driven here in a real browser against a real PostgreSQL, with the readiness
 * gate opened from the outside mid-session — the same transition a deploy makes.
 *
 * Two things this has to get right beyond "the button comes back":
 *   - re-verifying the stored session must not cost a player their live match,
 *     because the token handover reconnects the socket;
 *   - the retry must be bounded, not a poll loop. The automatic path is measured
 *     here by waiting for it, and the request count is asserted.
 */
const assert = require('assert');
const { twoPlayers, startGame, playRound, register, sleep } = require('./helpers');

module.exports.needsDatabase = true;
// The gate starts closed: the server is configured for accounts but announces
// them as unavailable until the test opens it.
module.exports.env = { FIXTURE: 'readiness-server-entry.js', MAX_ROUNDS: '1' };

module.exports.run = async ({ browser, baseUrl, server }) => {
  const notes = [];
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    // --- 1. configured but not ready: it says so, instead of looking absent --
    await pageA.waitForSelector('#accountNotice:not(.hidden)', { timeout: 15000 });
    assert.ok(await pageA.isHidden('#btnAuth'), 'sign-in offered while the service was unavailable');
    assert.ok(await pageA.isHidden('#btnBoard'), 'the leaderboard was offered while unavailable');
    const noticeText = (await pageA.textContent('#accountNoticeText')).trim();
    assert.ok(noticeText.length > 10, `the notice said nothing useful: "${noticeText}"`);
    const status = await pageA.evaluate(() => Accounts.getStatus());
    assert.strictEqual(status, 'unavailable',
      `an unready service reported "${status}" rather than a temporary outage`);

    // --- 2. it comes back on the same page, with no reload -------------------
    await server.control({ type: 'setReady', open: true }, 'readySet');
    await pageA.click('#btnAccountRetry');
    await pageA.waitForSelector('#btnAuth:not(.hidden)', { timeout: 15000 });
    await pageA.waitForSelector('#accountNotice', { state: 'hidden', timeout: 5000 });
    assert.ok(await pageA.isVisible('#btnBoard'), 'the leaderboard did not come back');
    notes.push('kapalıyken uyarı görünür ve giriş gizli; servis açılınca aynı sayfada geri geldi');

    // The account features are not merely visible, they work: this registers
    // through the real form against the real database.
    const stamp = Date.now().toString().slice(-6);
    const username = `hazir${stamp}`;
    await register(pageA, username);

    // --- 3. a stored session is re-verified by itself, with no clicks --------
    // Same browser, service down again at load: the card must be gone (the
    // token cannot be checked), and must return on its own when it is back.
    await server.control({ type: 'setReady', open: false }, 'readySet');

    // An outage is not a sign-out. Re-verifying against a service that answers
    // 503 used to drop the stored token, which signed a player out for good over
    // an outage that lasted seconds. The card goes, the token stays.
    const keyName = await pageA.evaluate(() => (window.__BRAND && window.__BRAND.storageKeys.token) || '321futbol.token');
    await pageA.evaluate(() => Accounts.refreshMe());
    assert.ok(await pageA.evaluate((k) => localStorage.getItem(k), keyName),
      'a 503 from the account service threw the stored session away');
    assert.strictEqual(await pageA.evaluate(() => Accounts.getStatus()), 'unavailable',
      'the client kept claiming the service was ready after it answered 503');
    assert.ok(await pageA.isHidden('#accountCard'),
      'a signed-in card was left up while the service could not confirm it');

    await pageA.reload();
    await pageA.waitForSelector('#accountNotice:not(.hidden)', { timeout: 15000 });
    assert.ok(await pageA.isHidden('#accountCard'),
      'a signed-in card was painted while the session could not be verified');

    const before = await pageA.evaluate(() => performance.getEntriesByType('resource')
      .filter((r) => r.name.includes('/api/config')).length);
    await server.control({ type: 'setReady', open: true }, 'readySet');
    // No click this time — the page's own bounded recheck has to do it.
    await pageA.waitForSelector('#accountCard:not(.hidden)', { timeout: 30000 });
    assert.strictEqual((await pageA.textContent('#accName')).trim(), username,
      'the recovered session came back as somebody else');
    const configRequests = await pageA.evaluate(() => performance.getEntriesByType('resource')
      .filter((r) => r.name.includes('/api/config')).length);
    assert.ok(configRequests - before <= 4,
      `the page made ${configRequests - before} config requests in that window — that is polling, not backoff`);
    notes.push(`kesinti sırasında jeton korundu; saklanan oturum tıklama olmadan geri geldi (${configRequests - before} config isteği ile)`);

    // --- 4. none of it disturbs a match in progress --------------------------
    // The recovery path notifies the client that it has an identity again, and
    // that handover reconnects the socket. Mid-match a reconnect means a new
    // socket with no room, so it has to wait.
    await server.control({ type: 'setReady', open: false }, 'readySet');
    await Promise.all([pageA.reload(), pageB.reload()]);
    await pageA.waitForSelector('#accountNotice:not(.hidden)', { timeout: 15000 });

    await startGame(pageA, pageB, ['Ali', 'Veli']);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });
    const socketBefore = await pageA.evaluate(() => socket.id);

    await server.control({ type: 'setReady', open: true }, 'readySet');
    // The card itself lives on the lobby screen, so it cannot be *visible*
    // during a game — the state is what matters here: the session came back.
    await pageA.waitForFunction(() => Boolean(Accounts.getMe()), null, { timeout: 30000 });
    assert.ok(await pageA.isVisible('#screen-game.active'),
      'the player was thrown out of the game screen by the recovery');
    const socketDuring = await pageA.evaluate(() => socket.id);
    assert.strictEqual(socketDuring, socketBefore,
      'the socket was reconnected mid-match, which loses the room');

    // And the match really does finish — the submissions still reach a room.
    const { winnerText } = await playRound(pageA, pageB, {
      teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah', winner: 'A',
    });
    assert.ok(/buldun/.test(winnerText) && /Salah/.test(winnerText),
      `the round did not resolve for the recovered player: "${winnerText}"`);
    await pageA.waitForSelector('#screen-over.active', { timeout: 25000 });
    notes.push(`maç sırasında toparlanma: aynı socket (${socketBefore}) korundu, tur tamamlandı`);

    // The postponed handover happens once there is no room left to lose.
    await pageA.click('#btnBackToLobby');
    await pageA.waitForSelector('#screen-lobby.active', { timeout: 10000 });
    await sleep(600);
    const socketAfter = await pageA.evaluate(() => socket.id);
    assert.notStrictEqual(socketAfter, socketBefore,
      'the postponed token handover never happened, so the next match would be unranked');
    notes.push('lobiye dönüşte jeton devri yapıldı (socket yenilendi)');

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return notes.join(' · ');
  } finally {
    await close();
  }
};
