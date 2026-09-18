/**
 * Hostile socket payloads must not take the server down.
 *
 * This is the regression test for the worst class of bug this project can
 * have: an unauthenticated client sending one malformed event and killing the
 * process for everyone currently playing. The test drives a real Socket.IO
 * client against a real server — mocking the transport would not prove the
 * handler is safe.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor, silenceConsole } = require('./helpers');

// Every shape an attacker can send: no payload at all, null, primitives,
// arrays, and fields of the wrong type or absurd size.
const HOSTILE = [
  undefined,
  null,
  0,
  '',
  'merhaba',
  true,
  [],
  [1, 2, 3],
  {},
  { name: null },
  { name: 123 },
  { name: {} },
  { name: [] },
  { name: 'x'.repeat(100000) },
  { team: null },
  { team: { toString: 'not a function' } },
  { guess: null },
  { guess: 12345 },
  { code: null },
  { code: [] },
  { name: 'a', code: { nested: { deep: true } } },
];

const EVENTS = [
  'joinQueue',
  'createPrivateRoom',
  'joinPrivateRoom',
  'submitTeam',
  'submitGuess',
  'requestRematch',
  'leaveRoom',
];

module.exports = async function run() {
  const restoreConsole = silenceConsole();
  const server = await startTestServer();

  try {
    const attacker = await connectClient(server.url);

    // Fire every hostile payload at every event.
    let sent = 0;
    for (const event of EVENTS) {
      for (const payload of HOSTILE) {
        attacker.emit(event, payload);
        sent += 1;
      }
    }
    // Give the server a moment to process (and, if broken, to die).
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.ok(server.isAlive(), `server died after ${sent} hostile payloads`);

    // The real proof: two ordinary players can still start a game afterwards.
    const [a, b] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
    const matchedA = waitFor(a, 'matched', 8000);
    const matchedB = waitFor(b, 'matched', 8000);
    a.emit('joinQueue', { name: 'Ali' });
    b.emit('joinQueue', { name: 'Veli' });
    await Promise.all([matchedA, matchedB]);

    assert.ok(server.isAlive(), 'server died while starting a normal game');

    // And the HTTP surface is still answering.
    const health = await fetch(`${server.url}/healthz`);
    assert.strictEqual(health.status, 200, 'health endpoint should still answer');

    attacker.close();
    a.close();
    b.close();

    return `${sent} bozuk payload gönderildi; sunucu ayakta, normal oyun başladı, /healthz 200`;
  } finally {
    restoreConsole();
    await server.stop();
  }
};
