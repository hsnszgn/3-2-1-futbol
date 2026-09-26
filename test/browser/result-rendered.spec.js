/**
 * M2/M7: the REAL client reports that it drew the result screen.
 *
 * The socket-level test (test/telemetry-game.test.js) sends the notice by hand,
 * which proves the server handles it and nothing about whether the shipped
 * client ever sends it. The completion ratio's C class requires BOTH screens to
 * have reported the result, so a client that silently stopped sending it would
 * turn every finished game into "unknown" — and nothing in play would look wrong.
 *
 * Here two real Chromium pages play a one-round game and the rows are read back:
 * one result_rendered per seat, from source 'client', for the game that actually
 * ended, and only after the result screen is visible.
 */
const assert = require('assert');
const { Client } = require('pg');
const { twoPlayers, startGame, playRound, sleep } = require('./helpers');

module.exports.needsDatabase = true;
module.exports.env = {
  MAX_ROUNDS: '1',
  TELEMETRY_ENABLED: '1',
  TELEMETRY_ENVIRONMENT: 'beta',
  TELEMETRY_TRAFFIC_KIND: 'manual_qa',
};
module.exports.run = async ({ browser, baseUrl }) => {
  const url = process.env.TEST_DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    await startGame(pageA, pageB);
    await playRound(pageA, pageB, { teamA: 'Chelsea', teamB: 'Liverpool', guess: 'Mohamed Salah' });
    // The result screen, as a player sees it.
    await Promise.all([
      pageA.waitForSelector('#screen-over.active', { state: 'visible', timeout: 15000 }),
      pageB.waitForSelector('#screen-over.active', { state: 'visible', timeout: 15000 }),
    ]);
    const titleA = (await pageA.textContent('#overTitle')).trim();

    let rows = [];
    for (let i = 0; i < 100; i += 1) {
      rows = (await db.query(
        `SELECT event_type, game_id, seat, source, traffic_kind FROM telemetry_events
          WHERE event_type IN ('game_finished', 'result_rendered') ORDER BY stored_at`)).rows;
      if (rows.filter((r) => r.event_type === 'result_rendered').length >= 2) break;
      await sleep(50);
    }
    const finished = rows.filter((r) => r.event_type === 'game_finished');
    assert.strictEqual(finished.length, 1, `expected one finished game, got ${finished.length}`);
    const rendered = rows.filter((r) => r.event_type === 'result_rendered');
    assert.deepStrictEqual(rendered.map((r) => r.seat).sort(), ['A', 'B'],
      `the real client did not report the result screen from both seats: ${JSON.stringify(rendered)}`);
    assert.ok(rendered.every((r) => r.game_id === finished[0].game_id),
      'a result notice named a different game than the one that finished');
    assert.ok(rendered.every((r) => r.source === 'client'), 'a screen notice was stored as a server fact');
    // The deployment says manual_qa, so that is what the rows say — nothing the
    // browser sent could have changed it.
    assert.ok(rendered.every((r) => r.traffic_kind === 'manual_qa'));

    await sleep(300);
    const again = (await db.query(
      "SELECT count(*)::int AS n FROM telemetry_events WHERE event_type = 'result_rendered'")).rows[0].n;
    assert.strictEqual(again, 2, `the client reported the same screen more than once (${again})`);

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return `gerçek istemci sonuç ekranını ("${titleA}") çizdikten sonra iki koltuktan da `
      + 'result_rendered gönderdi; biten maçın kimliğiyle, source=client, traffic_kind sunucudan (manual_qa), '
      + 'tekrar yok';
  } finally {
    await close();
    await db.end().catch(() => {});
  }
};
