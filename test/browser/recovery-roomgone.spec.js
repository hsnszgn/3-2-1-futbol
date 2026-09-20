/**
 * Coming back to a room that is no longer there.
 *
 * Recovery can succeed — same socket, same identity — and still land in nothing:
 * the room is torn down RECONNECT_GRACE_MS after the server notices a player is
 * gone.
 *
 * What this asserts is the player-visible requirement: the lobby, with a reason,
 * and no live-looking game screen. It deliberately does NOT assert which event
 * delivered it. Two do: the server's own roomGone, and the opponentLeft that
 * Socket.IO replays to a session that was away. Removing roomGone leaves this
 * test passing (measured, three runs), so it is a safety net here rather than
 * the fix — and this comment exists because the first version of this file
 * claimed otherwise.
 *
 * The grace period is two seconds here so the teardown is reached in a test
 * rather than in twelve seconds of sleeping; the recovery window is left at its
 * production value, which is the point — recovery WORKS, the room is what is
 * missing.
 */
const assert = require('assert');
const { twoPlayers, startGame } = require('./helpers');

module.exports.env = { MAX_ROUNDS: '2', RECONNECT_GRACE_MS: '2000' };

module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await startGame(pageA, pageB, ['Kopan', 'Kalan']);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });
    const socketBefore = await pageA.evaluate(() => socket.id);

    await pageA.context().setOffline(true);
    await pageA.waitForFunction(() => socket.disconnected, null, { timeout: 15000 });

    // The opponent's screen is the signal that the room is really gone: it gets
    // opponentLeft when the teardown fires. Waiting on a clock instead would be
    // guessing how long the server takes to notice a browser going offline,
    // which is not ours to choose.
    await pageB.waitForSelector('#screen-lobby.active', { timeout: 90000 });

    await pageA.context().setOffline(false);
    await pageA.waitForFunction(() => socket.connected, null, { timeout: 30000 });

    assert.strictEqual(await pageA.evaluate(() => socket.recovered), true,
      'the socket did not recover, so this is the expired-window case, not this one');
    assert.strictEqual(await pageA.evaluate(() => socket.id), socketBefore,
      'recovery produced a different socket id');

    // A clear final state, and not a game screen.
    await pageA.waitForSelector('#screen-lobby.active', { timeout: 20000 });
    const text = (await pageA.textContent('#lobbyStatus')).trim();
    // Either ending is correct; see the note at the top of this file.
    assert.ok(/maç sona erdi|bağlantıyı kopardı/.test(text),
      `the player was returned to the lobby with no explanation: "${text}"`);
    assert.ok(await pageA.isHidden('#screen-game.active'),
      'the game screen was still up after the match had ended');
    assert.ok(await pageA.isVisible('#btnQuickMatch'), 'no way back into a new match');

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return `oda yok olduktan sonra dönüş (grace 2000ms): recovery başarılı, socket aynı, lobiye açık mesajla düşüldü ("${text}")`;
  } finally {
    await close();
  }
};
