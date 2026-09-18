/**
 * One connection gets one seat.
 *
 * The audited build let a single socket queue twice and end up in two
 * different matches, and let an invite host join their own code — which for a
 * signed-in player means playing themselves and writing a ranked result for
 * it. These are the regression tests for both.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collects every `matched` event a socket receives, rather than the first. */
function collectMatches(socket) {
  const seen = [];
  socket.on('matched', (payload) => seen.push(payload));
  return seen;
}

module.exports = async function run() {
  const server = await startTestServer();
  const notes = [];

  try {
    // --- a socket that queues repeatedly must still only get one game -------
    {
      const [a, b, c] = await Promise.all([
        connectClient(server.url), connectClient(server.url), connectClient(server.url),
      ]);
      const aMatches = collectMatches(a);
      const bMatches = collectMatches(b);
      const cMatches = collectMatches(c);

      // A hammers the queue before anyone else arrives.
      for (let i = 0; i < 5; i += 1) a.emit('joinQueue', { name: 'Ali' });
      await sleep(200);

      b.emit('joinQueue', { name: 'Veli' });
      c.emit('joinQueue', { name: 'Cem' });
      await sleep(600);

      assert.strictEqual(aMatches.length, 1,
        `a socket that queued 5 times joined ${aMatches.length} games, expected 1`);
      // B and C should find each other rather than both being paired with A.
      assert.strictEqual(bMatches.length, 1, 'B should be in exactly one game');
      assert.ok(cMatches.length <= 1, 'C should be in at most one game');

      notes.push(`5x joinQueue -> ${aMatches.length} maç`);
      [a, b, c].forEach((s) => s.close());
    }

    // --- an invite host cannot join their own code -------------------------
    {
      const host = await connectClient(server.url);
      const created = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Ali' });
      const { code } = await created;

      const hostMatches = collectMatches(host);
      const refused = waitFor(host, 'errorMessage', 5000);
      host.emit('joinPrivateRoom', { name: 'Ali', code });
      const err = await refused;

      assert.ok(err && err.message, 'self-join should be refused with a message');
      await sleep(300);
      assert.strictEqual(hostMatches.length, 0, 'the host must not be matched with themselves');

      notes.push(`kendi davetine katılma reddedildi: "${err.message}"`);
      host.close();
    }

    // --- asking for an invite twice returns the same code ------------------
    {
      const host = await connectClient(server.url);
      const first = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Ali' });
      const a = await first;

      const second = waitFor(host, 'privateRoomCreated', 5000);
      host.emit('createPrivateRoom', { name: 'Ali' });
      const b = await second;

      assert.strictEqual(a.code, b.code,
        `repeated invite requests minted a new code (${a.code} then ${b.code})`);
      notes.push(`tekrar davet isteği aynı kodu döndü (${a.code})`);
      host.close();
    }

    assert.ok(server.isAlive(), 'server should still be running');
    return notes.join(' · ');
  } finally {
    await server.stop();
  }
};
