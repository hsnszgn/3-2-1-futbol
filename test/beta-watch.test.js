/**
 * The independent watcher: an outage is reported WHILE the game is down.
 * Needs a real, isolated PostgreSQL.
 *
 * Everything here is a separate process: the game server (the real fixture),
 * the watcher (scripts/beta-watch.js, spawned exactly as a scheduler would run
 * it) and a local webhook receiver standing in for the alert channel. The game
 * is killed and NOT restarted before the alert is expected — that is the whole
 * difference from the in-process monitor, which can only report a crash from
 * the next process.
 *
 * Not proven here: delivery to a real channel, and the watcher running on a
 * different host from the game.
 */
const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { startTestServer, waitForAccounts } = require('./helpers');

const WATCH = path.join(__dirname, '..', 'scripts', 'beta-watch.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function receiver() {
  const received = [];
  const unreadable = [];
  let failWith = 0;
  let delayMs = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (failWith) { res.writeHead(failWith); res.end(); return; }
      try { received.push(JSON.parse(body)); } catch (err) { unreadable.push(body); }
      setTimeout(() => { res.writeHead(204); res.end(); }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    received,
    unreadable,
    fail(status) { failWith = status; },
    slow(ms) { delayMs = ms; },
    of: (kind) => received.filter((a) => a.kind === kind),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startWatcher(env, args = ['--interval-ms', '300']) {
  const child = spawn(process.execPath, [WATCH, ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const errors = [];
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  child.stderr.on('data', (d) => errors.push(String(d)));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  let closed = false;
  exited.then(() => { closed = true; });
  return {
    lines,
    errors,
    exited,
    // Safe to call twice: a watcher already gone resolves at once.
    stop: () => { if (!closed) child.kill('SIGTERM'); return exited; },
  };
}

async function until(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > deadline) return v;
    await sleep(100);
  }
}

module.exports = async function run({ databaseUrl }) {
  const notes = [];
  const db = new Client({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const reset = () => db.query('TRUNCATE telemetry_events, telemetry_reports RESTART IDENTITY CASCADE');
  const gameEnv = {
    DATABASE_URL: databaseUrl,
    TELEMETRY_ENABLED: '1',
    TELEMETRY_ENVIRONMENT: 'staging',
    TELEMETRY_HEARTBEAT_MS: '300',
    // the game's own monitor is kept quiet so every alert here is the watcher's
    BETA_ALERT_WEBHOOK_URL: '',
  };

  try {
    // --- 1. healthy, then killed and NOT restarted: alert during the outage --
    {
      await reset();
      const hook = await receiver();
      let game = await startTestServer(gameEnv);
      await waitForAccounts(game);
      const watchEnv = {
        REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '',
        BETA_WATCH_HEALTH_URL: `${game.url}/healthz`,
        BETA_ALERT_WEBHOOK_URL: hook.url,
        TELEMETRY_ENVIRONMENT: 'staging',
        TELEMETRY_HEARTBEAT_MS: '300',
        BETA_WATCH_GRACE_MS: '500',
      };
      const watcher = startWatcher(watchEnv);
      try {
        await sleep(1500);
        assert.deepStrictEqual(hook.received, [], `a healthy game raised alerts: ${JSON.stringify(hook.received)}`);
        assert.ok(watcher.lines.length >= 3, `the watcher ran ${watcher.lines.length} checks in 1.5 s`);

        await game.stop(); // SIGKILL — and it stays down
        const outage = await until(() => hook.of('service_outage').length && hook.of('service_outage'));
        assert.ok(outage, 'no alert while the game was down');
        assert.ok(/sağlık ucu/.test(outage[0].summary), `the outage summary does not say why: ${outage[0].summary}`);
        // Still down, several more checks: still exactly one alert.
        await sleep(1500);
        assert.strictEqual(hook.of('service_outage').length, 1,
          `one outage produced ${hook.of('service_outage').length} alerts`);
        assert.strictEqual(hook.of('service_recovered').length, 0);

        // Back up (a NEW port — the watcher is pointed at it as a deploy would).
        game = await startTestServer(gameEnv);
        await waitForAccounts(game);
        // The fixture binds a new port; the watcher is restarted with it, which
        // is also how a moved service would be picked up.
        await watcher.stop();
        const watcher2 = startWatcher({ ...watchEnv, BETA_WATCH_HEALTH_URL: `${game.url}/healthz` });
        try {
          const recovered = await until(() => hook.of('service_recovered').length && hook.of('service_recovered'));
          assert.ok(recovered, 'no recovery notice after the game came back');
          assert.strictEqual(recovered[0].key, `recovered:${outage[0].key}`, 'the recovery does not name its outage');
          await sleep(1200);
          assert.strictEqual(hook.of('service_recovered').length, 1, 'the recovery was announced more than once');
          assert.strictEqual(hook.of('service_outage').length, 1, 'a healthy game re-raised the old outage');

          // A second outage, after the first was closed, is a new incident.
          await game.stop();
          const second = await until(() => hook.of('service_outage').length === 2 && hook.of('service_outage'));
          assert.ok(second, 'a second outage after recovery raised nothing');
          assert.notStrictEqual(second[1].key, second[0].key, 'the second outage reused the closed one\'s key');
        } finally {
          await watcher2.stop();
        }
        assert.deepStrictEqual(hook.unreadable, []);
        notes.push('oyun sağlıklıyken izleyici 1,5 sn\'de alarm üretmedi; oyun SIGKILL ile öldürülüp YENİDEN BAŞLATILMADAN '
          + '"sağlık ucu" gerekçeli tek service_outage geldi, sonraki kontrollerde tekrar etmedi; oyun dönünce o kesintiyi '
          + 'adıyla kapatan tek service_recovered geldi; kapandıktan sonraki ikinci kesinti yeni anahtarla yeniden alarm verdi');
      } finally {
        await watcher.stop().catch(() => {});
        await game.stop();
        await hook.close();
      }
    }

    // --- 2. up, but the measurement stopped: stale heartbeats are an outage ----
    {
      await reset();
      const hook = await receiver();
      // Answers /healthz, but writes no heartbeats: measurement is off.
      const game = await startTestServer({ ...gameEnv, TELEMETRY_ENABLED: '' });
      try {
        await waitForAccounts(game);
        const code = await startWatcher({
          REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '',
          BETA_WATCH_HEALTH_URL: `${game.url}/healthz`, BETA_ALERT_WEBHOOK_URL: hook.url,
          TELEMETRY_ENVIRONMENT: 'staging', TELEMETRY_HEARTBEAT_MS: '300', BETA_WATCH_GRACE_MS: '500',
        }, ['--once']).exited;
        assert.strictEqual(code, 1, `--once with an outage exited ${code}`);
        const outage = hook.of('service_outage');
        assert.strictEqual(outage.length, 1);
        assert.ok(/kalp atışı/.test(outage[0].summary) && !/sağlık ucu/.test(outage[0].summary),
          `a live service with no heartbeats was reported as: ${outage[0].summary}`);
        notes.push('servis ayakta ama ölçüm yazmıyor (kalp atışı yok): --once çıkış 1 ve yalnız "kalp atışı" gerekçeli kesinti');
      } finally {
        await game.stop();
        await hook.close();
      }
    }

    // --- 2b. health failing while the process still writes heartbeats --------
    // The process is alive (heartbeats keep coming) but its health endpoint
    // fails. One incident, however many heartbeats pass while it lasts.
    {
      await reset();
      const hook = await receiver();
      const game = await startTestServer(gameEnv);
      const watcher = startWatcher({
        REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '',
        BETA_WATCH_HEALTH_URL: `${game.url}/no-such-endpoint`, BETA_ALERT_WEBHOOK_URL: hook.url,
        TELEMETRY_ENVIRONMENT: 'staging', TELEMETRY_HEARTBEAT_MS: '300', BETA_WATCH_GRACE_MS: '500',
      });
      try {
        await waitForAccounts(game);
        const first = await until(() => hook.of('service_outage').length);
        assert.ok(first, 'a failing health endpoint raised nothing');
        const beatsBefore = (await db.query(
          "SELECT count(*)::int AS n FROM telemetry_events WHERE event_type = 'telemetry_heartbeat'")).rows[0].n;
        await sleep(2000);
        const beatsAfter = (await db.query(
          "SELECT count(*)::int AS n FROM telemetry_events WHERE event_type = 'telemetry_heartbeat'")).rows[0].n;
        assert.ok(beatsAfter - beatsBefore >= 4, `only ${beatsAfter - beatsBefore} heartbeats in 2 s — the case is not exercised`);
        assert.strictEqual(hook.of('service_outage').length, 1,
          `one incident across ${beatsAfter - beatsBefore} heartbeats produced ${hook.of('service_outage').length} alerts`);
        assert.ok(/sağlık ucu: http_404/.test(hook.of('service_outage')[0].summary));
        notes.push(`süreç kalp atışı yazarken sağlık ucu 404: ${beatsAfter - beatsBefore} kalp atışı boyunca tek alarm`);
      } finally {
        await watcher.stop();
        await game.stop();
        await hook.close();
      }
    }

    // --- 3. the channel is down during a SHORT outage: the outbox delivers it --
    // The outage ends before the channel recovers. It is no longer detected by
    // then, so only the stored outbox can still report it — and the recovery
    // must follow it, not precede it.
    {
      await reset();
      const hook = await receiver();
      const port = String(await freePort());
      let game = await startTestServer({ ...gameEnv, PORT: port });
      await waitForAccounts(game);
      hook.fail(503);
      const watcher = startWatcher({
        REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '', BETA_WATCH_HEALTH_URL: `${game.url}/healthz`,
        BETA_ALERT_WEBHOOK_URL: hook.url, TELEMETRY_ENVIRONMENT: 'staging', TELEMETRY_HEARTBEAT_MS: '300',
        BETA_WATCH_GRACE_MS: '500', BETA_ALERT_RETRY_BASE_MS: '200',
      });
      try {
        await sleep(900);
        await game.stop();
        const failed = await until(async () => (await db.query(
          "SELECT count(*)::int AS n FROM telemetry_reports WHERE status = 'DELIVERY_FAILED' AND body->>'kind' = 'service_outage'")).rows[0].n);
        assert.ok(failed, 'the failed delivery was not recorded');
        // Back up on the same address while the channel is still down.
        game = await startTestServer({ ...gameEnv, PORT: port });
        await waitForAccounts(game);
        const healthy = await until(() => watcher.lines.slice(-1).some((l) => JSON.parse(l).healthy === true));
        assert.ok(healthy, 'the watcher never saw the game come back');
        assert.strictEqual(hook.received.length, 0);
        hook.fail(0);
        const got = await until(() => hook.of('service_recovered').length && hook.received);
        assert.ok(got, `the short outage was never reported: ${JSON.stringify(hook.received)}`);
        await sleep(1000);
        assert.deepStrictEqual(hook.received.map((a) => a.kind), ['service_outage', 'service_recovered'],
          'the outage and its recovery were not delivered once each, in order');
        notes.push('kesinti kanal 503 verirken başlayıp kanal düzelmeden bitti: DELIVERY_FAILED kaydedildi, '
          + 'kanal düzelince kesinti bir kez ve ondan SONRA kurtarma bildirimi teslim edildi');
      } finally {
        await watcher.stop();
        await game.stop();
        await hook.close();
      }
    }

    // --- 4. the watcher cannot reach the database ------------------------------
    {
      const hook = await receiver();
      try {
        const code = await startWatcher({
          REPORT_DATABASE_URL: 'postgres://postgres@127.0.0.1:59999/postgres', DATABASE_URL: '',
          BETA_WATCH_HEALTH_URL: 'http://127.0.0.1:59998/healthz', BETA_ALERT_WEBHOOK_URL: hook.url,
          TELEMETRY_ENVIRONMENT: 'staging',
        }, ['--once']).exited;
        assert.strictEqual(code, 2, `a watcher without its database exited ${code}`);
        assert.strictEqual(hook.of('watcher_db_unreachable').length, 1, 'the watcher failed silently');
        notes.push('izleyici veritabanına ulaşamayınca sessiz kalmadı: doğrudan watcher_db_unreachable, çıkış 2');
      } finally {
        await hook.close();
      }
    }

    // --- 4b. slow checks do not overlap ---------------------------------------
    // A channel that takes 1.5 s to accept and a health endpoint that takes
    // 1.2 s to say 503, checked every 300 ms. While one check's alert is still
    // in flight it is not recorded yet, so an overlapping check would find
    // "not sent yet" and send it again.
    {
      await reset();
      const hook = await receiver();
      hook.slow(1500);
      // Heartbeats stay fresh (a real game), so only the health endpoint fails —
      // and it starts failing after the watcher is already in its loop: the
      // first check is awaited on its own and cannot race anything.
      const game = await startTestServer(gameEnv);
      await waitForAccounts(game);
      const failFrom = Date.now() + 1500;
      const slow = http.createServer((req, res) => setTimeout(() => {
        res.writeHead(Date.now() >= failFrom ? 503 : 200); res.end();
      }, 1200));
      await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
      const watcher = startWatcher({
        REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '',
        BETA_WATCH_HEALTH_URL: `http://127.0.0.1:${slow.address().port}/healthz`, BETA_ALERT_WEBHOOK_URL: hook.url,
        TELEMETRY_ENVIRONMENT: 'staging', TELEMETRY_HEARTBEAT_MS: '300', BETA_WATCH_GRACE_MS: '500',
      });
      try {
        await sleep(7000);
        const outages = hook.of('service_outage');
        assert.ok(outages.length >= 1, 'a slow failing health endpoint raised nothing');
        assert.strictEqual(outages.length, 1, `overlapping checks sent one outage ${outages.length} times`);
        assert.ok(/http_503/.test(outages[0].summary));
        notes.push('1,5 sn\'de yanıt veren kanal ve 1,2 sn\'de 503 dönen sağlık ucu, 300 ms aralık: kontroller üst üste binmedi, tek alarm');
      } finally {
        await watcher.stop();
        await game.stop();
        slow.closeAllConnections();
        await new Promise((resolve) => slow.close(resolve));
        await hook.close();
      }
    }

    // --- 5. the channel test used during setup --------------------------------
    {
      const hook = await receiver();
      try {
        const base = { REPORT_DATABASE_URL: '', DATABASE_URL: '', TELEMETRY_ENVIRONMENT: 'staging' };
        const ok = await startWatcher({ ...base, BETA_ALERT_WEBHOOK_URL: hook.url }, ['--test-alert']).exited;
        assert.strictEqual(ok, 0, `a delivered test alert exited ${ok}`);
        assert.strictEqual(hook.of('watch_test').length, 1);
        hook.fail(500);
        const bad = await startWatcher({ ...base, BETA_ALERT_WEBHOOK_URL: hook.url }, ['--test-alert']).exited;
        assert.strictEqual(bad, 1, 'a refused test alert reported success');
        const none = await startWatcher({ ...base, BETA_ALERT_WEBHOOK_URL: '' }, ['--test-alert']).exited;
        assert.strictEqual(none, 1, 'a test alert with no channel reported success');
        const plain = await startWatcher({ ...base, BETA_ALERT_WEBHOOK_URL: 'http://alerts.example.com/hook' }, ['--test-alert']).exited;
        assert.strictEqual(plain, 1, 'a clear-text remote channel was accepted');
        notes.push('--test-alert: teslimde çıkış 0; kanal 500, kanal yok veya uzak http:// adreste çıkış 1');
      } finally {
        await hook.close();
      }
    }
  } finally {
    await db.end().catch(() => {});
  }
  return notes.join(' · ');
};

module.exports.needsDatabase = true;
