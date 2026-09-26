/**
 * The beta numbers (roadmap M4), in one place.
 *
 * Both the report and its tests use these functions, so the definitions cannot
 * drift apart: a formula that lives in a script and a formula that lives in a
 * test are two formulas.
 *
 * The classes are the whole point, and they are mutually exclusive:
 *
 *   H = C + V + P + F + U
 *
 *   C  complete: the server produced a normal result, BOTH screens reported
 *      the result screen, the round scores add up to the final score, and the
 *      row the recording policy called for is actually there.
 *   V  voluntarily abandoned: an explicit leave that reached the server, with no
 *      technical fault or disconnection before it. A closed tab is not this.
 *   P  in progress: still being played, as far as the events can tell. Expected
 *      to be zero in a final assessment.
 *   F  failed: a technical end, or a consistency check that did not hold.
 *   U  unknown: missing evidence, or an end nobody can explain. Never counted as
 *      success and never quietly dropped from the denominator.
 *
 * What this module cannot do, stated here rather than discovered later: it reads
 * the server's own events. It cannot tell that the same wrong score was written
 * to both the event and the row, and it cannot tell a real human from a
 * well-configured script — only that the SERVER classified the traffic as human
 * beta. Both limits belong in the report's own output.
 */

/** Classes in the order the report prints them. */
const CLASSES = ['C', 'V', 'P', 'F', 'U'];

const FINAL_TYPES = new Set(['game_finished', 'game_aborted']);
const TECHNICAL_ABORTS = new Set(['recovery_expired', 'room_gone', 'server_error', 'shutdown']);

/**
 * Groups events by game and works out what happened to each one.
 *
 * @param {object[]} events rows from telemetry_events, any order
 * @param {object} context
 *   `liveProcesses` — process_instance_ids with no process_stopping event. A game
 *   whose process is still up and has no final event is being played; one whose
 *   process is gone is not, and must not be counted as anything but unknown.
 * @returns {Map<string, object>} game id → { klass, reason, evidence }
 */
function classifyGames(events, { liveProcesses = new Set() } = {}) {
  const byGame = new Map();
  for (const event of events) {
    if (!event.game_id) continue;
    if (!byGame.has(event.game_id)) byGame.set(event.game_id, []);
    byGame.get(event.game_id).push(event);
  }

  const out = new Map();
  for (const [gameId, rows] of byGame) {
    rows.sort((a, b) => new Date(a.server_occurred_at) - new Date(b.server_occurred_at));
    const started = rows.find((r) => r.event_type === 'game_started');
    if (!started) continue; // a game the window does not own; the caller filtered by start
    const finished = rows.find((r) => r.event_type === 'game_finished');
    const aborted = rows.find((r) => r.event_type === 'game_aborted');
    const scored = rows.filter((r) => r.event_type === 'round_scored');
    const rendered = new Set(rows.filter((r) => r.event_type === 'result_rendered' && r.source === 'client')
      .map((r) => r.seat).filter(Boolean));
    const decided = rows.find((r) => r.event_type === 'recording_decided');
    const persisted = rows.find((r) => r.event_type === 'match_persisted');
    const persistFailed = rows.find((r) => r.event_type === 'match_persist_failed');
    const disconnects = rows.filter((r) => r.event_type === 'disconnect_observed');
    const errors = rows.filter((r) => r.event_type.endsWith('_error'));

    const evidence = {
      seatsRendered: [...rendered].sort(),
      rounds: scored.length,
      disconnects: disconnects.length,
      errors: errors.length,
      processInstance: started.process_instance_id,
      trafficKind: started.traffic_kind,
      releaseSha: started.release_sha,
      startedAt: started.server_occurred_at,
    };

    // No ending at all.
    if (!finished && !aborted) {
      const live = liveProcesses.has(started.process_instance_id);
      out.set(gameId, {
        klass: live ? 'P' : 'U',
        reason: live ? 'in_progress' : 'no_final_event',
        evidence,
      });
      continue;
    }

    if (!finished && aborted) {
      const why = aborted.reason_code || 'unknown';
      if (why === 'left') {
        // A deliberate leave counts as V only if nothing technical happened
        // first. Otherwise the player may well have left BECAUSE it broke, and
        // calling that voluntary would improve the ratio by hiding a fault.
        const clean = disconnects.length === 0 && errors.length === 0;
        out.set(gameId, clean
          ? { klass: 'V', reason: 'explicit_leave', evidence }
          : { klass: 'U', reason: 'leave_after_fault', evidence });
        continue;
      }
      if (why === 'opponent_left') {
        // The other side's connection went away. Not a deliberate leave by the
        // player whose seat this is, and not proof of a technical fault either.
        out.set(gameId, { klass: 'U', reason: 'opponent_gone', evidence });
        continue;
      }
      out.set(gameId, {
        klass: TECHNICAL_ABORTS.has(why) ? 'F' : 'U',
        reason: `aborted_${why}`,
        evidence,
      });
      continue;
    }

    // Finished. Now the three checks that decide C.
    const details = finished.details || {};
    const totals = { A: 0, B: 0 };
    for (const row of scored) {
      const seat = (row.details && row.details.scored_seat) || row.seat;
      const points = Number((row.details && row.details.points) || 0);
      if (seat === 'A' || seat === 'B') totals[seat] += points;
    }
    const scoresAgree = Number(details.score_a) === totals.A && Number(details.score_b) === totals.B;
    const expectedWinner = totals.A === totals.B ? 'draw' : (totals.A > totals.B ? 'A' : 'B');
    const winnerAgrees = (details.winner_seat || 'draw') === expectedWinner;
    const bothRendered = rendered.has('A') && rendered.has('B');
    const persistExpected = decided ? (decided.details || {}).decision === 'persist' : false;
    const persistOk = persistExpected ? Boolean(persisted) && !persistFailed : !persistFailed;

    evidence.scoresAgree = scoresAgree;
    evidence.winnerAgrees = winnerAgrees;
    evidence.persistExpected = persistExpected;
    evidence.persistOk = persistOk;

    if (!scoresAgree || !winnerAgrees || !persistOk) {
      out.set(gameId, {
        klass: 'F',
        reason: !scoresAgree ? 'score_mismatch' : !winnerAgrees ? 'winner_mismatch' : 'persist_failed',
        evidence,
      });
      continue;
    }
    if (!bothRendered) {
      // The server finished the game; that is not the same as both players
      // having seen it. Missing a screen notice leaves the game unproven rather
      // than complete — "gameOver was emitted" is not evidence of delivery.
      out.set(gameId, { klass: 'U', reason: 'result_screen_unconfirmed', evidence });
      continue;
    }
    if (!decided) {
      out.set(gameId, { klass: 'U', reason: 'recording_decision_missing', evidence });
      continue;
    }
    out.set(gameId, { klass: 'C', reason: 'complete', evidence });
  }
  return out;
}

/**
 * The counts and the two ratios.
 *
 * A zero denominator is "could not be computed", never 100%: the whole reason
 * this is written down is that a report with no data must not read as a pass.
 */
function summarise(classified) {
  const counts = { C: 0, V: 0, P: 0, F: 0, U: 0 };
  const reasons = {};
  for (const { klass, reason } of classified.values()) {
    counts[klass] += 1;
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  const H = CLASSES.reduce((sum, k) => sum + counts[k], 0);
  const technicalDenominator = H - counts.V;
  const ratio = (numerator, denominator) => (denominator > 0
    ? Math.round((numerator / denominator) * 10000) / 100
    : null);
  return {
    H,
    counts,
    reasons,
    totalCompletionPct: ratio(counts.C, H),
    technicalCompletionPct: ratio(counts.C, technicalDenominator),
    technicalDenominator,
  };
}

/**
 * The report's verdict.
 *
 * Four outcomes, and only one of them is good:
 *   OBSERVABILITY_GAP  the measurement itself is in doubt — degraded events, or
 *                      a query that failed. Nothing about the game is claimed.
 *   INSUFFICIENT_DATA  not enough games, or games still in progress.
 *   FAIL               the thresholds were not met, or `U` is unexplained.
 *   PASS               thresholds met, and nothing above applies.
 *
 * PASS is a statement about these numbers only. It is not a release decision:
 * the security findings, the open-issue list and the operator's own judgement
 * sit outside this file, and the roadmap says so explicitly.
 */
function verdict(summary, {
  minGames = 100,
  minTechnicalPct = 98,
  degradedEvents = 0,
  queryFailed = false,
  unexplainedUnknown = null,
} = {}) {
  const notes = [];
  if (queryFailed) {
    notes.push('rapor sorgusu hata verdi');
    return { status: 'OBSERVABILITY_GAP', notes };
  }
  if (degradedEvents > 0) {
    notes.push(`${degradedEvents} ölçüm arıza olayı bu pencerede kayıtlı`);
    return { status: 'OBSERVABILITY_GAP', notes };
  }
  if (summary.H === 0) {
    notes.push('pencerede hiç insan maçı yok');
    return { status: 'INSUFFICIENT_DATA', notes };
  }
  if (summary.counts.P > 0) {
    notes.push(`${summary.counts.P} maç hâlâ devam ediyor (nihai değerlendirmede P=0 olmalı)`);
    return { status: 'INSUFFICIENT_DATA', notes };
  }
  if (summary.H < minGames) {
    notes.push(`${summary.H} maç, gereken ${minGames}`);
    return { status: 'INSUFFICIENT_DATA', notes };
  }
  const unknown = unexplainedUnknown === null ? summary.counts.U : unexplainedUnknown;
  if (unknown > 0) {
    notes.push(`${unknown} maç açıklanmamış şekilde belirsiz (U)`);
    return { status: 'FAIL', notes };
  }
  if (summary.technicalCompletionPct === null) {
    notes.push('teknik tamamlanma paydası sıfır');
    return { status: 'INSUFFICIENT_DATA', notes };
  }
  if (summary.technicalCompletionPct < minTechnicalPct) {
    notes.push(`teknik tamamlanma %${summary.technicalCompletionPct}, eşik %${minTechnicalPct}`);
    return { status: 'FAIL', notes };
  }
  notes.push(`teknik tamamlanma %${summary.technicalCompletionPct}, ${summary.H} maç`);
  return { status: 'PASS', notes };
}

module.exports = { classifyGames, summarise, verdict, CLASSES, FINAL_TYPES, TECHNICAL_ABORTS };
