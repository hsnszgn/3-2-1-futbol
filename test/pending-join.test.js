/**
 * A join that is still waiting for the host must never speak out of turn.
 *
 * Joining an invite waits for the host to come back — sharing a link means
 * leaving the browser, which drops their socket. That wait is seconds long,
 * and the third independent audit found two ways it goes wrong:
 *
 *   1. Two joins from the same player both wait. The first creates the match;
 *      the second wakes up, finds the invite gone, and reports "this room is
 *      full" — to a player who is already in the game. The client turns any
 *      errorMessage into "back to the lobby", so the player is ejected from a
 *      match that succeeded.
 *
 *   2. The player cancels while waiting. The host returns anyway and the
 *      cancelled player is dropped into the game they walked away from.
 *
 * Both are fixed by versioning the intent: anything that changes where a
 * player is heading retires the attempts started before it, and a retired
 * attempt returns silently.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a condition, so an event that already fired is not missed. */
async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(message);
}

/** Drops the transport but keeps the client, so the server sees a reconnect. */
function dropTransport(socket) {
  socket.io.engine.close();
}

/**
 * Waits for a dropped client to come back and proves it was a *recovery*, not a
 * fresh connection. This matters: the whole pending-join problem only exists
 * because the host keeps its socket id and socket.data across the drop. If the
 * client silently reconnected as someone new, these tests would be green for
 * the wrong reason — the stale invite would be unreachable rather than retired.
 */
async function recoverHost(socket, originalId, timeoutMs = 15000) {
  await waitUntil(() => socket.connected, timeoutMs, 'host never reconnected');
  assert.strictEqual(socket.id, originalId,
    `host reconnected as a new socket (${originalId} -> ${socket.id}), so recovery did not happen`);
  assert.strictEqual(socket.recovered, true,
    'host reconnected without Socket.IO connection state recovery');
}

module.exports = async function run() {
  const server = await startTestServer();
  const notes = [];

  try {
    // --- 1. a duplicate pending join must not report a failure -------------
    {
      const host = await connectClient(server.url, {}, { reconnection: true, reconnectionDelay: 2500 });
      const guest = await connectClient(server.url);

      const created = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Host' });
      const { code } = await created;

      const errors = [];
      const matches = [];
      guest.on('errorMessage', (e) => errors.push(e && e.message));
      guest.on('matched', (m) => matches.push(m && m.roomId));

      // The host goes away, exactly as they do when sharing the link.
      dropTransport(host);
      await sleep(150);

      // The guest taps join twice while the host is away.
      guest.emit('joinPrivateRoom', { name: 'Konuk', code });
      await sleep(80);
      guest.emit('joinPrivateRoom', { name: 'Konuk', code });

      // Both requests are now parked behind the absent host. Wait for it to
      // come back and for both of them to finish.
      await waitUntil(() => matches.length > 0, 12000, 'the guest was never matched');
      await sleep(1500); // let the second, stale request wake up and be silent

      assert.strictEqual(matches.length, 1,
        `duplicate joins produced ${matches.length} matches`);
      assert.deepStrictEqual(errors, [],
        `a stale duplicate join reported a failure after a successful match: ${errors.join(' | ')}`);

      notes.push('yinelenen bekleyen davet: 1 eşleşme, 0 hata');
      host.close();
      guest.close();
    }

    // --- 2. leaving while waiting must cancel the join ---------------------
    {
      const host = await connectClient(server.url, {}, { reconnection: true, reconnectionDelay: 2500 });
      const guest = await connectClient(server.url);

      const created = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Host' });
      const { code } = await created;

      const matches = [];
      guest.on('matched', (m) => matches.push(m && m.roomId));

      dropTransport(host);
      await sleep(150);

      guest.emit('joinPrivateRoom', { name: 'Konuk', code });
      await sleep(120);
      // The player changes their mind while the host is still away.
      guest.emit('leaveRoom', {});

      // Long enough for the host to return and the parked request to wake.
      await sleep(5000);

      assert.strictEqual(matches.length, 0,
        'a cancelled join still dropped the player into the game');

      notes.push('bekleme sırasında ayrılma: eşleşme yok');
      host.close();
      guest.close();
    }

    // --- 3. queueing instead also cancels the pending invite join ---------
    {
      const host = await connectClient(server.url, {}, { reconnection: true, reconnectionDelay: 2500 });
      const guest = await connectClient(server.url);

      const created = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Host' });
      const { code } = await created;

      const matched = [];
      guest.on('matched', (m) => matched.push(m && m.roomId));

      dropTransport(host);
      await sleep(150);

      guest.emit('joinPrivateRoom', { name: 'Konuk', code });
      await sleep(120);
      // Tired of waiting, the player takes the random queue instead.
      guest.emit('joinQueue', { name: 'Konuk' });
      await waitFor(guest, 'waiting', 5000);

      await sleep(5000);

      assert.strictEqual(matched.length, 0,
        'the abandoned invite join still matched the player');

      notes.push('kuyruğa geçiş: eski davet isteği eşleştirmiyor');
      host.close();
      guest.close();
    }

    // --- 4. hosting your own invite retires the join you were waiting on ----
    // Fourth audit, case A: createPrivateRoom never bumped the attempt, so a
    // player who gave up waiting for a friend and started their own invite was
    // still dragged into the old host's room when that host came back.
    {
      const host = await connectClient(server.url, {}, { reconnection: true, reconnectionDelay: 2500 });
      const guest = await connectClient(server.url);

      const created = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Host' });
      const { code } = await created;
      const hostId = host.id;

      const matched = [];
      guest.on('matched', (m) => matched.push(m && m.opponentName));

      dropTransport(host);
      await sleep(150);

      guest.emit('joinPrivateRoom', { name: 'Konuk', code });
      await sleep(120);
      // Changes their mind: they will host instead of joining.
      const ownCode = waitFor(guest, 'privateRoomCreated', 5000);
      guest.emit('createPrivateRoom', { name: 'Konuk' });
      const own = await ownCode;
      assert.ok(own && own.code, 'the player should get their own invite code');
      assert.notStrictEqual(own.code, code, 'the new invite must be a different room');

      await recoverHost(host, hostId);
      await sleep(3000);

      assert.deepStrictEqual(matched, [],
        `the abandoned invite join still matched the player (${matched.join(', ')})`);
      // And their own invite survived: retiring the old intent must not also
      // throw away the new one.
      const stillMine = waitFor(guest, 'privateRoomCreated', 5000);
      guest.emit('createPrivateRoom', { name: 'Konuk' });
      assert.strictEqual((await stillMine).code, own.code,
        'the player lost their own invite code');

      notes.push(`kendi davetini oluşturma: eski davet eşleştirmiyor, yeni kod korunuyor (host recovery doğrulandı, id ${hostId.slice(0, 6)}…)`);
      host.close();
      guest.close();
    }

    // --- 5. re-choosing a queue you are already in also retires it ----------
    // Fourth audit, case B: joinQueue bumped the attempt only on the path that
    // actually enqueued you. Already queued -> invite -> queue again took the
    // "already waiting" shortcut and left the invite join alive.
    {
      const host = await connectClient(server.url, {}, { reconnection: true, reconnectionDelay: 2500 });
      const guest = await connectClient(server.url);

      const created = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Host' });
      const { code } = await created;
      const hostId = host.id;

      // The player is in the random queue FIRST — this is what made the second
      // joinQueue hit the shortcut.
      guest.emit('joinQueue', { name: 'Konuk' });
      await waitFor(guest, 'waiting', 5000);

      const matched = [];
      guest.on('matched', (m) => matched.push(m && m.opponentName));

      dropTransport(host);
      await sleep(150);

      guest.emit('joinPrivateRoom', { name: 'Konuk', code });
      await sleep(120);
      // Back to the queue. They are still in it, so this is the shortcut path.
      guest.emit('joinQueue', { name: 'Konuk' });
      await waitFor(guest, 'waiting', 5000);

      await recoverHost(host, hostId);
      await sleep(3000);

      assert.deepStrictEqual(matched, [],
        `the invite join matched even though the queue was the latest choice (${matched.join(', ')})`);

      // The queue is still their real choice, so a normal opponent must pair.
      const other = await connectClient(server.url);
      const paired = waitFor(guest, 'matched', 8000);
      other.emit('joinQueue', { name: 'Baska' });
      const pairing = await paired;
      assert.strictEqual(pairing.opponentName, 'Baska',
        `the player should have been matched from the queue, got "${pairing.opponentName}"`);

      notes.push(`kuyruğu yeniden seçme: davet eşleştirmiyor, kuyruktan normal eşleşme çalışıyor (host recovery doğrulandı, id ${hostId.slice(0, 6)}…)`);
      host.close();
      guest.close();
      other.close();
    }

    assert.ok(server.isAlive(), 'server should still be running');
    return notes.join(' · ');
  } finally {
    await server.stop();
  }
};
