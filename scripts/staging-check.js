#!/usr/bin/env node
/**
 * Staging preflight: is this really the staging database, and is the
 * connection to it really verified? READ-ONLY — it runs SELECTs and nothing
 * else.
 *
 *   STAGING_DATABASE_URL=... PRODUCTION_DATABASE_HOST=ep-....neon.tech \
 *   TELEMETRY_ENVIRONMENT=staging npm run staging:check
 *
 * It reads STAGING_DATABASE_URL and never DATABASE_URL, so an exported
 * production URL cannot be checked "as staging" by accident. It prints the host
 * only, never the URL (which carries the password).
 *
 * Every check ends PASS, FAIL or UNKNOWN. UNKNOWN is not a pass: a separation
 * that could not be checked (no production host given) is reported as such.
 * Exit code: 0 only when every check is PASS; 1 otherwise; 2 when it could not
 * run at all.
 *
 * What it shows about B3 (the Neon TLS chain): the handshake below uses the
 * server's own TLS policy (server/dbTls.js) with verification ON. A PASS on
 * "tls_handshake" is a real, verified handshake to that host from this machine
 * — the staging evidence B3 needs. It does not prove the same from the
 * production host's network; that is a separate step in docs/STAGING.md.
 */

const { Client } = require('pg');
const { sslConfigFor } = require('../server/dbTls');

function parseArgs(argv) {
  return { json: argv.includes('--json') };
}

async function run(env = process.env) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const url = env.STAGING_DATABASE_URL || '';
  if (!url) {
    return { fatal: 'STAGING_DATABASE_URL is required (DATABASE_URL is deliberately not read)', checks };
  }

  // 1. Environment label: the game and the watcher must write/read 'staging'.
  const label = env.TELEMETRY_ENVIRONMENT || '';
  add('environment_label', label === 'staging' ? 'PASS' : 'FAIL',
    label ? `TELEMETRY_ENVIRONMENT=${label}` : 'TELEMETRY_ENVIRONMENT boş');

  // 2. TLS policy, decided exactly as the server decides it.
  let cfg;
  try {
    cfg = sslConfigFor(url, env);
  } catch (err) {
    add('tls_policy', 'FAIL', err.message);
    return { host: null, checks };
  }
  const host = cfg.host;
  if (cfg.local) {
    add('tls_policy', 'FAIL', `yerel adres (${host}): staging uzak bir veritabanı olmalı`);
  } else if (!cfg.verified) {
    add('tls_policy', 'FAIL', `sertifika doğrulaması KAPALI (DB_SSL=${env.DB_SSL || ''}); B3 için kabul edilmez`);
  } else {
    add('tls_policy', 'PASS', `doğrulama açık, SNI=${cfg.ssl.servername || '(IP)'}, CA=${cfg.ssl.ca ? 'DB_CA_CERT' : 'sistem deposu'}`
      + (cfg.ignoredParams.length ? `; URL'deki ${cfg.ignoredParams.join(',')} yok sayıldı` : ''));
  }

  // 3. Separation from production, by host. Neon gives every branch and project
  //    its own endpoint host, so the same host means the same database.
  const prodHost = String(env.PRODUCTION_DATABASE_HOST || '').trim().toLowerCase();
  if (!prodHost) {
    add('separation', 'UNKNOWN', 'PRODUCTION_DATABASE_HOST verilmedi; ayrım kontrol edilemedi');
  } else if (prodHost.includes('://') || prodHost.includes('@')) {
    add('separation', 'FAIL', 'PRODUCTION_DATABASE_HOST yalnız ana makine adı olmalı, URL veya parola değil');
  } else if (prodHost === host) {
    add('separation', 'FAIL', `staging ve üretim AYNI ana makine: ${host}`);
  } else {
    add('separation', 'PASS', `staging ${host} ≠ üretim ${prodHost}`);
  }

  // 4. The connection itself, with that policy: a real handshake.
  const client = new Client({ connectionString: cfg.connectionString, ssl: cfg.ssl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
  } catch (err) {
    add('tls_handshake', 'FAIL', `bağlanılamadı: ${err.code || err.name}${err.code ? '' : ` (${String(err.message).slice(0, 120)})`}`);
    return { host, checks };
  }
  try {
    const ssl = (await client.query(
      'SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0] || {};
    if (cfg.verified && ssl.ssl) {
      add('tls_handshake', 'PASS', `doğrulanmış TLS: ${ssl.version} ${ssl.cipher}`);
    } else if (ssl.ssl) {
      add('tls_handshake', 'FAIL', `şifreli ama doğrulanmamış: ${ssl.version}`);
    } else {
      add('tls_handshake', 'FAIL', 'bağlantı şifresiz');
    }

    // 5. Nothing but staging measurement in it. Rows labelled with another
    //    environment mean two deployments are writing to one database.
    const tables = new Set((await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('telemetry_events', 'telemetry_reports', 'players', 'matches')`)).rows
      .map((r) => r.table_name));
    if (!tables.has('telemetry_events')) {
      add('measurement_isolation', 'UNKNOWN', 'telemetry_events yok (şema henüz kurulmamış)');
    } else {
      const { rows } = await client.query(
        `SELECT environment, count(*)::int AS n FROM telemetry_events GROUP BY environment ORDER BY environment`);
      const foreign = rows.filter((r) => r.environment !== 'staging');
      add('measurement_isolation', foreign.length ? 'FAIL' : 'PASS',
        foreign.length
          ? `başka ortam etiketli olaylar var: ${foreign.map((r) => `${r.environment}=${r.n}`).join(', ')}`
          : `yalnız staging olayları (${rows.reduce((a, r) => a + r.n, 0)})`);
    }
    // Information only: counts, never contents. A staging database with many
    // accounts is worth a look (a production copy?), but a count cannot prove it.
    const counts = {};
    for (const t of ['players', 'matches']) {
      if (tables.has(t)) counts[t] = (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    add('row_counts', 'INFO', JSON.stringify(counts));
  } finally {
    await client.end().catch(() => {});
  }
  return { host, checks };
}

/** PASS only when every check passed; UNKNOWN is not a pass. */
function verdictOf(checks) {
  return checks.length && checks.every((c) => c.status === 'PASS' || c.status === 'INFO') ? 'PASS' : 'NOT_READY';
}

async function main() {
  const { json } = parseArgs(process.argv);
  const result = await run();
  if (result.fatal) {
    console.error(result.fatal);
    process.exit(2);
  }
  const verdict = verdictOf(result.checks);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...result, verdict })}\n`);
  } else {
    console.log(`staging ön kontrol — ana makine: ${result.host || '?'}`);
    for (const c of result.checks) console.log(`  ${c.status.padEnd(7)} ${c.name}: ${c.detail}`);
    console.log(`sonuç: ${verdict}`);
  }
  process.exit(verdict === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`staging-check failed: ${err && err.message}`);
    process.exit(2);
  });
}

module.exports = { run, verdictOf };
