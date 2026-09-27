/**
 * Was the measurement actually watching? (roadmap M6: the 72-hour window)
 *
 * "72 hours without errors" is worthless if nothing was recording for part of
 * it: silence from a dead process looks exactly like silence from a healthy one.
 * So the window is judged by positive evidence — the server writes a
 * `telemetry_heartbeat` event at a fixed interval while measurement is on — and
 * every stretch longer than the allowed gap between two pieces of evidence is an
 * observation gap. A gap, a degraded-measurement event, or a window that is not
 * over yet can never produce "covered".
 *
 * Pure: it takes rows and returns a verdict, so it can be tested without a clock.
 */

const HOUR_MS = 60 * 60 * 1000;
const EVIDENCE_TYPES = new Set(['telemetry_heartbeat', 'process_started', 'process_stopping']);
const FAULT_TYPES = new Set(['telemetry_degraded', 'telemetry_conflict']);

/**
 * @param {object[]} events rows with event_type, server_occurred_at, details
 * @param {{from: Date, to: Date, now: Date, heartbeatMs: number, graceMs?: number}} options
 *   `heartbeatMs` is the interval the server was configured with; a gap is any
 *   stretch without evidence longer than two intervals plus `graceMs`.
 * @returns {{status: 'COVERED'|'GAP'|'INSUFFICIENT_DATA', windowHours: number,
 *            gaps: {from: string, to: string, reason: string}[], evidence: number}}
 */
function observe(events, { from, to, now, heartbeatMs, graceMs = 60 * 1000 }) {
  const windowHours = Math.round(((to - from) / HOUR_MS) * 100) / 100;
  const result = (status, gaps = [], evidence = 0, note = null) => ({
    status, windowHours, gaps, evidence, ...(note ? { note } : {}),
  });
  if (!(heartbeatMs > 0)) return result('INSUFFICIENT_DATA', [], 0, 'heartbeat interval unknown');
  // A window that has not finished yet cannot have been covered.
  if (to > now) return result('INSUFFICIENT_DATA', [], 0, 'window has not ended yet');

  // Each piece of evidence vouches for the time after it, up to two of ITS OWN
  // intervals plus grace. A heartbeat says which interval it was written at; a
  // lifecycle event uses the configured one. The first version took one interval
  // for the whole window — the LARGEST recorded — so a single process beating
  // hourly let every five-minute process go quiet for two hours unnoticed.
  //
  // And a beat can never vouch for LONGER than the interval the window is being
  // judged at: a process configured (or misconfigured) to beat hourly must not
  // cover for a five-minute one.
  const allowance = (e) => {
    const own = Number(e.details && e.details.interval_ms);
    return 2 * (own > 0 ? Math.min(own, heartbeatMs) : heartbeatMs) + graceMs;
  };
  const at = (e) => new Date(e.server_occurred_at).getTime();
  const lookBehind = 2 * heartbeatMs + graceMs;
  const evidence = events
    .filter((e) => EVIDENCE_TYPES.has(e.event_type))
    .map((e) => ({ t: at(e), allow: allowance(e) }))
    .filter((e) => e.t < to.getTime())
    .sort((a, b) => a.t - b.t);

  const gaps = [];
  const gap = (a, b, reason) => gaps.push({
    from: new Date(a).toISOString(), to: new Date(b).toISOString(), reason,
  });

  // Evidence from before the window counts for the window's start only as far
  // as its own allowance reaches.
  const before = evidence.filter((e) => e.t < from.getTime());
  const inside = evidence.filter((e) => e.t >= from.getTime());
  if (!before.length && !inside.length) {
    gap(from.getTime(), to.getTime(), 'no_evidence');
    return result('GAP', gaps, 0);
  }
  let coveredUntil = before.length
    ? Math.max(...before.map((e) => e.t + e.allow))
    : from.getTime() + lookBehind; // nothing before: allow one normal span to the first beat
  let lastAt = from.getTime();
  for (const e of inside) {
    if (e.t > coveredUntil) gap(lastAt, e.t, 'no_evidence');
    lastAt = e.t;
    coveredUntil = Math.max(coveredUntil, e.t + e.allow);
  }
  if (to.getTime() > coveredUntil) gap(lastAt, to.getTime(), 'no_evidence');
  const inWindowEvidence = inside.length;

  // The measurement said itself that it could not be trusted.
  for (const e of events) {
    if (!FAULT_TYPES.has(e.event_type)) continue;
    const t = at(e);
    if (t >= from.getTime() && t < to.getTime()) gap(t, t, e.event_type);
  }

  return result(gaps.length ? 'GAP' : 'COVERED', gaps, inWindowEvidence);
}

module.exports = { observe, HOUR_MS };
