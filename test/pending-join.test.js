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

    assert.ok(server.isAlive(), 'server should still be running');
    return notes.join(' · ');
  } finally {
    await server.stop();
  }
};
