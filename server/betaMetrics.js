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
 * Everything that can be wrong with one finished game, as findings.
 *
 * Two severities, and the difference decides the class:
 *   fault     the evidence CONTRADICTS a correct result — the game is F.
 *   evidence  the evidence is INCOMPLETE — the game is U, never C.
 *
 * @param {object[]} rows every event of ONE game
 * @param {{matchRow?: object, recordsChecked: boolean}} records the stored
 *   result for this game, and whether anyone actually read the table.
 * @returns {{kind: string, severity: 'fault'|'evidence', detail: string}[]}
 */
function gameFindings(rows, { matchRow, recordsChecked }) {
  const findings = [];
  const add = (kind, severity, detail) => findings.push({ kind, severity, detail });

  // A redelivered event is one event: the database already keeps one row per
  // event id, but a caller may hand over the same row twice.
  const seen = new Set();
  const unique = rows.filter((r) => (seen.has(r.event_id) ? false : seen.add(r.event_id)));

  const finished = unique.filter((r) => r.event_type === 'game_finished');
  if (!finished.length) return findings;
  if (finished.length > 1) {
    const distinct = new Set(finished.map((f) => JSON.stringify([
      (f.details || {}).score_a, (f.details || {}).score_b, (f.details || {}).winner_seat])));
    add(distinct.size > 1 ? 'conflicting_results' : 'duplicate_result', 'fault',
      `${finished.length} game_finished olayı, ${distinct.size} farklı sonuç`);
  }
  const result = finished[0].details || {};

  // One attempt, one scoring — whichever seat. The game resolves an attempt
  // once (playerGuessResolved), so a second round_scored for the same attempt
  // is a contradiction even when it names the OTHER seat. The first version
  // keyed this check on attempt AND seat, so A +3 and B +3 on the same attempt
  // looked like two different rounds, added up to 3-3, and passed.
  const scored = unique.filter((r) => r.event_type === 'round_scored');
  const byAttempt = new Map();
  for (const row of scored) {
    if (!Number.isInteger(row.attempt_id)) {
      add('attempt_missing', 'evidence', `puan olayı ${row.event_id} bir denemeye bağlı değil`);
      continue;
    }
    if (!byAttempt.has(row.attempt_id)) byAttempt.set(row.attempt_id, []);
    byAttempt.get(row.attempt_id).push(row);
  }
  const totals = { A: 0, B: 0 };
  for (const [attempt, list] of byAttempt) {
    if (list.length > 1) {
      const seats = list.map((r) => (r.details && r.details.scored_seat) || r.seat).join('+');
      add('attempt_scored_twice', 'fault', `deneme ${attempt} ${list.length} kez puanlandı (${seats})`);
    }
    for (const row of list) {
      const seat = (row.details && row.details.scored_seat) || row.seat;
      const points = Number((row.details && row.details.points) || 0);
      if (seat === 'A' || seat === 'B') totals[seat] += points;
    }
  }
  if (Number(result.score_a) !== totals.A || Number(result.score_b) !== totals.B) {
    add('score_mismatch', 'fault', `turlar ${totals.A}-${totals.B}, sonuç ${result.score_a}-${result.score_b}`);
  }
  const derivedWinner = totals.A === totals.B ? 'draw' : (totals.A > totals.B ? 'A' : 'B');
  if ((result.winner_seat || 'draw') !== derivedWinner) {
    add('winner_mismatch', 'fault', `skordan türeyen ${derivedWinner}, olaydaki ${result.winner_seat || 'draw'}`);
  }

  // The recording: what the policy decided, and what is actually stored.
  const decided = unique.find((r) => r.event_type === 'recording_decided');
  const persisted = unique.find((r) => r.event_type === 'match_persisted');
  const persistFailed = unique.find((r) => r.event_type === 'match_persist_failed');
  if (!decided) {
    add('recording_decision_missing', 'evidence', 'kayıt kararı olayı yok');
    return findings;
  }
  const expectPersist = (decided.details || {}).decision === 'persist';
  if (!recordsChecked) {
    // Not "fine": unverified. A match_persisted event says the server THOUGHT
    // it wrote the row; only the table says it is there.
    add('records_unverified', 'evidence', 'matches tablosu okunmadı; kayıt doğrulanamadı');
    return findings;
  }
  if (expectPersist && !matchRow) {
    add(persistFailed ? 'persist_failed' : 'row_missing', 'fault',
      persistFailed ? `kayıt hatası: ${(persistFailed.details || {}).error_kind}` : 'beklenen satır yok');
  } else if (!expectPersist && matchRow) {
    add('unexpected_row', 'fault', `politika "${decided.reason_code}" diyor ama satır var (id ${matchRow.id})`);
  } else if (expectPersist && matchRow) {
    if (!persisted) add('persist_event_missing', 'evidence', 'satır var, match_persisted olayı yok');
    const rowWinner = matchRow.winner_id === null || matchRow.winner_id === undefined ? 'draw'
      : matchRow.winner_id === matchRow.player_a ? 'A'
        : matchRow.winner_id === matchRow.player_b ? 'B' : 'other';
    if (Number(matchRow.score_a) !== Number(result.score_a)
      || Number(matchRow.score_b) !== Number(result.score_b)) {
      add('row_score_mismatch', 'fault',
        `satır ${matchRow.score_a}-${matchRow.score_b}, olay ${result.score_a}-${result.score_b}`);
    }
    if (rowWinner !== (result.winner_seat || 'draw')) {
      add('row_winner_mismatch', 'fault', `satır ${rowWinner}, olay ${result.winner_seat || 'draw'}`);
    }
  }
  return findings;
}

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
function classifyGames(events, { liveProcesses = new Set(), matchRows } = {}) {
  // The stored results, read by the caller for exactly the games being
  // classified. `undefined` means NOBODY LOOKED — and then no finished game can
  // be C, because C includes "the row the policy called for is there". The first
  // version decided that from the match_persisted EVENT alone and never read the
  // table: with every row missing, the report said PASS with C=100.
  const recordsChecked = Array.isArray(matchRows);
  const rowsByUid = new Map((matchRows || []).map((row) => [row.match_uid, row]));
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
    const rendered = new Set(rows.filter((r) => r.event_type === 'result_rendered' && r.source === 'client')
      .map((r) => r.seat).filter(Boolean));
    const disconnects = rows.filter((r) => r.event_type === 'disconnect_observed');
    const errors = rows.filter((r) => r.event_type.endsWith('_error'));

    const evidence = {
      seatsRendered: [...rendered].sort(),
      rounds: rows.filter((r) => r.event_type === 'round_scored').length,
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

    // Finished. Every consistency check lives in gameFindings(), which the
    // reconciliation command runs too — one definition, so the report cannot
    // call a game complete that reconciliation would flag.
    const findings = gameFindings(rows, { matchRow: rowsByUid.get(gameId), recordsChecked });
    const bothRendered = rendered.has('A') && rendered.has('B');
    evidence.findings = findings.map((f) => f.kind);

    const fault = findings.find((f) => f.severity === 'fault');
    if (fault) {
      out.set(gameId, { klass: 'F', reason: fault.kind, evidence });
      continue;
    }
    if (!bothRendered) {
      // The server finished the game; that is not the same as both players
      // having seen it. Missing a screen notice leaves the game unproven rather
      // than complete — "gameOver was emitted" is not evidence of delivery.
      out.set(gameId, { klass: 'U', reason: 'result_screen_unconfirmed', evidence });
      continue;
    }
    const missing = findings.find((f) => f.severity === 'evidence');
    if (missing) {
      out.set(gameId, { klass: 'U', reason: missing.kind, evidence });
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

/**
 * Disconnections and what became of them, counted per EPISODE (roadmap M5).
 *
 * An episode starts with a disconnect_observed event, whose own event id is the
 * episode id. Everything after it names that id. Three rules keep the count
 * honest:
 *   - a replayed or duplicated recovery_finished for the same episode counts
 *     once; two DIFFERENT outcomes for one episode are a contradiction and are
 *     reported, not averaged;
 *   - "recovered" is split by whether the player's screen then showed the
 *     CURRENT phase (a phase_rendered naming the episode). The server only
 *     accepts that notice for the attempt the room is on, so a screen still
 *     showing an older round never confirms a recovery;
 *   - an episode with no outcome at all is "unresolved", never success.
 */
function recoverySummary(events) {
  const seen = new Set();
  const unique = events.filter((e) => (seen.has(e.event_id) ? false : seen.add(e.event_id)));
  const episodes = new Map();
  const episode = (id) => {
    if (!episodes.has(id)) episodes.set(id, { outcomes: new Set(), rendered: false, observed: false });
    return episodes.get(id);
  };
  for (const e of unique) {
    if (e.event_type === 'disconnect_observed') episode(e.event_id).observed = true;
    const id = e.details && e.details.episode_id;
    if (!id) continue;
    if (e.event_type === 'recovery_finished') episode(id).outcomes.add(e.reason_code || 'unknown');
    if (e.event_type === 'phase_rendered') episode(id).rendered = true;
  }
  const out = {
    episodes: 0, recoveredVisible: 0, recoveredNotConfirmed: 0, windowExpired: 0,
    roomGone: 0, unresolved: 0, contradictory: 0,
  };
  for (const ep of episodes.values()) {
    if (!ep.observed) continue; // an outcome whose disconnection is outside this set
    out.episodes += 1;
    if (ep.outcomes.size > 1) { out.contradictory += 1; continue; }
    const [outcome] = [...ep.outcomes];
    if (!outcome) out.unresolved += 1;
    else if (outcome === 'recovered') out[ep.rendered ? 'recoveredVisible' : 'recoveredNotConfirmed'] += 1;
    else if (outcome === 'window_expired') out.windowExpired += 1;
    else if (outcome === 'room_gone') out.roomGone += 1;
    else out.unresolved += 1;
  }
  return out;
}

module.exports = {
  classifyGames, gameFindings, summarise, verdict, recoverySummary, CLASSES, FINAL_TYPES, TECHNICAL_ABORTS,
};
