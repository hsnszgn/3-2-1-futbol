/**
 * The beta monitor (roadmap M6): heartbeat, alerts and the daily report, run by
 * the server on its own schedule while measurement is switched on.
 *
 *   heartbeat  every TELEMETRY_HEARTBEAT_MS (default 5 min): positive evidence
 *              that the measurement was running. The 72-hour window is judged
 *              by these — silence is a gap, not a pass.
 *   alerts     every BETA_ALERT_INTERVAL_MS (default 5 min): inconsistencies,
 *              crashes and measurement loss, delivered immediately.
 *   report     every BETA_REPORT_INTERVAL_MS (default 24 h): the last day's
 *              report, stored in telemetry_reports (90-day retention). A report
 *              that cannot be computed is stored as OBSERVABILITY_GAP and raises
 *              an alert; it is never skipped silently.
 *
 * Every step is independent and failure-contained: one failing check must not
 * stop the others, and none of this may throw into the game.
 *
 * Known limit, stated rather than discovered: this runs inside the game server.
 * A host that puts idle services to sleep (Render's free tier does) stops the
 * heartbeat too — which the 72-hour check then reports as a gap, correctly, but
 * it means continuous observation needs a host that stays up.
 */

const { buildReport } = require('./betaReport');
const alerts = require('./alerts');

const DAY_MS = 24 * 60 * 60 * 1000;

function intervals(env = process.env) {
  return {
    heartbeatMs: Number(env.TELEMETRY_HEARTBEAT_MS) || 5 * 60 * 1000,
    alertMs: Number(env.BETA_ALERT_INTERVAL_MS) || 5 * 60 * 1000,
    reportMs: Number(env.BETA_REPORT_INTERVAL_MS) || DAY_MS,
    alertLookbackMs: Number(env.BETA_ALERT_LOOKBACK_MS) || 60 * 60 * 1000,
    settleMs: env.BETA_ALERT_SETTLE_MS !== undefined ? Number(env.BETA_ALERT_SETTLE_MS) : 60 * 1000,
  };
}

/**
 * Stores one report's aggregate: counts, ratios, status, observation — never the
 * per-game list, which names games and is not needed to read a trend.
 */
async function storeReport(db, report, now) {
  const { games, ...aggregate } = report;
  await db.query(
    `INSERT INTO telemetry_reports (kind, window_from, window_to, as_of, status, body, created_at)
     VALUES ('daily', $1, $2, $3, $4, $5, $3)`,
    [report.scope.from, report.scope.to, now, report.status, JSON.stringify(aggregate)]);
}

async function runReport(db, telemetry, settings, now = new Date()) {
  const health = telemetry.health();
  let report;
  try {
    report = await buildReport(db, {
      from: new Date(now.getTime() - settings.reportMs),
      to: now,
      cohort: health.cohortId,
      environment: health.environment,
      trafficKind: 'human_beta',
    }, { now });
  } catch (err) {
    report = null;
  }
  if (!report || report.queryFailed) {
    // Not computing a report is itself an alert, and it is stored as such — a
    // gap in the reports must be as visible as a gap in the heartbeats.
    const failed = {
      scope: { from: new Date(now.getTime() - settings.reportMs).toISOString(), to: now.toISOString() },
      status: 'OBSERVABILITY_GAP',
      notes: ['rapor hesaplanamadı'],
    };
    await storeReport(db, failed, now).catch(() => {});
    await alerts.deliver(db, [{
      kind: 'measurement_loss', key: `report_failed:${now.toISOString().slice(0, 10)}`,
      summary: 'günlük rapor hesaplanamadı',
    }], { now }).catch(() => {});
    return failed;
  }
  await storeReport(db, report, now);
  return report;
}

/**
 * One alert check: new problems AND the outbox. The two are separate on
 * purpose. Detection only looks back a limited window; a delivery that failed
 * must not depend on the problem still being inside it — the first version sent
 * only what the current check re-detected, so an alert whose webhook was down
 * for longer than the window was never delivered at all.
 */
async function runAlerts(db, settings, now = new Date()) {
  const found = await alerts.evaluate(db, {
    now, lookbackMs: settings.alertLookbackMs, heartbeatMs: settings.heartbeatMs, settleMs: settings.settleMs,
  });
  const pending = await alerts.pendingAlerts(db);
  const byKey = new Map(pending.map((a) => [a.key, a]));
  for (const a of found) byKey.set(a.key, a);
  return alerts.deliver(db, [...byKey.values()], { now });
}

/**
 * Starts the three loops. Returns a handle whose stop() clears them.
 * @param {{db: {query: Function, isReady: Function}, telemetry: object}} deps
 */
function start({ db, telemetry }, env = process.env) {
  const settings = intervals(env);
  const guard = (label, fn) => () => {
    if (!db.isReady()) return;
    Promise.resolve().then(fn).catch((err) => console.error(`beta monitor ${label} failed:`, err && err.message));
  };
  const beat = guard('heartbeat', () => {
    telemetry.record('telemetry_heartbeat', { details: { interval_ms: settings.heartbeatMs } });
  });
  const check = guard('alerts', () => runAlerts(db, settings));
  const report = guard('report', () => runReport(db, telemetry, settings));

  beat();
  const timers = [
    setInterval(beat, settings.heartbeatMs),
    setInterval(check, settings.alertMs),
    setInterval(report, settings.reportMs),
  ];
  for (const t of timers) t.unref();
  return {
    settings,
    stop() { for (const t of timers) clearInterval(t); },
  };
}

module.exports = { start, runReport, runAlerts, intervals, storeReport };
