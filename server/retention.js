/**
 * Measurement retention (roadmap M1): raw events 30 days, stored reports 90.
 *
 * The data inventory promises these limits, and until this existed nothing
 * enforced them — which is why measurement stayed switched off. Two rules
 * decide what this may touch:
 *
 *   - Only the two measurement tables. Accounts, sessions and match history have
 *     their own rules and are never read or written here; the tests check that
 *     they are untouched after a purge.
 *   - Age is measured from when the server says the thing happened
 *     (server_occurred_at) for events, and from when the report was stored
 *     (created_at) for reports. Strictly older than the cutoff is deleted; a row
 *     exactly at the cutoff stays.
 *
 * Deletion runs in bounded batches so a large backlog never holds one long lock
 * over the table the game is writing to.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_EVENT_DAYS = 30;
const REPORT_DAYS = 90;

function cutoffs(now, { rawDays = RAW_EVENT_DAYS, reportDays = REPORT_DAYS } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('retention needs a valid "now"');
  }
  // A misconfigured zero or negative window would delete everything, including
  // what was written a second ago. Refuse instead of guessing.
  if (!(rawDays >= 1) || !(reportDays >= 1)) {
    throw new Error(`retention windows must be at least one day (raw ${rawDays}, reports ${reportDays})`);
  }
  return {
    events: new Date(now.getTime() - rawDays * DAY_MS),
    reports: new Date(now.getTime() - reportDays * DAY_MS),
  };
}

/**
 * Counts what a purge WOULD delete, without deleting anything.
 * @param {{query: Function}} db anything with pg's query(text, params)
 */
async function preview(db, now = new Date(), options = {}) {
  const cut = cutoffs(now, options);
  const events = await db.query(
    'SELECT count(*)::int AS n FROM telemetry_events WHERE server_occurred_at < $1', [cut.events]);
  const reports = await db.query(
    'SELECT count(*)::int AS n FROM telemetry_reports WHERE created_at < $1', [cut.reports]);
  return { cutoffs: cut, events: events.rows[0].n, reports: reports.rows[0].n };
}

/**
 * Deletes expired measurement rows. Returns how many of each were removed.
 *
 * @param {{query: Function}} db
 * @param {Date} now injected so tests can move the clock instead of waiting a
 *   month; the server passes the real time.
 */
async function purge(db, now = new Date(), { batchSize = 1000, ...options } = {}) {
  const cut = cutoffs(now, options);
  const removeInBatches = async (sql, cutoff) => {
    let total = 0;
    for (;;) {
      const result = await db.query(sql, [cutoff, batchSize]);
      total += result.rowCount;
      if (result.rowCount < batchSize) return total;
    }
  };
  const events = await removeInBatches(
    `DELETE FROM telemetry_events WHERE event_id IN (
       SELECT event_id FROM telemetry_events WHERE server_occurred_at < $1 LIMIT $2)`,
    cut.events);
  const reports = await removeInBatches(
    `DELETE FROM telemetry_reports WHERE id IN (
       SELECT id FROM telemetry_reports WHERE created_at < $1 LIMIT $2)`,
    cut.reports);
  return { cutoffs: cut, events, reports };
}

module.exports = { purge, preview, cutoffs, RAW_EVENT_DAYS, REPORT_DAYS, DAY_MS };
