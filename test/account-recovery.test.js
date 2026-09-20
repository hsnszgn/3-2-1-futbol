/**
 * A database that is not there YET must not disable accounts until someone
 * redeploys.
 *
 * The retry loop was already covered by counting connection attempts, and that
 * proves only that the server keeps trying. What it never showed is the thing
 * that matters: the transition. This drives the whole arc against a real
 * PostgreSQL — the server starts while nothing is listening, the migration
 * fails, the database then becomes reachable, and the server has to reach
 * READY on its own and serve real registrations afterwards.
 *
 * The outage is real rather than mocked: the server is pointed at a local port
 * with nothing behind it, and a TCP proxy to the throwaway PostgreSQL is
 * started on that port partway through. Nothing in the production path is
 * replaced.
 */
const assert = require('assert');
const net = require('net');
const { startTestServer } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port that is free right now — the outage is "nothing is listening here". */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Forwards 127.0.0.1:<port> to the real database, once started. */
function startProxy(port, target) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on('error', drop);
    upstream.on('error', drop);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      async stop() {
        for (const s of sockets) s.destroy();
        await new Promise((done) => server.close(done));
      },
    }));
  });
}

async function config(url) {
  const res = await fetch(`${url}/api/config`);
  assert.strictEqual(res.status, 200, `/api/config answered ${res.status}`);
  return res.json();
}

module.exports = async function run({ databaseUrl }) {
  const target = new URL(databaseUrl);
  const port = await freePort();
  // Same credentials and database, reached through a port that is dead for now.
  const detour = new URL(databaseUrl);
  detour.hostname = '127.0.0.1';
  detour.port = String(port);

  const notes = [];
  let proxy = null;
  const server = await startTestServer({
    DATABASE_URL: detour.toString(),
    MIGRATE_RETRY_MS: '500',
    DB_CONNECT_TIMEOUT_MS: '1500',
  });

  try {
    // --- the outage: configured, not ready, and honest about both ------------
    const down = await config(server.url);
    assert.strictEqual(down.accountsConfigured, true,
      'a server with a connection string denied having a database');
    assert.strictEqual(down.accountsEnabled, false,
      'accounts were announced as working while the database was unreachable');

    const blockedRegister = await fetch(`${server.url}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `once${Date.now().toString().slice(-6)}`, password: 'sifre123' }),
    });
    assert.strictEqual(blockedRegister.status, 503,
      `registering against a dead database answered ${blockedRegister.status}`);
    const failures = server.logs.join('').split('Database migration failed').length - 1;
    assert.ok(failures >= 1, 'the migration did not even report a failure');
    notes.push(`erişilemeyen veritabanı: accountsEnabled=false, kayıt 503, ${failures} migration hatası loglandı`);

    // --- the database arrives -----------------------------------------------
    proxy = await startProxy(port, { host: target.hostname, port: Number(target.port || 5432) });

    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      if ((await config(server.url)).accountsEnabled) { ready = true; break; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
    assert.ok(ready,
      'the server never reached ready after the database became reachable — a slow database still needs a redeploy');

    // Ready has to mean usable, not just announced: this writes real rows.
    const username = `gelen${Date.now().toString().slice(-6)}`;
    const registered = await fetch(`${server.url}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'sifre123' }),
    });
    const body = await registered.json();
    assert.strictEqual(registered.status, 200, `register answered ${registered.status} after recovery`);
    assert.ok(body.token, 'recovery produced a working-looking API with no session token');

    const me = await fetch(`${server.url}/api/me`, { headers: { Authorization: `Bearer ${body.token}` } });
    assert.strictEqual(me.status, 200, `/api/me answered ${me.status} after recovery`);
    assert.strictEqual((await me.json()).player.username, username,
      'the account created after recovery did not read back');
    notes.push('veritabanı erişilebilir olunca aynı süreç READY oldu; kayıt ve /api/me gerçek satırlarla çalıştı');

    return notes.join(' · ');
  } finally {
    await server.stop();
    if (proxy) await proxy.stop();
  }
};

// Real PostgreSQL only: the point of this test is a real connection failing and
// then succeeding, which no stub can stand in for.
module.exports.needsDatabase = true;
