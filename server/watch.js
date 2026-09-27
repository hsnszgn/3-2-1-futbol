/**
 * The independent watcher's check (staging preparation for M6).
 *
 * The in-process monitor (server/betaMonitor.js) cannot say anything while the
 * game process is down: a crash is reported only when the NEXT process starts.
 * This check runs in a SEPARATE process — a scheduled job or a small loop on
 * another host — and looks at the game from the outside:
 *
 *   - the service answers its health endpoint, within a timeout;
 *   - the measurement is still being written: the target's newest heartbeat is
 *     no older than the same allowance the 72-hour window uses (two intervals
 *     plus a minute).
 *
 * Either failing is an outage. Delivery goes through the same alert code as the
 * game's own monitor (server/alerts.js): one alert per incident, a persistent
 * outbox with back-off, a visible end when delivery is abandoned. When the
 * service comes back, one "recovered" notice follows the outage it closes.
 *
 * An incident is keyed by the last evidence seen when it began — the newest
 * heartbeat at that moment. While an incident is open (reported, not yet
 * closed by a recovery) every later check reuses ITS key: the process may still
 * be writing heartbeats while its health endpoint fails, and keying each check
 * by the newest heartbeat sent one alert per heartbeat for a single incident.
 * A later outage, after the recovery, gets a new key.
 */

const alerts = require('./alerts');

// The same allowance the 72-hour window uses: two intervals plus a minute.
// Overridable only so a test can see staleness in seconds rather than a minute.
const GRACE_MS = Number(process.env.BETA_WATCH_GRACE_MS) >= 0 && process.env.BETA_WATCH_GRACE_MS !== undefined
  ? Number(process.env.BETA_WATCH_GRACE_MS) : 60 * 1000;

async function probeHealth(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!url) return { ok: null, reason: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    return res.ok ? { ok: true } : { ok: false, reason: `http_${res.status}` };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The target's newest lifecycle evidence: heartbeat, start or planned stop. */
async function lastEvidence(client, { environment, release }) {
  const { rows } = await client.query(
    `SELECT event_type, server_occurred_at, details
       FROM telemetry_events
      WHERE event_type IN ('telemetry_heartbeat', 'process_started', 'process_stopping')
        AND ($1::text IS NULL OR environment = $1)
        AND ($2::text IS NULL OR release_sha = $2)
      ORDER BY server_occurred_at DESC
      LIMIT 1`, [environment || null, release || null]);
  return rows[0] || null;
}

/**
 * The target's outages that are still open: recorded, not given up on, and not
 * closed by a recovery. Newest first. `reported` means it actually went out (or
 * could not, for want of a channel) — only those are closed by a recovery.
 */
async function openIncidents(client, target) {
  const { rows } = await client.query(
    `SELECT o.body->>'key' AS key,
            max(o.created_at) AS last_at,
            bool_or(o.status IN ('SENT', 'NOT_CONFIGURED')) AS reported,
            bool_or(o.status = 'DELIVERY_ABANDONED') AS abandoned
       FROM telemetry_reports o
      WHERE o.kind = 'alert' AND o.body->>'kind' = 'service_outage' AND o.body->>'key' LIKE $1
        AND NOT EXISTS (SELECT 1 FROM telemetry_reports r
                         WHERE r.kind = 'alert' AND r.body->>'key' = 'recovered:' || (o.body->>'key')
                           AND r.status IN ('SENT', 'NOT_CONFIGURED', 'DELIVERY_ABANDONED'))
      GROUP BY o.body->>'key'
      ORDER BY last_at DESC`,
    [`outage:${target}:%`]);
  return rows.filter((r) => !r.abandoned);
}

/**
 * One check. Returns what it saw and what it delivered.
 *
 * @param {{query: Function}} client a database connection (read + alert state)
 */
async function checkOnce(client, {
  healthUrl, environment = null, release = null, heartbeatMs = 5 * 60 * 1000,
  now = new Date(), fetchImpl = fetch, healthTimeoutMs = 5000, webhookUrl,
} = {}) {
  const health = await probeHealth(healthUrl, { fetchImpl, timeoutMs: healthTimeoutMs });
  const last = await lastEvidence(client, { environment, release });
  const lastAt = last ? new Date(last.server_occurred_at) : null;
  const own = last && last.details && Number(last.details.interval_ms) > 0
    ? Math.min(Number(last.details.interval_ms), heartbeatMs) : heartbeatMs;
  const allowance = 2 * own + GRACE_MS;
  const stale = !lastAt || now - lastAt > allowance;
  const reasons = [];
  if (health.ok === false) reasons.push(`sağlık ucu: ${health.reason}`);
  if (stale) {
    reasons.push(lastAt
      ? `son kalp atışı ${Math.round((now - lastAt) / 1000)} sn önce (izin ${Math.round(allowance / 1000)} sn)`
      : 'hiç kalp atışı yok');
  }
  if (last && last.event_type === 'process_stopping' && reasons.length) reasons.push('son olay planlı kapanış');

  const target = environment || 'her-ortam';
  const incidents = await openIncidents(client, target);
  const incidentKey = incidents.length
    ? incidents[0].key
    : `outage:${target}:${lastAt ? lastAt.toISOString() : 'never'}`;
  const toSend = [];
  if (reasons.length) {
    toSend.push({
      kind: 'service_outage',
      key: incidentKey,
      summary: `${target}: ${reasons.join('; ')}`,
    });
  } else {
    // Healthy now: close every outage that was reported and not yet closed.
    // One still waiting in the outbox is left open until it has gone out, so a
    // recovery never arrives before the outage it closes.
    for (const { key } of incidents.filter((i) => i.reported)) {
      toSend.push({ kind: 'service_recovered', key: `recovered:${key}`, summary: `${target}: servis yeniden yanıt veriyor` });
    }
  }
  // Anything still waiting in the outbox — including alerts the game process
  // itself failed to deliver before it went down.
  const pending = await alerts.pendingAlerts(client);
  const byKey = new Map(pending.map((a) => [a.key, a]));
  for (const a of toSend) byKey.set(a.key, a);
  const outcomes = await alerts.deliver(client, [...byKey.values()], {
    now, ...(webhookUrl !== undefined ? { webhookUrl } : {}), fetchImpl,
  });
  return {
    healthy: reasons.length === 0,
    health,
    lastEvidence: lastAt ? lastAt.toISOString() : null,
    reasons,
    incidentKey: reasons.length ? incidentKey : null,
    outcomes,
  };
}

/**
 * The database itself is unreachable: there is no alert state to de-duplicate
 * against, so this is sent directly. The caller limits repeats (the loop sends
 * it once per outage of the database; a one-shot run sends it every run, which
 * the runbook states).
 */
async function alertDirect({ kind, key, summary }, {
  webhookUrl = process.env.BETA_ALERT_WEBHOOK_URL, fetchImpl = fetch, timeoutMs = 5000, now = new Date(),
} = {}) {
  const target = alerts.webhookTarget(webhookUrl);
  if (!target.ok) return { status: 'NOT_CONFIGURED', error: target.reason };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key, summary, detectedAt: now.toISOString() }),
      signal: controller.signal,
    });
    return { status: res.ok ? 'SENT' : 'DELIVERY_FAILED' };
  } catch (err) {
    return { status: 'DELIVERY_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkOnce, probeHealth, lastEvidence, openIncidents, alertDirect, GRACE_MS };
