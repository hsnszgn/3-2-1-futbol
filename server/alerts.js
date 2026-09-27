/**
 * Beta alerts (roadmap M6): the things that must not wait for the daily report.
 *
 *   score_or_record_inconsistency  a finished game whose events contradict
 *                                  each other or the stored row
 *   process_crash                  a server process that stopped without saying so
 *   measurement_loss               the measurement degraded, contradicted itself,
 *                                  or stopped producing heartbeats
 *
 * Delivery is a webhook (BETA_ALERT_WEBHOOK_URL). Three promises:
 *   - one alert per problem: a problem already reported inside the cool-down is
 *     not sent again, however many checks see it;
 *   - a failure to deliver is VISIBLE: it is stored as DELIVERY_FAILED and tried
 *     again on the next check, and "no webhook configured" is stored as
 *     NOT_CONFIGURED rather than being a silent no-op;
 *   - no secrets: an alert carries its kind, a key, a count and a short summary
 *     built from codes — never event details, messages, names or tokens.
 *
 * State lives in telemetry_reports (kind 'alert'), so it survives restarts and
 * expires with the 90-day report retention.
 */

const { collect } = require('./betaReport');
const { gameFindings } = require('./betaMetrics');
const { observe } = require('./observation');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where alerts may be sent. HTTPS only, except to this machine (tests, and a
 * relay running beside the server). Anything else is refused and reported,
 * because an alert body sent in clear text to an arbitrary host is a leak.
 */
function webhookTarget(raw) {
  if (!raw) return { ok: false, reason: 'not_configured' };
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return { ok: true, url };
  return { ok: false, reason: 'insecure_url' };
}

/**
 * Looks for problems in the last `lookbackMs`.
 *
 * `settleMs` keeps a game that JUST finished out of the consistency check: its
 * result is written asynchronously, and checking it a moment too early would
 * report a missing row that is about to appear.
 */
async function evaluate(client, { now = new Date(), lookbackMs, heartbeatMs, settleMs = 60 * 1000 }) {
  const from = new Date(now.getTime() - lookbackMs);
  const alerts = [];

  // 1. consistency — every kind of traffic: a broken game is broken whoever played it.
  const data = await collect(client, { from, to: now, trafficKind: null });
  const byGame = new Map();
  for (const e of data.events) {
    if (!byGame.has(e.game_id)) byGame.set(e.game_id, []);
    byGame.get(e.game_id).push(e);
  }
  const rowsByUid = new Map(data.matchRows.map((r) => [r.match_uid, r]));
  for (const [gameId, rows] of byGame) {
    const finished = rows.find((r) => r.event_type === 'game_finished');
    if (!finished || now - new Date(finished.server_occurred_at) < settleMs) continue;
    const faults = gameFindings(rows, { matchRow: rowsByUid.get(gameId), recordsChecked: true })
      .filter((f) => f.severity === 'fault');
    if (faults.length) {
      alerts.push({
        kind: 'score_or_record_inconsistency',
        key: `inconsistency:${gameId}`,
        summary: `maç ${gameId}: ${[...new Set(faults.map((f) => f.kind))].join(', ')}`,
      });
    }
  }

  // 2. crashes: a process that started, never said it was stopping, and has
  //    since been replaced by a newer one.
  //
  //    Judged from EVERY retained lifecycle event, not from the look-back
  //    window. The first version looked at the last hour only, so a process
  //    that died two hours before the restart was outside the window when the
  //    new one came up — and a long outage, the worst kind, raised nothing.
  //    Each crash is still alerted once: delivery suppresses a key that was
  //    ever sent.
  const processes = (await client.query(
    `SELECT process_instance_id,
            min(server_occurred_at) AS first_seen,
            max(server_occurred_at) AS last_seen,
            bool_or(event_type = 'process_stopping') AS stopped
       FROM telemetry_events
      WHERE event_type IN ('process_started', 'process_stopping', 'telemetry_heartbeat')
      GROUP BY process_instance_id
      ORDER BY first_seen`)).rows;
  for (let i = 0; i < processes.length - 1; i += 1) {
    const p = processes[i];
    const newer = processes.slice(i + 1).find((q) => q.first_seen >= p.last_seen);
    if (!p.stopped && newer) {
      alerts.push({
        kind: 'process_crash',
        key: `crash:${p.process_instance_id}`,
        summary: `süreç ${p.process_instance_id.slice(0, 8)} kapanış bildirmeden durdu; yerine yenisi başladı`,
      });
    }
  }

  // 3. measurement loss: the measurement's own fault events, and silence.
  const faults = (await client.query(
    `SELECT event_id, event_type, process_instance_id, details
       FROM telemetry_events
      WHERE event_type IN ('telemetry_degraded', 'telemetry_conflict') AND server_occurred_at >= $1`,
    [from])).rows;
  for (const f of faults) {
    const fault = f.event_type === 'telemetry_conflict' ? 'event_id_conflict' : String((f.details || {}).fault || 'degraded');
    alerts.push({
      kind: 'measurement_loss',
      key: `measurement:${f.process_instance_id}:${fault}`,
      summary: `ölçüm arızası: ${fault}`,
    });
  }
  const evidence = (await client.query(
    `SELECT event_type, server_occurred_at FROM telemetry_events
      WHERE event_type IN ('telemetry_heartbeat', 'process_started', 'process_stopping')
        AND server_occurred_at >= $1`, [new Date(from.getTime() - 3 * heartbeatMs)])).rows;
  // Judged up to one interval ago: the heartbeat for "now" may not be written yet.
  const seen = observe(evidence, { from, to: new Date(now.getTime() - heartbeatMs), now, heartbeatMs });
  // Only silence that STARTS at real evidence: a running process whose
  // heartbeats stopped. Two kinds of "gap" are left out on purpose:
  //   - one that begins at the edge of the look-back window: its start is not an
  //     event but "whenever this check happened to look", so its key would change
  //     on every check and defeat de-duplication — the first version did exactly
  //     that and sent a new alert every 300 ms;
  //   - one that ends at a process start: that is the server being down, which
  //     is the crash alert's job (or a planned stop), and the 72-hour report
  //     shows it as a gap either way.
  const starts = new Set(evidence.filter((e) => e.event_type === 'process_started')
    .map((e) => new Date(e.server_occurred_at).toISOString()));
  for (const g of seen.gaps) {
    if (g.from === from.toISOString()) continue;
    if (starts.has(g.to)) continue;
    alerts.push({
      kind: 'measurement_loss',
      key: `gap:${g.from}`,
      summary: `gözlem boşluğu ${g.from} → ${g.to}`,
    });
  }

  return alerts;
}

const retryPolicy = (env = process.env) => ({
  baseMs: Number(env.BETA_ALERT_RETRY_BASE_MS) || 60 * 1000,
  maxMs: Number(env.BETA_ALERT_RETRY_MAX_MS) || 60 * 60 * 1000,
  maxAttempts: Number(env.BETA_ALERT_MAX_ATTEMPTS) || 24,
});

/**
 * Alerts whose last delivery attempt failed and that are neither sent nor given
 * up on — the outbox. Read from the stored alert rows, so it survives a restart
 * and does not depend on the problem still being inside the detection window.
 */
async function pendingAlerts(client) {
  const rows = (await client.query(
    `SELECT DISTINCT ON (body->>'key') body, status
       FROM telemetry_reports
      WHERE kind = 'alert'
      ORDER BY body->>'key', created_at DESC, id DESC`)).rows;
  return rows.filter((r) => r.status === 'DELIVERY_FAILED')
    .map((r) => ({ kind: r.body.kind, key: r.body.key, summary: r.body.summary }));
}

/**
 * Sends what has not been sent, records every outcome.
 *
 *   SENT / NOT_CONFIGURED / DELIVERY_ABANDONED are final: that key is never
 *   sent again (within the 90-day report retention). A problem is reported once.
 *   DELIVERY_FAILED is pending: retried with exponential back-off until it goes
 *   through or `maxAttempts` failures have been recorded, and then stored as
 *   DELIVERY_ABANDONED and logged — a terminal failure is visible, not silent.
 *
 * @returns {Promise<{key: string, status: string}[]>}
 */
async function deliver(client, alerts, {
  now = new Date(), webhookUrl = process.env.BETA_ALERT_WEBHOOK_URL,
  timeoutMs = 5000, fetchImpl = fetch, policy = retryPolicy(),
} = {}) {
  const target = webhookTarget(webhookUrl);
  const outcomes = [];
  const store = (alert, status, error) => client.query(
    `INSERT INTO telemetry_reports (kind, as_of, status, body, created_at)
     VALUES ('alert', $1, $2, $3, $1)`,
    [now, status, JSON.stringify({ kind: alert.kind, key: alert.key, summary: alert.summary, error })]);

  for (const alert of alerts) {
    const history = (await client.query(
      `SELECT status, created_at FROM telemetry_reports
        WHERE kind = 'alert' AND body->>'key' = $1
        ORDER BY created_at DESC, id DESC`, [alert.key])).rows;
    if (history.some((h) => ['SENT', 'NOT_CONFIGURED', 'DELIVERY_ABANDONED'].includes(h.status))) {
      outcomes.push({ key: alert.key, status: 'SUPPRESSED' });
      continue;
    }
    const failures = history.filter((h) => h.status === 'DELIVERY_FAILED').length;
    if (failures >= policy.maxAttempts) {
      await store(alert, 'DELIVERY_ABANDONED', `after_${failures}_attempts`);
      console.error(`beta alert ABANDONED after ${failures} failed deliveries: ${alert.kind} ${alert.key}`);
      outcomes.push({ key: alert.key, status: 'DELIVERY_ABANDONED' });
      continue;
    }
    if (failures) {
      const wait = Math.min(policy.baseMs * (2 ** (failures - 1)), policy.maxMs);
      if (now - new Date(history[0].created_at) < wait) {
        outcomes.push({ key: alert.key, status: 'RETRY_WAIT' });
        continue;
      }
    }

    let status;
    let error = null;
    if (!target.ok) {
      status = 'NOT_CONFIGURED';
      error = target.reason;
      console.error(`beta alert NOT delivered (${target.reason}): ${alert.kind} ${alert.key}`);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(target.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: alert.kind, key: alert.key, summary: alert.summary, detectedAt: now.toISOString(),
          }),
          signal: controller.signal,
        });
        status = res.ok ? 'SENT' : 'DELIVERY_FAILED';
        if (!res.ok) error = `http_${res.status}`;
      } catch (err) {
        status = 'DELIVERY_FAILED';
        error = err && err.name === 'AbortError' ? 'timeout' : 'network';
      } finally {
        clearTimeout(timer);
      }
      if (status !== 'SENT') console.error(`beta alert delivery failed (${error}): ${alert.kind} ${alert.key}`);
    }
    await store(alert, status, error);
    outcomes.push({ key: alert.key, status });
  }
  return outcomes;
}

module.exports = { evaluate, deliver, pendingAlerts, retryPolicy, webhookTarget };
