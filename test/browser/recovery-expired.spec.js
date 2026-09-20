/**
 * Away for longer than recovery allows.
 *
 * Inside the window a dropped socket comes back as itself. Past it, Socket.IO
 * hands the client a brand-new connection with no room and no identity — and
 * nothing tells the page that, so it kept showing a game screen whose
 * submissions went nowhere. The player was left tapping at nothing.
 *
 * The window is two minutes in production, which is not a test; it is set to
 * about a second here (RECOVERY_WINDOW_MS) so the same transition can be driven
 * in seconds. The room itself is still alive at that point, so this is purely
 * the "recovery refused" path — the "room already gone" path is in
 * recovery-ui.spec.js.
 */
const assert = require('assert');
const { twoPlayers, startGame, sleep } = require('./helpers');

module.exports.env = { MAX_ROUNDS: '2', RECOVERY_WINDOW_MS: '1200' };

module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await startGame(pageA, pageB, ['Giden', 'Kalan']);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });
    const socketBefore = await pageA.evaluate(() => socket.id);

    await pageA.context().setOffline(true);
    await pageA.waitForFunction(() => socket.disconnected, null, { timeout: 15000 });
    await sleep(4000); // well past the 1200ms window, well inside the room's grace
    await pageA.context().setOffline(false);
    await pageA.waitForFunction(() => socket.connected, null, { timeout: 30000 });

    assert.strictEqual(await pageA.evaluate(() => socket.recovered), false,
      'the connection recovered after the window — this scenario proved nothing');
    assert.notStrictEqual(await pageA.evaluate(() => socket.id), socketBefore,
      'a refused recovery kept the old socket id');

    // A clear final state, not a live-looking game screen.
    await pageA.waitForSelector('#screen-lobby.active', { timeout: 15000 });
    const text = (await pageA.textContent('#lobbyStatus')).trim();
    assert.ok(/maç sona erdi/.test(text),
      `the player was left without an explanation: "${text}"`);
    assert.ok(await pageA.isHidden('#screen-game.active'),
      'the game screen was still up after the connection was unrecoverable');

    // And the lobby really is usable again, rather than a screen with dead buttons.
    assert.ok(await pageA.isVisible('#btnQuickMatch'), 'no way back into a new match');

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return `recovery penceresi (1200ms) aşıldı: socket yenilendi, lobiye açık mesajla düşüldü ("${text}")`;
  } finally {
    await close();
  }
};
