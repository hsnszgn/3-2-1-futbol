/**
 * The database connection has to check who it is talking to.
 *
 * It did not: `ssl: { rejectUnauthorized: false }` encrypts the traffic and then
 * accepts any certificate at all, including one an attacker in the middle
 * generated a second ago. Two separate things had to be fixed:
 *
 *   1. the verification itself, proved here against a real TLS server holding a
 *      self-signed certificate — the connection must fail, and fail BECAUSE of
 *      the certificate;
 *   2. the fact that the connection string could undo it. `pg-connection-string`
 *      turns `?sslmode=no-verify` into `{ rejectUnauthorized: false }` and
 *      `?sslmode=disable` into `false`, and pg lets that REPLACE the ssl option
 *      passed in code (measured, see the assertions below). So a URL could
 *      switch verification off from the outside.
 *
 * No database is needed: what is under test is the TLS decision and the
 * handshake, so the server here speaks just enough of the Postgres startup to
 * reach TLS and nothing more.
 */
const assert = require('assert');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const ConnectionParameters = require('pg/lib/connection-parameters');

const db = require('../server/db');

/** A throwaway self-signed certificate — what a man in the middle can always make. */
function selfSigned(commonName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-test-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${commonName}`], { stdio: 'ignore' });
  return {
    key: fs.readFileSync(key),
    cert: fs.readFileSync(cert),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A listener that answers the Postgres SSLRequest with "S" and then completes a
 * TLS handshake with the given certificate. It records whether the handshake
 * succeeded, which is what separates "refused because of the certificate" from
 * "refused for some other reason".
 */
function startPostgresLookalike(creds) {
  const state = { handshakes: 0, tlsErrors: [] };
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('S'); // "yes, let's do TLS" — the real protocol's answer
      const secure = new tls.TLSSocket(socket, {
        isServer: true, key: creds.key, cert: creds.cert,
      });
      secure.on('secure', () => { state.handshakes += 1; });
      secure.on('error', (err) => { state.tlsErrors.push(err.code || err.message); });
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      state,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

/**
 * Does the TLS handshake by hand, the way the driver does: send the Postgres
 * SSLRequest, take the "S", then upgrade.
 *
 * Used for the CONTROL cases. A pg Pool is the right thing for proving the
 * production path refuses a bad certificate, but it is the wrong instrument for
 * proving one would be ACCEPTED: past the handshake it waits for a startup
 * reply this stub never sends. Here the handshake itself is the answer.
 */
function handshake(port, options) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4); // SSLRequest
      socket.write(request);
      socket.once('data', () => {
        const secure = tls.connect({ socket, ...options }, () => {
          // Let the server finish its side before tearing the socket down,
          // otherwise its own handshake event never fires and the control
          // measurement would be reading a race.
          setTimeout(() => secure.destroy(), 200);
          resolve({ ok: true });
        });
        secure.on('error', (err) => {
          socket.destroy();
          resolve({ ok: false, code: err.code || '', message: err.message });
        });
      });
    });
    socket.on('error', (err) => resolve({ ok: false, code: err.code || '', message: err.message }));
  });
}

/** Tries one query and returns the error, or null if it somehow succeeded. */
async function connectError(config) {
  const pool = new Pool({ ...config, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  pool.on('error', () => {});
  try {
    await pool.query('SELECT 1');
    return null;
  } catch (err) {
    return err;
  } finally {
    await pool.end().catch(() => {});
  }
}

module.exports = async function run() {
  const notes = [];

  // --- 1. the decision itself ----------------------------------------------
  {
    const local = db.sslConfigFor('postgres://u:p@127.0.0.1:5432/app');
    assert.strictEqual(local.ssl, false, 'a local database was asked for TLS it does not have');
    assert.strictEqual(local.local, true, '127.0.0.1 was not recognised as this machine');

    const remote = db.sslConfigFor('postgres://u:p@db.example.com/app');
    assert.deepStrictEqual(
      { rejectUnauthorized: remote.ssl.rejectUnauthorized, servername: remote.ssl.servername },
      { rejectUnauthorized: true, servername: 'db.example.com' },
      'a remote database was not verified against the host being asked for');

    // The old test was a regex over the whole string. These two are remote
    // databases whose connection strings merely MENTION a local address — under
    // the regex both ran unencrypted.
    const looksLocal = db.sslConfigFor('postgres://u:localhost@db.example.com/app');
    assert.strictEqual(looksLocal.ssl && looksLocal.ssl.rejectUnauthorized, true,
      'a password containing "localhost" switched TLS off for a remote host');
    const paramLocal = db.sslConfigFor('postgres://u:p@db.example.com/app?options=host%3D127.0.0.1');
    assert.strictEqual(paramLocal.ssl && paramLocal.ssl.rejectUnauthorized, true,
      'a parameter mentioning 127.0.0.1 switched TLS off for a remote host');
    notes.push('yerel istisna yalnız ayrıştırılmış host ile: parola/parametre içindeki "localhost" TLS\'i kapatmıyor');
  }

  // --- 1b. the policy's host must be the host pg actually dials -------------
  // Reading URL.hostname is not enough: a `host=` query parameter overrides the
  // authority, so a connection string could keep the local no-TLS exception
  // while sending the driver to a remote server. Asserting the policy alone
  // would never catch that — the driver's own resolution is the check.
  {
    const cases = [
      'postgres://user:pw@localhost/app?host=db.example.com',
      'postgres://user:pw@db.example.com/app?host=localhost',
      'postgres://user:pw@db.example.com/app',
      'postgres://user:pw@127.0.0.1:5433/app',
      'postgres://user:pw@db.example.com/app?sslmode=disable&host=other.example.com',
    ];
    for (const raw of cases) {
      const policy = db.sslConfigFor(raw, {});
      const actual = new ConnectionParameters({
        connectionString: policy.connectionString,
        ssl: policy.ssl,
      });
      assert.strictEqual(String(actual.host).toLowerCase(), policy.host,
        `the TLS decision was made for "${policy.host}" while pg connects to "${actual.host}"`);

      const remote = !['localhost', '127.0.0.1', '::1'].includes(String(actual.host).toLowerCase());
      if (remote) {
        assert.ok(actual.ssl && actual.ssl.rejectUnauthorized === true,
          `pg would reach the remote host "${actual.host}" with ssl=${JSON.stringify(actual.ssl)}`);
      } else {
        assert.strictEqual(actual.ssl, false,
          `a local target asked for TLS it does not have: ${JSON.stringify(actual.ssl)}`);
      }
    }
    const overridden = db.sslConfigFor('postgres://user:pw@localhost/app?host=db.example.com', {});
    assert.strictEqual(overridden.hostOverridden, true,
      'a host parameter that moves the target was not reported');
    notes.push(`politika host'u sürücünün gerçek hedefiyle aynı (${cases.length} biçim); "?host=" ile uzağa taşınan bağlantı artık doğrulanıyor`);
  }

  // --- 2. the connection string cannot weaken it ---------------------------
  {
    // First, the behaviour being defended against, measured in pg itself.
    const hijacked = new ConnectionParameters({
      connectionString: 'postgres://u:p@db.example.com/app?sslmode=no-verify',
      ssl: { rejectUnauthorized: true },
    });
    assert.strictEqual(hijacked.ssl.rejectUnauthorized, false,
      'pg no longer lets the URL override the ssl option — this test is out of date');

    for (const mode of ['no-verify', 'disable', 'require']) {
      const cfg = db.sslConfigFor(`postgres://u:p@db.example.com/app?sslmode=${mode}`);
      assert.ok(cfg.ignoredParams.includes('sslmode'),
        `sslmode=${mode} was left in the connection string for pg to act on`);
      assert.ok(!/sslmode/.test(cfg.connectionString),
        `sslmode=${mode} survived into the string handed to pg`);
      // And what pg finally sees is still verification.
      const resolved = new ConnectionParameters({ connectionString: cfg.connectionString, ssl: cfg.ssl });
      assert.strictEqual(resolved.ssl.rejectUnauthorized, true,
        `sslmode=${mode} still disabled verification end to end`);
    }
    notes.push('URL\'deki sslmode=no-verify/disable/require ayıklanıyor; pg\'nin gördüğü ayar doğrulama kalıyor');

    // The escape hatch is deliberate, explicit and reported as unverified.
    const opted = db.sslConfigFor('postgres://u:p@db.example.com/app', { DB_SSL: 'no-verify' });
    assert.strictEqual(opted.verified, false, 'the opt-out was not reported as unverified');
    assert.strictEqual(opted.ssl.rejectUnauthorized, false, 'the opt-out did not take effect');
    const forced = db.sslConfigFor('postgres://u:p@127.0.0.1/app', { DB_SSL: 'on' });
    assert.strictEqual(forced.ssl.rejectUnauthorized, true, 'DB_SSL=on did not force verification');
  }

  // --- 3. a real handshake against a real bad certificate ------------------
  {
    const creds = selfSigned('db.example.com');
    const fake = await startPostgresLookalike(creds);
    try {
      // DB_SSL=on so the loopback address is verified like any remote host;
      // otherwise the local exception would (correctly) skip TLS entirely.
      const verified = db.sslConfigFor(`postgres://u:p@127.0.0.1:${fake.port}/app`, { DB_SSL: 'on' });
      const err = await connectError({ connectionString: verified.connectionString, ssl: verified.ssl });
      assert.ok(err, 'a self-signed certificate was accepted');
      const code = err.code || '';
      assert.ok(/SELF_SIGNED|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT/.test(code)
        || /certificate/i.test(err.message),
        `the connection failed for an unrelated reason: ${code} ${err.message}`);
      assert.strictEqual(fake.state.handshakes, 0,
        'the TLS handshake completed despite the certificate being untrusted');

      // Control: the OLD setting accepts this very certificate. Without it,
      // "the connection failed" would prove nothing about verification — the
      // stub server might simply be unusable.
      const permissive = await handshake(fake.port, { rejectUnauthorized: false });
      assert.strictEqual(permissive.ok, true,
        `the control handshake failed too, so the comparison is void: ${permissive.message}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(fake.state.handshakes, 1,
        'the control never completed a handshake on the server side');
      notes.push(`kendinden imzalı sertifika reddedildi (${code || err.message.slice(0, 40)}); `
        + 'aynı sertifika eski ayarla (rejectUnauthorized:false) el sıkışmayı tamamlıyor');

      // A certificate that is valid for a DIFFERENT host must also be refused:
      // verifying the chain is not the same as verifying who answered. Here the
      // certificate's own issuer is trusted explicitly, so the only thing left
      // to fail on is the name.
      const wrongHost = await handshake(fake.port, { ca: creds.cert, rejectUnauthorized: true });
      assert.strictEqual(wrongHost.ok, false, 'a certificate issued for another host was accepted');
      assert.ok(/altname|Hostname|IP:/i.test(`${wrongHost.code} ${wrongHost.message}`),
        `the wrong-host case failed for an unrelated reason: ${wrongHost.code} ${wrongHost.message}`);
      notes.push(`zinciri kabul edilse bile başka host için kesilmiş sertifika reddedildi (${wrongHost.code || wrongHost.message.slice(0, 50)})`);
    } finally {
      await fake.stop();
      creds.cleanup();
    }
  }

  return notes.join(' · ');
};
