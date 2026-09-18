/**
 * A connection must never end up in two matches at once.
 *
 * The second independent audit found a path the first fix missed: joining a
 * private invite does not take you out of the random queue, so the next player
 * to queue gets paired with someone who is already mid-game. The victim ends
 * up in two rooms, with two sets of timers, and the room they abandon is
 * orphaned.
 *
 * Sequence under test (verbatim from the audit):
 *   1. H creates a private invite
 *   2. A joins the random queue
 *   3. A accepts H's invite      -> room H-A
 *   4. B joins the random queue
 *   5. A is still queued         -> room A-B  <-- the bug
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function collectMatches(socket) {
  const seen = [];
  socket.on('matched', (payload) => seen.push(payload));
  return seen;
}

module.exports = async function run() {
  const server = await startTestServer();
  const notes = [];

  try {
    // --- invite join must clear the random queue ---------------------------
    {
      const [h, a, b] = await Promise.all([
        connectClient(server.url), connectClient(server.url), connectClient(server.url),
      ]);
      const aMatches = collectMatches(a);

      const created = waitFor(h, 'privateRoomCreated', 5000);
      h.emit('createPrivateRoom', { name: 'Host' });
      const { code } = await created;

      a.emit('joinQueue', { name: 'Ali' });
      await waitFor(a, 'waiting', 5000);

      a.emit('joinPrivateRoom', { name: 'Ali', code });
      await waitFor(a, 'matched', 8000);

      // B now queues. If A was left in the queue, B is paired with A.
      b.emit('joinQueue', { name: 'Veli' });
      await sleep(700);

      assert.strictEqual(aMatches.length, 1,
        `A ended up in ${aMatches.length} matches (roomIds: ${aMatches.map((m) => m.roomId).join(', ')})`);

      const rooms = new Set(aMatches.map((m) => m.roomId));
      assert.strictEqual(rooms.size, 1, 'A should only ever see one roomId');

      notes.push('davet kabulü kuyruğu temizliyor: A tek maçta');
      [h, a, b].forEach((s) => s.close());
    }

    // --- queueing must never pair you with someone already in a game -------
    {
      const [a, b, c] = await Promise.all([
        connectClient(server.url), connectClient(server.url), connectClient(server.url),
      ]);
      const aMatches = collectMatches(a);
      const cMatches = collectMatches(c);

      a.emit('joinQueue', { name: 'Ali' });
      await waitFor(a, 'waiting', 5000);
      b.emit('joinQueue', { name: 'Veli' });
      await Promise.all([waitFor(a, 'matched', 8000), waitFor(b, 'matched', 8000)]);

      // A is mid-game. If A is somehow still reachable from the queue, C would
      // be paired with them instead of waiting.
      a.emit('joinQueue', { name: 'Ali' });
      c.emit('joinQueue', { name: 'Cem' });
      await sleep(700);

      assert.strictEqual(aMatches.length, 1, 'a player already in a game must not be re-matched');
      assert.strictEqual(cMatches.length, 0, 'C should still be waiting, not paired with a busy player');

      notes.push('oyundaki oyuncu tekrar eşleştirilmiyor: C bekliyor');
      [a, b, c].forEach((s) => s.close());
    }

    // --- a successful invite join must not also report an error ------------
    // createRoom used to fall off the end returning undefined, so the caller
    // treated a perfectly good room as a failure and sent the joiner an error
    // — which the client turns into "back to the lobby", ejecting a player
    // from the game they had just been put into.
    {
      const [host, guest] = await Promise.all([
        connectClient(server.url), connectClient(server.url),
      ]);
      const errors = [];
      guest.on('errorMessage', (e) => errors.push(e && e.message));

      const created = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Host' });
      const { code } = await created;

      const guestMatched = waitFor(guest, 'matched', 8000);
      const hostMatched = waitFor(host, 'matched', 8000);
      guest.emit('joinPrivateRoom', { name: 'Konuk', code });
      await Promise.all([guestMatched, hostMatched]);
      await sleep(400);

      assert.deepStrictEqual(errors, [],
        `a successful invite join also emitted an error: ${errors.join(' | ')}`);

      // And the joiner must not be sitting in the random queue as well.
      const third = await connectClient(server.url);
      const thirdMatches = collectMatches(third);
      third.emit('joinQueue', { name: 'Ucuncu' });
      await sleep(600);
      assert.strictEqual(thirdMatches.length, 0,
        'a third player was paired with someone already in an invite game');

      notes.push('başarılı davet katılımı hata yaymıyor, katılan kuyrukta kalmıyor');
      [host, guest, third].forEach((s) => s.close());
    }

    // --- a failed invite join must not destroy the waiting state -----------
    {
      const a = await connectClient(server.url);
      a.emit('joinQueue', { name: 'Ali' });
      await waitFor(a, 'waiting', 5000);

      const refused = waitFor(a, 'errorMessage', 6000);
      a.emit('joinPrivateRoom', { name: 'Ali', code: 'YOKBOYLE' });
      await refused;

      // A should still be queued: a bad code is not a reason to lose your place.
      const b = await connectClient(server.url);
      const matchedA = waitFor(a, 'matched', 8000);
      b.emit('joinQueue', { name: 'Veli' });
      await matchedA;

      notes.push('geçersiz kod sırayı düşürmüyor');
      a.close();
      b.close();
    }

    assert.ok(server.isAlive(), 'server should still be running');
    return notes.join(' · ');
  } finally {
    await server.stop();
  }
};
