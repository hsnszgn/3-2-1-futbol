/**
 * The staging preflight fails closed. Needs a real, isolated PostgreSQL.
 *
 * The local test database is plain TCP on 127.0.0.1 — exactly what staging
 * must NOT be — so every TLS check here must come out FAIL, and the command
 * must not report the database as ready. The PASS side of "tls_handshake"
 * needs a remote server with a real certificate chain; it is proven on staging
 * itself (docs/STAGING.md), not here.
 */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const CHECK = path.join(__dirname, '..', 'scripts', 'staging-check.js');

function check(env) {
  const r = spawnSync(process.execPath, [CHECK, '--json'], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000,
  });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch (err) { out = null; }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}
const status = (out, name) => (out.checks.find((c) => c.name === name) || {}).status;

module.exports = async function run({ databaseUrl }) {
  const notes = [];
  const db = new Client({ connectionString: databaseUrl, ssl: false });
  await db.connect();
  try {
    await db.query('TRUNCATE telemetry_events RESTART IDENTITY CASCADE');

    // 1. It never falls back to DATABASE_URL.
    {
      const r = check({ DATABASE_URL: databaseUrl, TELEMETRY_ENVIRONMENT: 'staging' });
      assert.strictEqual(r.code, 2, `ran without STAGING_DATABASE_URL (exit ${r.code})`);
      assert.ok(/STAGING_DATABASE_URL/.test(r.stderr));
      notes.push('STAGING_DATABASE_URL yokken DATABASE_URL\'e düşmedi (çıkış 2)');
    }

    // 2. A local, unencrypted database is not staging — and the password in the
    //    URL is never printed.
    // CI's URL already carries a password (the first version string-replaced
    // "postgres@" and found nothing to replace there); then that real password
    // is the secret checked for. Otherwise a marker password is added — the
    // local test database trusts any password.
    const parsed = new URL(databaseUrl);
    if (!parsed.password) parsed.password = 's3cretPW';
    const secret = decodeURIComponent(parsed.password);
    const withPassword = parsed.toString();
    assert.ok(secret.length >= 6 && withPassword.includes(`:${parsed.password}@`), 'the test URL did not take a password');
    {
      const r = check({ STAGING_DATABASE_URL: withPassword, TELEMETRY_ENVIRONMENT: 'staging' });
      assert.strictEqual(r.code, 1);
      assert.strictEqual(r.out.verdict, 'NOT_READY');
      assert.strictEqual(status(r.out, 'environment_label'), 'PASS');
      assert.strictEqual(status(r.out, 'tls_policy'), 'FAIL');
      assert.ok(/yerel adres/.test(r.out.checks.find((c) => c.name === 'tls_policy').detail),
        'a local database was not refused for being local');
      assert.strictEqual(status(r.out, 'tls_handshake'), 'FAIL', 'a plaintext connection was accepted');
      assert.strictEqual(status(r.out, 'separation'), 'UNKNOWN', 'an unchecked separation was not reported as UNKNOWN');
      assert.strictEqual(status(r.out, 'measurement_isolation'), 'PASS');
      assert.ok(!(r.stdout + r.stderr).includes(secret), 'the password was printed');
      notes.push('yerel/şifresiz bağlantı: tls_policy ve tls_handshake FAIL, ayrım UNKNOWN, sonuç NOT_READY; parola çıktıda yok');
    }

    // 3. Verification forced on against a server without TLS: fails closed.
    {
      const r = check({ STAGING_DATABASE_URL: databaseUrl, TELEMETRY_ENVIRONMENT: 'staging', DB_SSL: 'on' });
      assert.strictEqual(r.code, 1);
      assert.strictEqual(status(r.out, 'tls_handshake'), 'FAIL');
      assert.ok(/bağlanılamadı/.test(r.out.checks.find((c) => c.name === 'tls_handshake').detail));
      notes.push('DB_SSL=on + TLS\'siz sunucu: bağlantı reddedildi, FAIL');
    }

    // 4. The policy for a REMOTE host (the .invalid name never resolves, so no
    //    connection is made): verification on is a pass, switching it off never.
    {
      const remote = 'postgres://staging_user@ep-staging.invalid/app?sslmode=no-verify';
      const on = check({ STAGING_DATABASE_URL: remote, TELEMETRY_ENVIRONMENT: 'staging' });
      assert.strictEqual(status(on.out, 'tls_policy'), 'PASS', JSON.stringify(on.out && on.out.checks));
      assert.ok(/sslmode yok sayıldı/.test(on.out.checks.find((c) => c.name === 'tls_policy').detail),
        'sslmode=no-verify in the URL was not reported as ignored');
      assert.strictEqual(status(on.out, 'tls_handshake'), 'FAIL');
      assert.strictEqual(on.code, 1);
      const off = check({ STAGING_DATABASE_URL: remote, TELEMETRY_ENVIRONMENT: 'staging', DB_SSL: 'no-verify' });
      assert.strictEqual(status(off.out, 'tls_policy'), 'FAIL');
      assert.ok(/KAPALI/.test(off.out.checks.find((c) => c.name === 'tls_policy').detail));
      notes.push('uzak ana makine: doğrulama açıkken tls_policy PASS (URL\'deki sslmode=no-verify yok sayıldı), '
        + 'DB_SSL=no-verify ile FAIL; bağlantı kurulamayınca tls_handshake FAIL');
    }

    // 4b. The verdict: UNKNOWN is not a pass, and neither is an empty list.
    {
      const { verdictOf } = require('../scripts/staging-check');
      assert.strictEqual(verdictOf([{ status: 'PASS' }, { status: 'INFO' }]), 'PASS');
      assert.strictEqual(verdictOf([{ status: 'PASS' }, { status: 'UNKNOWN' }]), 'NOT_READY');
      assert.strictEqual(verdictOf([]), 'NOT_READY');
      notes.push('yalnız UNKNOWN kalan kontrol veya boş liste PASS sayılmadı');
    }

    // 5. Separation by host, and the wrong environment label.
    {
      const same = check({ STAGING_DATABASE_URL: databaseUrl, TELEMETRY_ENVIRONMENT: 'production', PRODUCTION_DATABASE_HOST: '127.0.0.1' });
      assert.strictEqual(status(same.out, 'separation'), 'FAIL', 'the same host was accepted as separate');
      assert.strictEqual(status(same.out, 'environment_label'), 'FAIL');
      const other = check({ STAGING_DATABASE_URL: databaseUrl, TELEMETRY_ENVIRONMENT: 'staging', PRODUCTION_DATABASE_HOST: 'ep-prod.example.neon.tech' });
      assert.strictEqual(status(other.out, 'separation'), 'PASS');
      const leaked = check({ STAGING_DATABASE_URL: databaseUrl, TELEMETRY_ENVIRONMENT: 'staging', PRODUCTION_DATABASE_HOST: 'postgres://u:p@ep-prod.example.neon.tech/db' });
      assert.strictEqual(status(leaked.out, 'separation'), 'FAIL', 'a full URL was accepted as a host');
      assert.ok(!/u:p@/.test(leaked.stdout), 'the production URL was echoed');
      notes.push('aynı ana makine FAIL, farklı PASS, URL verilirse FAIL ve yankılanmadı; TELEMETRY_ENVIRONMENT=production FAIL');
    }

    // 6. Another environment's events in the staging database.
    {
      await db.query(
        `INSERT INTO telemetry_events (event_id, schema_version, event_type, server_occurred_at, environment,
                                       traffic_kind, release_sha, process_instance_id, source, details)
         VALUES (gen_random_uuid(), 1, 'telemetry_heartbeat', now(), 'production', 'automated', 'x', gen_random_uuid()::text, 'server', '{}')`);
      const r = check({ STAGING_DATABASE_URL: databaseUrl, TELEMETRY_ENVIRONMENT: 'staging' });
      assert.strictEqual(status(r.out, 'measurement_isolation'), 'FAIL', 'production events in staging went unnoticed');
      assert.ok(/production=1/.test(r.out.checks.find((c) => c.name === 'measurement_isolation').detail));
      notes.push('staging veritabanında production etiketli olay: measurement_isolation FAIL');
    }
  } finally {
    await db.end().catch(() => {});
  }
  return notes.join(' · ');
};

module.exports.needsDatabase = true;
