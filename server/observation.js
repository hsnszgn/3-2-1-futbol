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

  const maxGap = 2 * heartbeatMs + graceMs;
  const at = (e) => new Date(e.server_occurred_at).getTime();
  const evidence = events
    .filter((e) => EVIDENCE_TYPES.has(e.event_type))
    .map(at)
    .filter((t) => t >= from.getTime() - maxGap && t < to.getTime())
    .sort((a, b) => a - b);

  const gaps = [];
  const gap = (a, b, reason) => gaps.push({
    from: new Date(a).toISOString(), to: new Date(b).toISOString(), reason,
  });

  if (!evidence.length) {
    gap(from.getTime(), to.getTime(), 'no_evidence');
    return result('GAP', gaps, 0);
  }
  let previous = from.getTime();
  // Evidence from just before the window counts as covering its start.
  const first = evidence[0];
  if (first - previous > maxGap) gap(previous, first, 'no_evidence');
  previous = Math.max(previous, first);
  for (const t of evidence) {
    if (t - previous > maxGap) gap(previous, t, 'no_evidence');
    previous = Math.max(previous, t);
  }
  if (to.getTime() - previous > maxGap) gap(previous, to.getTime(), 'no_evidence');

  // The measurement said itself that it could not be trusted.
  for (const e of events) {
    if (!FAULT_TYPES.has(e.event_type)) continue;
    const t = at(e);
    if (t >= from.getTime() && t < to.getTime()) gap(t, t, e.event_type);
  }

  const inWindow = evidence.filter((t) => t >= from.getTime()).length;
  return result(gaps.length ? 'GAP' : 'COVERED', gaps, inWindow);
}

module.exports = { observe, HOUR_MS };
