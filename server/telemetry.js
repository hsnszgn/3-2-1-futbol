/**
 * Measurement events (roadmap M1–M3).
 *
 * What this is for: answering "did this game actually finish, on both screens,
 * and was the result written where it belongs?" with stored evidence rather than
 * with a console log that nobody kept. The beta gate is a ratio over real games,
 * and a ratio needs a denominator that survives a restart.
 *
 * Three rules shape the whole module, all three learned the hard way in this
 * codebase:
 *
 *  1. Recording must never change the game. `record()` returns nothing, awaits
 *     nothing and throws nothing: it validates, stamps, queues, and returns. The
 *     scoring path already had two bugs caused by an `await` inserted into it
 *     (an arrival time read after a wait, a finished game's id read after a
 *     wait), so no new wait is added there — not even a fast one.
 *
 *  2. A dropped event must be visible. A queue that silently discards is worse
 *     than no measurement, because the report then reads as success. Overflow,
 *     write failure and retry exhaustion all mark the process degraded and are
 *     counted; the report refuses to say PASS while that is set.
 *
 *  3. The event is the server's own account of what it did. `traffic_kind`,
 *     `environment` and the cohort come from server configuration only — a
 *     client cannot label itself a real beta participant — and client-sent
 *     notices are stored with `source = 'client'`, never as proof of server
 *     behaviour.
 *
 * Nothing here is a security boundary on its own: the caller still decides what
 * it hands over. What this module guarantees is that only allow-listed fields
 * per event type are stored, so a payload that grows a new field later cannot
 * quietly start writing it to the measurement table.
 */

const { randomUUID } = require('crypto');
const db = require('./db');

const SCHEMA_VERSION = 1;

// The event types the server may write, with the detail fields each one is
// allowed to carry. Anything not listed is dropped before the row is built —
// including, deliberately, every field that could hold a token, a password, an
// Authorization header, a connection string, an IP or a raw answer.
const EVENTS = {
  game_started: ['mode', 'max_rounds', 'rematch_of'],
  round_scored: ['round', 'points', 'scored_seat', 'elapsed_ms', 'outcome'],
  // A round that nobody could win. It is not a scored round and must not
  // count as one, but it is also not a fault — the report needs to tell the
  // two apart, so it gets its own type rather than a zero-point score.
  round_voided: ['round'],
  game_finished: ['score_a', 'score_b', 'winner_seat', 'rounds_played'],
  game_aborted: ['round', 'rounds_played'],
  recording_decided: ['decision', 'policy'],
  match_persisted: ['match_uid'],
  match_persist_failed: ['match_uid', 'error_kind'],
  disconnect_observed: ['episode_id', 'phase', 'round'],
  recovery_finished: ['episode_id', 'outcome', 'phase', 'round', 'away_ms'],
  phase_rendered: ['phase', 'round', 'remaining_ms'],
  result_rendered: ['round', 'rounds_played'],
  client_error: ['error_kind', 'phase'],
  server_error: ['error_kind', 'where'],
  dependency_error: ['dependency', 'error_kind'],
  process_started: ['node_version'],
  process_stopping: ['signal', 'pending_events'],
  telemetry_degraded: ['fault', 'dropped', 'queued'],
  // Written by the queue itself, never by a caller: the same event id arriving
  // twice with DIFFERENT content is a contradiction, and the spec is explicit
  // that it must be reported rather than dropped.
  telemetry_conflict: ['conflicts_with', 'event_type'],
};

// Every reason code the server may stamp, grouped by the event it belongs to.
// A free-text reason would make the report's own categories unverifiable, and
// "unknown" must stay distinguishable from "deliberately left".
const REASONS = {
  round_voided: ['timeout_team', 'same_team', 'no_common_players', 'timeout_guess'],
  game_aborted: ['opponent_left', 'left', 'recovery_expired', 'room_gone',
    'server_error', 'shutdown', 'unknown'],
  recording_decided: ['both_signed_in', 'guest_seat', 'session_revoked',
    'accounts_unavailable', 'not_applicable'],
  recovery_finished: ['recovered', 'new_connection', 'window_expired', 'room_gone'],
  disconnect_observed: ['transport_close', 'transport_error', 'client_namespace_disconnect',
    'server_namespace_disconnect', 'ping_timeout', 'unknown'],
};

// Lookups into the two tables above go through this, never through `EVENTS[type]`
// directly: a plain object answers for keys it inherits, so `EVENTS.toString`
// is a function, `record('toString')` passed the "is this an event" check, and
// iterating that function's "allowed fields" threw into the caller.
const own = (table, key) => (typeof key === 'string'
  && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null);

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const SEATS = new Set(['A', 'B']);
const SOURCES = new Set(['server', 'client']);
const ENVIRONMENTS = new Set(['staging', 'beta', 'production', 'test']);
const TRAFFIC_KINDS = new Set(['human_beta', 'automated', 'manual_qa']);

const MAX_QUEUE = Number(process.env.TELEMETRY_MAX_QUEUE || 500);
const MAX_ATTEMPTS = Number(process.env.TELEMETRY_MAX_ATTEMPTS || 4);
const RETRY_BASE_MS = Number(process.env.TELEMETRY_RETRY_BASE_MS || 200);
const WRITE_TIMEOUT_MS = Number(process.env.TELEMETRY_WRITE_TIMEOUT_MS || 5000);

// One id per running process, so a report can tell "no final event because the
// process died" from "no final event because the game is still being played".
const PROCESS_INSTANCE_ID = randomUUID();

function readEnvironment(env) {
  const raw = (env.TELEMETRY_ENVIRONMENT || env.ENVIRONMENT || '').trim().toLowerCase();
  if (ENVIRONMENTS.has(raw)) return raw;
  // No guessing from NODE_ENV: "production" there means "not a dev build", which
  // is not the same question. An unlabelled deployment is staging, the weakest
  // claim, and the report shows it as such.
  return 'staging';
}

function readTrafficKind(env) {
  const raw = (env.TELEMETRY_TRAFFIC_KIND || '').trim().toLowerCase();
  if (TRAFFIC_KINDS.has(raw)) return raw;
  // Automated until a human cohort is configured on the SERVER. This is the
  // whole defence of H: a test run that forgets to set anything must not be
  // counted as real beta play.
  return 'automated';
}

const state = {
  environment: readEnvironment(process.env),
  trafficKind: readTrafficKind(process.env),
  cohortId: (process.env.TELEMETRY_COHORT_ID || '').trim() || null,
  releaseSha: (process.env.RELEASE_SHA || process.env.RENDER_GIT_COMMIT || '').trim() || null,
  queue: [],
  draining: false,
  dropped: 0,
  invalid: 0,
  written: 0,
  failed: 0,
  degraded: null, // the fault that degraded it, or null
  // Set while a shutdown flush is running, so a late event does not restart the
  // drain loop after the pool has been told to close.
  closing: false,
};

// Two different questions, and conflating them is how a broken database reads
// as "measurement is switched off":
//   configured — a DATABASE_URL exists, so events are SUPPOSED to be stored;
//   writable   — the schema is in place, so they can be.
// No connection string at all is a deployment without measurement, which is a
// stated state, not a fault. Configured but not writable IS a fault.
//
// And above both: measurement is OFF unless TELEMETRY_ENABLED=1. The roadmap is
// explicit that these events are not collected until they are in the data
// inventory with a retention rule, and the retention job does not exist yet.
// Without this switch, merging the code would have started writing events on
// every deployment with a database — production included — the moment it
// deployed. Off, record() still validates (so a wrong call is still caught in
// development and in tests) but stores and queues nothing.
const enabledByConfig = () => process.env.TELEMETRY_ENABLED === '1';
const isConfigured = () => enabledByConfig() && db.isEnabled();
const isEnabled = () => enabledByConfig() && db.isReady();
const health = () => ({
  enabled: enabledByConfig(),
  environment: state.environment,
  trafficKind: state.trafficKind,
  cohortId: state.cohortId,
  releaseSha: state.releaseSha,
  processInstanceId: PROCESS_INSTANCE_ID,
  queued: state.queue.length,
  written: state.written,
  dropped: state.dropped,
  invalid: state.invalid,
  failed: state.failed,
  degraded: state.degraded,
});

/**
 * Marks the process's measurement as untrustworthy and says why.
 *
 * Deliberately one-way within a process: a report must not be able to read
 * "fine now" over a window in which events were lost. Clearing it is a new
 * process's job, and the gap stays visible in the stored events.
 */
function degrade(fault, extra = {}) {
  const first = !state.degraded;
  state.degraded = fault;
  if (!first) return;
  // Queued like any other event, and if THAT write is what is broken the
  // counters in health() and the external process check are what remain. A
  // telemetry table cannot be relied on to report that it is unwritable.
  enqueue(build('telemetry_degraded', {
    source: 'server',
    details: { fault, dropped: state.dropped, queued: state.queue.length, ...extra },
  }));
}

/**
 * The allowed detail fields for this event type, validated.
 *
 * Two different things, handled differently on purpose:
 *   - a key that is not in the contract is DROPPED. That is the allow-list: a
 *     caller that hands over a whole payload stores only what the contract
 *     names, and the tokens and answers in it never reach the table.
 *   - a key that IS in the contract but carries something that is not a plain
 *     scalar makes the whole event INVALID. Silently dropping it would store an
 *     event that looks complete and is not; an object there is how a socket
 *     payload would end up in the table; and a BigInt or a Symbol would throw
 *     later, inside JSON.stringify, on the way to the database.
 *
 * @returns {{ok: true, details: object} | {ok: false, error: string}}
 */
function validDetails(allowed, details) {
  if (details === undefined || details === null) return { ok: true, details: {} };
  if (!isPlainObject(details)) return { ok: false, error: 'details_not_an_object' };
  const out = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
    const value = details[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      out[key] = value.slice(0, 200);
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      // NaN and Infinity serialise to null: a score of NaN would be stored as
      // "no score" and read back as nothing wrong.
      if (!Number.isFinite(value)) return { ok: false, error: `details.${key}_not_finite` };
      out[key] = value;
    } else {
      return { ok: false, error: `details.${key}_not_a_scalar` };
    }
  }
  return { ok: true, details: out };
}

const optionalString = (value, max = 200) => value === undefined || value === null
  || (typeof value === 'string' && value.length > 0 && value.length <= max);

/**
 * Builds a row, or explains why not.
 *
 * Every field is checked explicitly — the shape of `fields`, each identifier,
 * the seat, the source, the reason code, the timestamp and the details — so
 * that nothing past this point can throw on the way to the database. This is
 * validation, not a catch-all: a check that is missing here is a bug to fix,
 * not something to be swallowed further down.
 *
 * @returns {{row: object} | {error: string}}
 */
function validate(type, fields) {
  const allowed = own(EVENTS, type);
  if (!allowed) return { error: 'unknown_event_type' };
  if (fields === undefined || fields === null) fields = {};
  if (!isPlainObject(fields)) return { error: 'fields_not_an_object' };
  const {
    eventId, gameId, attemptId, seat, source = 'server',
    reasonCode = null, occurredAt = null, trafficKind = null, details,
  } = fields;

  if (!optionalString(eventId)) return { error: 'bad_event_id' };
  if (!optionalString(gameId)) return { error: 'bad_game_id' };
  if (attemptId !== undefined && attemptId !== null && !Number.isSafeInteger(attemptId)) {
    return { error: 'bad_attempt_id' };
  }
  if (seat !== undefined && seat !== null && !SEATS.has(seat)) return { error: 'bad_seat' };
  if (!SOURCES.has(source)) return { error: 'bad_source' };
  if (reasonCode !== null && reasonCode !== undefined) {
    const reasons = own(REASONS, type);
    if (!reasons || !reasons.includes(reasonCode)) return { error: 'bad_reason_code' };
  }
  if (occurredAt !== null && occurredAt !== undefined
    && !(occurredAt instanceof Date && Number.isFinite(occurredAt.getTime()))) {
    return { error: 'bad_occurred_at' };
  }
  const checked = validDetails(allowed, details);
  if (!checked.ok) return { error: checked.error };

  // The kind of traffic is a server decision, and it can only ever be WEAKENED
  // here: a caller may say "this one is automated" (a controlled disconnect
  // inside a beta deployment is not a human game), but nothing a caller passes
  // can make an event count as human_beta. That claim comes from server
  // configuration alone — it is the entire defence of H, and a client notice
  // asking for it would otherwise inflate the denominator of the beta gate.
  const WEAKER = new Set(['automated', 'manual_qa']);
  const kind = typeof trafficKind === 'string' && WEAKER.has(trafficKind) ? trafficKind : state.trafficKind;
  return {
    row: {
      eventId: eventId || randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      type,
      gameId: gameId || null,
      attemptId: Number.isSafeInteger(attemptId) ? attemptId : null,
      seat: seat || null,
      // The server's clock, taken now — not the client's, and not the time the
      // row happens to reach the database. Queue lag must not move an event.
      occurredAt: occurredAt || new Date(),
      environment: state.environment,
      trafficKind: kind,
      cohortId: state.cohortId,
      releaseSha: state.releaseSha,
      processInstanceId: PROCESS_INSTANCE_ID,
      source,
      reasonCode: reasonCode || null,
      details: checked.details,
      attempts: 0,
    },
  };
}

/** For the module's own events, which are built from literals and cannot fail. */
function build(type, fields) {
  const result = validate(type, fields);
  return result.row || null;
}

/** Counts a refused event and marks the measurement as suspect. Never throws. */
function refuse(type, error) {
  state.dropped += 1;
  state.invalid += 1;
  state.degraded = state.degraded || 'invalid_event';
  console.error(`telemetry: refusing ${typeof type === 'string' ? type.slice(0, 40) : typeof type} event: ${error}`);
}

function enqueue(row) {
  if (!row) return null;
  // Switched off: nothing is kept, not even in memory. Not a drop and not a
  // fault — it is the configured state.
  if (!enabledByConfig()) return null;
  if (state.queue.length >= MAX_QUEUE) {
    state.dropped += 1;
    // Not a recursive degrade(): that would enqueue on a full queue.
    state.degraded = state.degraded || 'queue_overflow';
    return null;
  }
  state.queue.push(row);
  drain();
  return row;
}

const INSERT = `
  INSERT INTO telemetry_events (
    event_id, schema_version, event_type, game_id, attempt_id, seat,
    server_occurred_at, environment, traffic_kind, beta_cohort_id,
    release_sha, process_instance_id, source, reason_code, details
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id
`;

function params(row) {
  return [row.eventId, row.schemaVersion, row.type, row.gameId, row.attemptId, row.seat,
    row.occurredAt.toISOString(), row.environment, row.trafficKind, row.cohortId,
    row.releaseSha, row.processInstanceId, row.source, row.reasonCode,
    JSON.stringify(row.details)];
}

/**
 * Writes one row. Redelivery of the same event is a no-op; redelivery of the
 * same id with DIFFERENT content is a contradiction and is reported.
 */
async function writeRow(row) {
  const inserted = await db.query(INSERT, params(row));
  if (inserted.rowCount === 1) return;
  // ON CONFLICT DO NOTHING happened: the id is already stored. Idempotent
  // redelivery is the normal case and must not be reported as anything; the
  // interesting case is the same id carrying something else.
  //
  // The comparison is done BY THE DATABASE, as jsonb equality. The first version
  // compared JSON.stringify of the stored details with the new ones, but jsonb
  // does not keep key order — a round_scored written as
  // {round, points, scored_seat, elapsed_ms, outcome} comes back as
  // {round, points, outcome, elapsed_ms, scored_seat} — so an IDENTICAL
  // redelivery, the most ordinary thing a queue does, was reported as a
  // contradiction and degraded the whole process. jsonb `=` is defined on
  // content, not on spelling.
  const existing = await db.query(
    `SELECT (event_type = $2
             AND game_id IS NOT DISTINCT FROM $3
             AND attempt_id IS NOT DISTINCT FROM $4
             AND seat IS NOT DISTINCT FROM $5
             AND source = $6
             AND reason_code IS NOT DISTINCT FROM $7
             AND details = $8::jsonb) AS same
       FROM telemetry_events WHERE event_id = $1`,
    [row.eventId, row.type, row.gameId, row.attemptId, row.seat, row.source,
      row.reasonCode, JSON.stringify(row.details)]);
  const prev = existing.rows[0];
  if (!prev) return; // deleted between the two statements; nothing to compare
  if (prev.same) return;
  await db.query(INSERT, params({
    ...build('telemetry_conflict', {
      gameId: row.gameId,
      attemptId: row.attemptId,
      details: { conflicts_with: row.eventId, event_type: row.type },
    }),
  }));
  degrade('event_id_conflict');
}

async function drain() {
  if (state.draining || state.closing) return;
  if (!state.queue.length) return;
  // Not configured: there is nowhere to write and nothing is wrong. The events
  // stay queued in case a later migration makes the database usable.
  if (!isConfigured()) return;
  // Configured but the schema is not in place yet. Try anyway: the error is
  // real evidence, and the retry budget below decides when to give up. The
  // alternative — returning quietly — is exactly the silence this module exists
  // to prevent.
  if (!isEnabled() && !state.queue.length) return;
  state.draining = true;
  try {
    while (state.queue.length && !state.closing) {
      const row = state.queue[0];
      try {
        await withTimeout(writeRow(row), WRITE_TIMEOUT_MS);
        state.queue.shift();
        state.written += 1;
      } catch (err) {
        row.attempts += 1;
        if (row.attempts >= MAX_ATTEMPTS) {
          state.queue.shift();
          state.failed += 1;
          // Set directly rather than through degrade(): that would enqueue an
          // event into the very queue whose writes are failing.
          state.degraded = state.degraded || 'write_failed';
          console.error(`telemetry: dropping ${row.type} after ${row.attempts} attempts: ${err.message}`);
          continue;
        }
        // Back off, then retry the SAME event id, so a retry cannot double-count.
        const wait = RETRY_BASE_MS * (2 ** (row.attempts - 1));
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  } finally {
    state.draining = false;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`telemetry write timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Records an event. Fire-and-forget by design: see rule 1 at the top.
 *
 * @returns {string|null} the event id, for a caller that wants to relate a
 *   later event to this one (a disconnect episode, say). Never a promise.
 */
function record(type, fields) {
  const { row, error } = validate(type, fields);
  if (!row) {
    refuse(type, error);
    return null;
  }
  // The id only comes back if the event was actually accepted: a caller that
  // relates a later event to this one (a disconnect episode) must not be handed
  // an id that was dropped on a full queue.
  return enqueue(row) ? row.eventId : null;
}

/**
 * Records an event and resolves once it is durably stored.
 *
 * Used for exactly one thing (M3): a beta game's start must be in the database
 * before its rounds begin, so that a crash cannot leave the finished games
 * remembered and the unfinished ones missing from the denominator. It is on the
 * game-start path, never on the scoring path.
 *
 * @returns {Promise<boolean>} true when stored; false when it could not be, so
 *   the caller can refuse to start rather than play an unmeasured game.
 */
async function recordDurable(type, fields) {
  // A documented false, not a rejection: the caller refuses to start a game on
  // false, and an unexpected rejection would be an unhandled one in the game.
  const { row, error } = validate(type, fields);
  if (!row) {
    refuse(type, error);
    return false;
  }
  // Nowhere to write by configuration: say so plainly (the caller refuses to
  // start a measured game) without claiming the measurement broke.
  if (!isConfigured()) return false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await withTimeout(writeRow(row), WRITE_TIMEOUT_MS);
      state.written += 1;
      return true;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        state.failed += 1;
        state.degraded = state.degraded || 'write_failed';
        console.error(`telemetry: could not store ${type}: ${err.message}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * (2 ** (attempt - 1))));
    }
  }
  return false;
}

/**
 * Drains what is queued, with a deadline.
 *
 * A bounded flush on shutdown, not a promise of no loss: a process that is
 * killed outright loses whatever is still in memory, and the report finds those
 * games by their missing final event rather than by pretending they completed.
 */
async function flush(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (state.queue.length && Date.now() < deadline) {
    if (!state.draining) drain();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { flushed: state.queue.length === 0, remaining: state.queue.length };
}

/** Test seam: re-reads configuration and clears counters. Never called by the server. */
function _reset(env = process.env) {
  state.environment = readEnvironment(env);
  state.trafficKind = readTrafficKind(env);
  state.cohortId = (env.TELEMETRY_COHORT_ID || '').trim() || null;
  state.releaseSha = (env.RELEASE_SHA || env.RENDER_GIT_COMMIT || '').trim() || null;
  state.queue = [];
  state.draining = false;
  state.closing = false;
  state.dropped = 0;
  state.invalid = 0;
  state.written = 0;
  state.failed = 0;
  state.degraded = null;
}

module.exports = {
  record,
  recordDurable,
  flush,
  health,
  isEnabled,
  degrade,
  SCHEMA_VERSION,
  PROCESS_INSTANCE_ID,
  EVENTS,
  REASONS,
  _reset,
};
