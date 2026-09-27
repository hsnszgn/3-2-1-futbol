#!/usr/bin/env node
/**
 * The independent watcher (staging preparation for M6).
 *
 *   npm run beta:watch -- --once                     # one check, for a scheduler
 *   npm run beta:watch -- --interval-ms 60000        # a loop, for a small host
 *   npm run beta:watch -- --test-alert               # one test alert to the channel
 *
 * Runs OUTSIDE the game process, so it can report an outage while the game is
 * down — which the game's own monitor cannot. See server/watch.js for what it
 * checks and how incidents are keyed.
 *
 * Configuration, from the environment only (nothing secret on the command line):
 *   REPORT_DATABASE_URL / DATABASE_URL  the measurement database (read, plus the
 *                                       alert state rows it writes)
 *   BETA_WATCH_HEALTH_URL               the game's /healthz, e.g. https://staging.example/healthz
 *   BETA_ALERT_WEBHOOK_URL              where alerts go (HTTPS, or this machine)
 *   TELEMETRY_ENVIRONMENT               which environment's heartbeats to watch
 *   TELEMETRY_HEARTBEAT_MS              the interval the game was configured with
 *
 * Exit code in --once mode: 0 healthy, 1 outage seen, 2 the watcher itself
 * could not run — so a scheduler that only looks at exit codes still notices.
 */

const { Client } = require('pg');
const { clientConfig } = require('../server/betaReport');
const { checkOnce, alertDirect } = require('../server/watch');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

const settings = {
  once: process.argv.includes('--once'),
  intervalMs: Number(arg('interval-ms')) || 60 * 1000,
  healthUrl: process.env.BETA_WATCH_HEALTH_URL || null,
  environment: arg('environment') || process.env.TELEMETRY_ENVIRONMENT || null,
  release: arg('release') || null,
  heartbeatMs: Number(process.env.TELEMETRY_HEARTBEAT_MS) || 5 * 60 * 1000,
};

function log(result) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
}

async function connect(url) {
  const client = new Client(clientConfig(url));
  await client.connect();
  return client;
}

async function main() {
  // Delivery test for the alert channel: one direct alert, no database, no
  // state. Exit 0 only when the channel accepted it.
  if (process.argv.includes('--test-alert')) {
    const sent = await alertDirect({
      kind: 'watch_test',
      key: `watch-test:${Date.now()}`,
      summary: `izleyici kanal testi (${settings.environment || 'her-ortam'}) — işlem gerekmez`,
    });
    log({ testAlert: sent.status, error: sent.error || null });
    process.exit(sent.status === 'SENT' ? 0 : 1);
  }

  const url = process.env.REPORT_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!url) {
    console.error('REPORT_DATABASE_URL (or DATABASE_URL) is required; never taken from the command line.');
    process.exit(2);
  }
  try {
    clientConfig(url);
  } catch (err) {
    console.error(`refusing to connect: ${err.message}`);
    process.exit(2);
  }

  let client = null;
  let dbDownReported = false;
  const tick = async () => {
    try {
      if (!client) client = await connect(url);
      const result = await checkOnce(client, settings);
      dbDownReported = false;
      log(result);
      return result.healthy ? 0 : 1;
    } catch (err) {
      // No database: no alert state to de-duplicate against. Sent directly,
      // once per database outage in loop mode; every run in --once mode.
      if (client) { client.end().catch(() => {}); client = null; }
      if (!dbDownReported) {
        const sent = await alertDirect({
          kind: 'watcher_db_unreachable',
          key: `watcher-db:${settings.environment || 'her-ortam'}`,
          summary: `izleyici ölçüm veritabanına ulaşamıyor (${err.code || err.name || 'hata'})`,
        });
        dbDownReported = sent.status === 'SENT';
        log({ healthy: false, watcherError: err.code || err.name || 'error', alert: sent.status });
      }
      return 2;
    }
  };

  if (settings.once) {
    const code = await tick();
    if (client) await client.end().catch(() => {});
    process.exit(code);
  }
  await tick();
  // One check at a time: a slow one (health and webhook timeouts are 5 s each)
  // must not overlap the next, or both could see "not sent yet" and send twice.
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  }, settings.intervalMs);
  const stop = () => { clearInterval(timer); if (client) client.end().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(`beta-watch failed: ${err && err.stack}`);
  process.exit(2);
});
