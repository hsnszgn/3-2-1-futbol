/**
 * M2/M7 in a real browser: the shipped client's two new measurement notices.
 *
 *   1. After a real network drop and Socket.IO recovery, the client reports
 *      that it drew the CURRENT phase — so a recovery counts as visible only
 *      when the screen actually shows the round being played.
 *   2. A client-side error is reported as a KIND and a screen only; the error's
 *      message (which here carries a secret) never reaches the server's table.
 *
 * Socket-level tests send these notices by hand, which proves the server's
 * handling and nothing about whether the real client ever sends them.
 */
const assert = require('assert');
const { Client } = require('pg');
const { twoPlayers, startGame, sleep } = require('./helpers');

module.exports.needsDatabase = true;
module.exports.env = {
  MAX_ROUNDS: '2',
  TELEMETRY_ENABLED: '1',
  TELEMETRY_ENVIRONMENT: 'test',
  RECOVERY_WINDOW_MS: '30000',
  RECONNECT_GRACE_MS: '30000',
};

const SECRET = 'GIZLI-TARAYICI-HATASI-4410';

module.exports.run = async ({ browser, baseUrl }) => {
  const url = process.env.TEST_DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const rows = async (type) => (await db.query(
    'SELECT event_id, reason_code, seat, source, attempt_id, details FROM telemetry_events WHERE event_type = $1 ORDER BY stored_at',
    [type])).rows;
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await startGame(pageA, pageB, ['Kopan', 'Kalan']);
    await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });

    // --- 1. real drop, real recovery, real notice ---------------------------
    await pageA.context().setOffline(true);
    await pageA.waitForFunction(() => socket.disconnected, null, { timeout: 15000 });
    await sleep(1200);
    await pageA.context().setOffline(false);
    await pageA.waitForFunction(() => socket.connected, null, { timeout: 30000 });
    assert.strictEqual(await pageA.evaluate(() => socket.recovered), true, 'the connection did not recover');

    let rendered = [];
    for (let i = 0; i < 100 && !rendered.length; i += 1) {
      rendered = await rows('phase_rendered');
      if (!rendered.length) await sleep(50);
    }
    const disconnects = await rows('disconnect_observed');
    const finished = await rows('recovery_finished');
    assert.strictEqual(disconnects.length, 1, `disconnect episodes: ${disconnects.length}`);
    assert.strictEqual(finished.length, 1);
    assert.strictEqual(finished[0].reason_code, 'recovered');
    assert.strictEqual(rendered.length, 1, `the real client's phase notice was stored ${rendered.length} times`);
    assert.strictEqual(rendered[0].details.episode_id, disconnects[0].event_id,
      'the notice does not close the episode it belongs to');
    assert.strictEqual(rendered[0].details.phase, 'team-submit');
    assert.strictEqual(rendered[0].source, 'client');
    assert.ok(await pageA.isVisible('#teamPhase:not(.hidden)'), 'the team phase is not actually on screen');

    // --- 2. a client error, carrying a secret in its message -----------------
    // Record what the client actually PUTS ON THE WIRE, not only what the
    // server keeps: the server ignores unknown fields, so a client that sent the
    // message would still leave the table clean — and would still be sending a
    // player's data somewhere it was promised not to go.
    await pageA.evaluate(() => {
      window.__sentClientErrors = [];
      const realEmit = socket.emit.bind(socket);
      socket.emit = (event, payload, ...rest) => {
        if (event === 'clientError') window.__sentClientErrors.push(payload);
        return realEmit(event, payload, ...rest);
      };
    });
    await pageA.evaluate((secret) => {
      setTimeout(() => { throw new Error(`boom ${secret}`); }, 0);
      Promise.reject(new Error(`rejected ${secret}`));
    }, SECRET);
    let clientErrors = [];
    for (let i = 0; i < 100 && clientErrors.length < 2; i += 1) {
      clientErrors = await rows('client_error');
      if (clientErrors.length < 2) await sleep(50);
    }
    const kinds = clientErrors.map((r) => r.reason_code).sort();
    assert.deepStrictEqual(kinds, ['script_error', 'unhandled_rejection'], `client errors: ${JSON.stringify(clientErrors)}`);
    assert.ok(clientErrors.every((r) => r.details.screen === 'game'), JSON.stringify(clientErrors));
    const sent = await pageA.evaluate(() => window.__sentClientErrors);
    assert.ok(sent.length >= 2, `the client sent ${sent.length} error reports`);
    for (const payload of sent) {
      assert.deepStrictEqual(Object.keys(payload).sort(), ['kind', 'screen'],
        `the client sent more than a kind and a screen: ${JSON.stringify(payload)}`);
    }
    assert.ok(!JSON.stringify(sent).includes(SECRET), 'the client put the error message on the wire');
    const all = JSON.stringify((await db.query('SELECT * FROM telemetry_events')).rows);
    assert.ok(!all.includes(SECRET), 'the error message reached the measurement table');

    // The two deliberate errors are the only page errors.
    const unexpected = errors.filter((e) => !e.includes(SECRET));
    assert.deepStrictEqual(unexpected, [], `client errors: ${unexpected.join(' | ')}`);
    return 'gerçek ağ kesintisi + recovery: istemci güncel fazı (team-submit) çizdikten sonra bildirdi, bölüm kimliğiyle, '
      + 'bir kez · gerçek istemci hatası ve reddedilen promise: script_error ve unhandled_rejection, ekran "game", '
      + 'istemci tele yalnız {kind, screen} koydu, mesajdaki gizli metin ne tele ne tabloya girdi';
  } finally {
    await close();
    await db.end().catch(() => {});
  }
};
