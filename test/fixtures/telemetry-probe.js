/**
 * A child process that drives server/telemetry.js for one scenario and prints
 * what happened as JSON on the last line.
 *
 * Why a child process at all: server/db.js opens its pool when it is first
 * required and the test suite shares one process, so by the time a telemetry
 * test ran the cached module could already hold a CLOSED pool from an earlier
 * test. Each scenario also needs its own configuration (a tiny queue, a dead
 * database, a cohort label), and those are read at load time. A fresh process
 * per scenario is the only honest way to get both.
 *
 * Usage: node telemetry-probe.js <scenario>
 * Environment: DATABASE_URL plus whatever the scenario needs.
 */

const scenario = process.argv[2];

function out(payload) {
  process.stdout.write(`\n__PROBE__${JSON.stringify(payload)}\n`);
}

async function main() {
  const db = require('../../server/db');
  const telemetry = require('../../server/telemetry');

  // The queue only drains once the schema is in place, exactly as in the server.
  if (scenario !== 'write-failure' && scenario !== 'overflow') {
    await db.migrate();
  }

  const gameId = process.env.PROBE_GAME_ID || 'probe-game';

  if (scenario === 'idempotent') {
    // The same event, delivered twice with the same id: the second delivery is
    // the retry case and must not become a second game.
    const id = 'probe-event-idempotent';
    telemetry.record('game_started', { eventId: id, gameId, seat: 'A', details: { mode: 'duel', max_rounds: 5 } });
    telemetry.record('game_started', { eventId: id, gameId, seat: 'A', details: { mode: 'duel', max_rounds: 5 } });
    const flushed = await telemetry.flush(5000);
    out({ flushed, health: telemetry.health() });
  } else if (scenario === 'conflict') {
    // The same id carrying something else. This is a contradiction, not a
    // retry, and it must be reported rather than dropped.
    const id = 'probe-event-conflict';
    telemetry.record('game_finished', {
      eventId: id, gameId, details: { score_a: 3, score_b: 1, winner_seat: 'A' },
    });
    await telemetry.flush(5000);
    telemetry.record('game_finished', {
      eventId: id, gameId, details: { score_a: 9, score_b: 0, winner_seat: 'B' },
    });
    const flushed = await telemetry.flush(5000);
    out({ flushed, health: telemetry.health() });
  } else if (scenario === 'client-cannot-claim-human') {
    // A client notice arrives claiming to be real beta traffic. The stored kind
    // must be the one the SERVER was configured with.
    telemetry.record('result_rendered', {
      gameId,
      seat: 'B',
      source: 'client',
      trafficKind: 'human_beta',
      details: { round: 2, rounds_played: 2 },
    });
    const flushed = await telemetry.flush(5000);
    out({ flushed, health: telemetry.health() });
  } else if (scenario === 'details-allowlist') {
    // A caller hands over more than the contract allows, including the things
    // that must never be stored.
    telemetry.record('round_scored', {
      gameId,
      attemptId: 3,
      seat: 'A',
      details: {
        round: 1,
        points: 3,
        scored_seat: 'A',
        elapsed_ms: 412,
        token: 'sess_secretvalue',
        password: 'hunter2',
        authorization: 'Bearer abc',
        answer: 'Mohamed Salah',
        username: 'ali',
        ip: '203.0.113.7',
        connectionString: 'postgres://u:p@host/db',
        payload: { nested: 'object' },
      },
    });
    const flushed = await telemetry.flush(5000);
    out({ flushed, health: telemetry.health() });
  } else if (scenario === 'overflow') {
    // No database at all: the queue fills, and what it cannot hold must be
    // COUNTED and must degrade the process, not vanish quietly.
    const ids = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(telemetry.record('phase_rendered', {
        gameId, attemptId: i, seat: 'A', source: 'client', details: { phase: 'guess', round: 1 },
      }));
    }
    out({ accepted: ids.filter(Boolean).length, health: telemetry.health() });
  } else if (scenario === 'write-failure') {
    // A database that refuses every connection. recordDurable must report
    // failure so the caller can refuse to start a game it cannot measure, and
    // record() must give up after its retry budget instead of looping forever.
    const durable = await telemetry.recordDurable('game_started', {
      gameId, details: { mode: 'duel', max_rounds: 5 },
    });
    telemetry.record('game_finished', { gameId, details: { score_a: 1, score_b: 0, winner_seat: 'A' } });
    const flushed = await telemetry.flush(8000);
    out({ durable, flushed, health: telemetry.health() });
  } else if (scenario === 'durable-start') {
    // The M3 pre-condition: the start of a measured game is in the database
    // BEFORE its rounds begin. The process is then killed without a flush, so
    // the row can only be there if it was written synchronously.
    const durable = await telemetry.recordDurable('game_started', {
      gameId, details: { mode: 'duel', max_rounds: 5 },
    });
    // Queued but never flushed: this one is expected to be LOST, and that is
    // the point — a report must find the half-played game instead of dropping it
    // from the denominator.
    telemetry.record('round_scored', {
      gameId, attemptId: 1, seat: 'A', details: { round: 1, points: 3, scored_seat: 'A' },
    });
    out({ durable, health: telemetry.health() });
    // Hard exit: no flush, no pool drain. Same as a killed container.
    process.kill(process.pid, 'SIGKILL');
    return;
  } else if (scenario === 'invalid') {
    // Four ways of being wrong, none of which may throw into the game.
    const results = {
      unknownType: telemetry.record('not_an_event', { gameId }),
      badReason: telemetry.record('game_aborted', { gameId, reasonCode: 'because' }),
      badSeat: telemetry.record('game_finished', { gameId, seat: 'Z' }),
      badSource: telemetry.record('game_finished', { gameId, source: 'browser' }),
      good: telemetry.record('game_aborted', { gameId, reasonCode: 'left', details: { round: 2 } }),
    };
    const flushed = await telemetry.flush(5000);
    out({
      accepted: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Boolean(v)])),
      flushed,
      health: telemetry.health(),
    });
  } else {
    throw new Error(`unknown scenario: ${scenario}`);
  }

  await db.close().catch(() => {});
}

main().then(() => process.exit(0), (err) => {
  process.stderr.write(`probe failed: ${err && err.stack}\n`);
  process.exit(1);
});
