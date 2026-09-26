#!/usr/bin/env node
/**
 * Score and recording reconciliation (roadmap M5). Read-only.
 *
 *   npm run beta:integrity -- --cohort beta-01
 *
 * Compares what the server SAID happened (measurement events) with what is
 * actually stored (the matches table), in both directions, and prints findings.
 * It changes nothing: a script that quietly fixed a mismatch would destroy the
 * evidence that there was one.
 *
 * Five checks, each of them a way a result can be wrong while every screen looked
 * right:
 *
 *   1. Round scores that do not add up to the final score, or a winner that does
 *      not follow from it (draws included).
 *   2. A finished game the policy said to record, with no row — or a row for a
 *      game the policy said NOT to record.
 *   3. A rematch that reused the previous game's id, the same game scored twice,
 *      or one id carrying two different results.
 *   4. The reverse direction: rows in the window with no measurement events
 *      behind them. Reported as missing evidence, never assumed to be fine.
 *   5. The recording decision itself: a game whose seats were signed in at kick
 *      off but signed out by the end is NOT a missing record, and the reason is
 *      printed rather than inferred.
 *
 * What it cannot do: if the same wrong score was written to both the event and
 * the row, both sides agree and this script is silent. That is what the answer
 * and scoring tests are for.
 */

const { Client } = require('pg');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i += 1] : 'true';
    args[key] = value;
  }
  return args;
}

/**
 * @returns {{findings: object[], checked: number}} one finding per problem, each
 *   naming the game it belongs to so it can be looked up.
 */
function reconcile({ events, matchRows }) {
  const byGame = new Map();
  for (const event of events) {
    if (!event.game_id) continue;
    if (!byGame.has(event.game_id)) byGame.set(event.game_id, []);
    byGame.get(event.game_id).push(event);
  }
  const rowsByUid = new Map(matchRows.map((row) => [row.match_uid, row]));
  const findings = [];
  const add = (gameId, kind, detail) => findings.push({ gameId, kind, detail });

  for (const [gameId, rows] of byGame) {
    const finished = rows.filter((r) => r.event_type === 'game_finished');
    const scored = rows.filter((r) => r.event_type === 'round_scored');
    const decided = rows.find((r) => r.event_type === 'recording_decided');
    const persisted = rows.find((r) => r.event_type === 'match_persisted');
    const persistFailed = rows.find((r) => r.event_type === 'match_persist_failed');

    // (3) two different results under one id. The unique index on match_uid
    // would hide this by keeping the first row; the events do not.
    if (finished.length > 1) {
      const distinct = new Set(finished.map((f) => JSON.stringify([
        f.details.score_a, f.details.score_b, f.details.winner_seat])));
      add(gameId, distinct.size > 1 ? 'conflicting_results' : 'duplicate_result',
        `${finished.length} game_finished olayı, ${distinct.size} farklı sonuç`);
    }
    if (!finished.length) continue;
    const result = finished[0].details || {};

    // (1) the score has to be the sum of what was scored, and the winner has to
    // follow from the score.
    const totals = { A: 0, B: 0 };
    const seenAttempts = new Set();
    for (const row of scored) {
      const key = `${row.attempt_id}:${row.details && row.details.scored_seat}`;
      if (seenAttempts.has(key)) {
        add(gameId, 'attempt_scored_twice', `deneme ${row.attempt_id} iki kez puanlandı`);
        continue;
      }
      seenAttempts.add(key);
      const seat = (row.details && row.details.scored_seat) || row.seat;
      if (seat === 'A' || seat === 'B') totals[seat] += Number((row.details && row.details.points) || 0);
    }
    if (Number(result.score_a) !== totals.A || Number(result.score_b) !== totals.B) {
      add(gameId, 'score_mismatch',
        `turlar ${totals.A}-${totals.B}, sonuç ${result.score_a}-${result.score_b}`);
    }
    const derivedWinner = totals.A === totals.B ? 'draw' : (totals.A > totals.B ? 'A' : 'B');
    if ((result.winner_seat || 'draw') !== derivedWinner) {
      add(gameId, 'winner_mismatch',
        `skordan türeyen ${derivedWinner}, olaydaki ${result.winner_seat || 'draw'}`);
    }

    // (2) and (5) the row, and the decision that governs it.
    const row = rowsByUid.get(gameId);
    const expectPersist = decided ? (decided.details || {}).decision === 'persist' : null;
    if (expectPersist === null) {
      add(gameId, 'recording_decision_missing', 'kayıt kararı olayı yok; kanıt eksik');
    } else if (expectPersist && !row) {
      add(gameId, persistFailed ? 'persist_failed' : 'row_missing',
        persistFailed ? `kayıt hatası: ${(persistFailed.details || {}).error_kind}` : 'beklenen satır yok');
    } else if (!expectPersist && row) {
      add(gameId, 'unexpected_row',
        `politika "${decided.reason_code}" diyor ama satır var (id ${row.id})`);
    } else if (expectPersist && row) {
      if (!persisted) add(gameId, 'persist_event_missing', 'satır var, match_persisted olayı yok');
      const rowWinner = row.winner_id === null ? 'draw'
        : row.winner_id === row.player_a ? 'A' : row.winner_id === row.player_b ? 'B' : 'other';
      if (Number(row.score_a) !== Number(result.score_a)
        || Number(row.score_b) !== Number(result.score_b)) {
        add(gameId, 'row_score_mismatch',
          `satır ${row.score_a}-${row.score_b}, olay ${result.score_a}-${result.score_b}`);
      }
      if (rowWinner !== (result.winner_seat || 'draw')) {
        add(gameId, 'row_winner_mismatch', `satır ${rowWinner}, olay ${result.winner_seat || 'draw'}`);
      }
    }
  }

  // (4) the other direction: a stored result with no events behind it.
  for (const row of matchRows) {
    if (!row.match_uid) {
      add(null, 'row_without_uid', `satır ${row.id} match_uid taşımıyor (ölçüm öncesi kayıt olabilir)`);
      continue;
    }
    if (!byGame.has(row.match_uid)) {
      add(row.match_uid, 'row_without_events', `satır ${row.id} için hiç ölçüm olayı yok; kanıt eksik`);
    }
  }

  return { findings, checked: byGame.size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.REPORT_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!url) {
    console.error('REPORT_DATABASE_URL (or DATABASE_URL) is required; the connection string is '
      + 'never taken from the command line.');
    process.exit(2);
  }
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    const events = (await client.query(
      `SELECT event_id, event_type, game_id, attempt_id, seat, source, reason_code, details,
              server_occurred_at
         FROM telemetry_events
        WHERE ($1::text IS NULL OR beta_cohort_id = $1)
          AND ($2::timestamptz IS NULL OR server_occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR server_occurred_at < $3)`,
      [args.cohort || null, args.from || null, args.to || null])).rows;
    const matchRows = (await client.query(
      `SELECT id, match_uid, player_a, player_b, score_a, score_b, winner_id, played_at
         FROM matches
        WHERE ($1::timestamptz IS NULL OR played_at >= $1)
          AND ($2::timestamptz IS NULL OR played_at < $2)`,
      [args.from || null, args.to || null])).rows;

    const { findings, checked } = reconcile({ events, matchRows });
    const asOf = new Date().toISOString();
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify({ asOf, checked, findings }, null, 2)}\n`);
    } else {
      process.stdout.write(`# Skor/kayıt uzlaştırması — ${asOf}\n\n`);
      process.stdout.write(`* incelenen maç: ${checked}\n* bulgu: ${findings.length}\n\n`);
      for (const f of findings) {
        process.stdout.write(`* [${f.kind}] ${f.gameId || '(maç kimliği yok)'} — ${f.detail}\n`);
      }
      if (!findings.length) process.stdout.write('Bulgu yok. Bu, yukarıdaki beş kontrol içindir; '
        + 'aynı yanlış değerin iki yere yazılması bu kontrolle görülmez.\n');
    }
    process.exit(findings.length ? 1 : 0);
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`check-match-integrity failed: ${err && err.stack}`);
    process.exit(2);
  });
}

module.exports = { reconcile, parseArgs };
