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
const { gameFindings } = require('../server/betaMetrics');
const { collect, clientConfig, scopeFromArgs } = require('./beta-report');

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
 * @param {{events: object[], matchRows: object[], outOfSetRows?: object[]}} input
 *   `events` and `matchRows` belong to the SAME game set (selected by start
 *   event, exactly as the report selects it). `outOfSetRows` are stored results
 *   in the date window that are NOT in that set — the reverse direction, kept
 *   separate and labelled, so two different windows are never compared as one.
 * @returns {{findings: object[], checked: number}} one finding per problem, each
 *   naming the game it belongs to so it can be looked up.
 */
function reconcile({ events, matchRows, outOfSetRows = [] }) {
  const byGame = new Map();
  for (const event of events) {
    if (!event.game_id) continue;
    if (!byGame.has(event.game_id)) byGame.set(event.game_id, []);
    byGame.get(event.game_id).push(event);
  }
  const rowsByUid = new Map(matchRows.map((row) => [row.match_uid, row]));
  const findings = [];

  // (1)-(3) and (5): the same function the report classifies with, so the two
  // cannot disagree about a game.
  for (const [gameId, rows] of byGame) {
    for (const f of gameFindings(rows, { matchRow: rowsByUid.get(gameId), recordsChecked: true })) {
      findings.push({ gameId, kind: f.kind, severity: f.severity, detail: f.detail });
    }
  }

  // (4) the other direction: a stored result with no events behind it.
  for (const row of [...matchRows, ...outOfSetRows]) {
    if (!row.match_uid) {
      findings.push({ gameId: null, kind: 'row_without_uid', severity: 'evidence',
        detail: `satır ${row.id} match_uid taşımıyor (ölçüm öncesi kayıt olabilir)` });
      continue;
    }
    if (!byGame.has(row.match_uid)) {
      findings.push({ gameId: row.match_uid, kind: 'row_without_events', severity: 'evidence',
        detail: `satır ${row.id} için bu kapsamda ölçüm olayı yok; kanıt eksik` });
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
  // The server's own TLS policy (server/dbTls.js), not a local copy of an older
  // rule: an ambiguous address is refused rather than connected to.
  let config;
  try {
    config = clientConfig(url);
  } catch (err) {
    console.error(`refusing to connect: ${err.message}`);
    process.exit(2);
  }
  const client = new Client(config);
  await client.connect();
  try {
    // The same game set the report uses: selected by START event, same filters.
    const scope = scopeFromArgs(args);
    const data = await collect(client, scope);
    // Reverse direction, labelled: rows played in the window whose game is not
    // in the set. Different question, so a different, named query.
    const outOfSetRows = (await client.query(
      `SELECT id, match_uid, player_a, player_b, score_a, score_b, winner_id, played_at
         FROM matches
        WHERE ($1::timestamptz IS NULL OR played_at >= $1)
          AND ($2::timestamptz IS NULL OR played_at < $2)
          AND (match_uid IS NULL OR NOT (match_uid = ANY($3)))`,
      [scope.from, scope.to, data.gameIds])).rows;

    const { findings, checked } = reconcile({ events: data.events, matchRows: data.matchRows, outOfSetRows });
    const asOf = new Date().toISOString();
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify({ asOf, checked, findings }, null, 2)}\n`);
    } else {
      process.stdout.write(`# Skor/kayıt uzlaştırması — ${asOf}\n\n`);
      process.stdout.write(`* incelenen maç: ${checked}\n* bulgu: ${findings.length}\n\n`);
      for (const f of findings) {
        process.stdout.write(`* [${f.kind}] ${f.gameId || '(maç kimliği yok)'} — ${f.detail}\n`);
      }
      if (!findings.length) process.stdout.write('Bulgu yok. Bu, yukarıdaki kontroller içindir; '
        + 'aynı yanlış değerin iki yere yazılması bu kontrolle görülmez.\n');
    }
    process.exitCode = findings.length ? 1 : 0;
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
