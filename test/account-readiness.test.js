/**
 * "We have a connection string" is not "this works".
 *
 * These were the same check. A migration that failed left the server
 * announcing that accounts were available: the sign-up form appeared, and every
 * attempt to use it failed against tables that were not there. The player got a
 * broken feature instead of an absent one, which is worse — an absent feature
 * at least tells you where you stand.
 *
 * The second half is the outage case. A database that has gone away must make
 * requests FAIL, not hang: a page that never finishes loading says nothing
 * about what is wrong, and the game itself does not need the database at all.
 */
const assert = require('assert');
const { startTestServer, connectClient, waitFor, waitForAll, submit } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A database address that resolves but refuses connections. */
const DEAD_DB = 'postgres://nobody@127.0.0.1:1/yok';

async function config(server) {
  const res = await fetch(`${server.url}/api/config`);
  assert.strictEqual(res.status, 200, `/api/config answered ${res.status}`);
  return res.json();
}

module.exports = async function run() {
  const notes = [];

  // --- 1. no database at all: accounts are simply absent --------------------
  {
    const server = await startTestServer();
    try {
      const cfg = await config(server);
      assert.strictEqual(cfg.accountsEnabled, false, 'accounts announced without a database');
      assert.strictEqual(cfg.accountsConfigured, false, 'a server with no database reported one');

      const me = await fetch(`${server.url}/api/me`, { headers: { Authorization: 'Bearer x' } });
      assert.strictEqual(me.status, 503, `expected 503, got ${me.status}`);
      assert.strictEqual((await me.json()).reason, 'accounts_disabled',
        'an unconfigured server should say accounts are disabled, not broken');

      notes.push('veritabanı yok: accountsEnabled=false, /api/me 503 "accounts_disabled"');
    } finally {
      await server.stop();
    }
  }

  // --- 2. configured but unreachable: broken, and it says so ----------------
  {
    const server = await startTestServer({ DATABASE_URL: DEAD_DB });
    try {
      const cfg = await config(server);
      assert.strictEqual(cfg.accountsEnabled, false,
        'a server whose migration failed still announced working accounts');
      assert.strictEqual(cfg.accountsConfigured, true,
        'the server should admit a database is configured');

      // Refused, and distinguishable from "never set up".
      const started = Date.now();
      const me = await fetch(`${server.url}/api/me`, { headers: { Authorization: 'Bearer x' } });
      const took = Date.now() - started;
      assert.strictEqual(me.status, 503, `expected 503, got ${me.status}`);
      assert.strictEqual((await me.json()).reason, 'accounts_unavailable',
        'a broken database should be distinguishable from an absent one');
      assert.ok(took < 8000, `the request took ${took}ms — an outage must fail, not hang`);

      // Registering is refused the same way, rather than erroring deep inside.
      const reg = await fetch(`${server.url}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'deneme', password: 'sifre123' }),
      });
      assert.strictEqual(reg.status, 503, `register answered ${reg.status}`);

      notes.push(`bağlanamayan veritabanı: accountsEnabled=false / accountsConfigured=true, istek ${took}ms içinde 503 "accounts_unavailable"`);
    } finally {
      await server.stop();
    }
  }

  // --- 3. the game itself is untouched by any of it -------------------------
  // Accounts are a feature of the game, not a prerequisite for it. With the
  // database broken, two guests must still be able to play a full round.
  {
    const server = await startTestServer({ DATABASE_URL: DEAD_DB, MAX_ROUNDS: '1' });
    try {
      const [a, b] = await Promise.all([connectClient(server.url), connectClient(server.url)]);
      const matched = Promise.all([waitFor(a, 'matched', 8000), waitFor(b, 'matched', 8000)]);
      a.emit('joinQueue', { name: 'Ali' });
      b.emit('joinQueue', { name: 'Veli' });
      await matched;

      await waitForAll([a, b], 'openTeamSubmit', 15000);
      const accepted = Promise.all([waitFor(a, 'teamAccepted', 8000), waitFor(b, 'teamAccepted', 8000)]);
      submit(a, 'submitTeam', { team: 'Chelsea' });
      submit(b, 'submitTeam', { team: 'Liverpool' });
      await accepted;
      await waitForAll([a, b], 'openGuess', 15000);

      const over = Promise.all([waitFor(a, 'gameOver', 20000), waitFor(b, 'gameOver', 20000)]);
      submit(a, 'submitGuess', { guess: 'Mohamed Salah' });
      await over;

      assert.ok(server.isAlive(), 'the server died playing without a database');
      notes.push('veritabanı bozukken misafir maçı baştan sona oynandı');
      a.close();
      b.close();
    } finally {
      await server.stop();
    }
  }

  // --- 4. and it heals: the migration is retried ----------------------------
  // A database that is slow to accept connections at deploy time used to
  // disable accounts until somebody redeployed. It is retried instead — checked
  // here by watching a server with a fast retry interval keep trying rather
  // than giving up after the first failure.
  {
    const server = await startTestServer({ DATABASE_URL: DEAD_DB, MIGRATE_RETRY_MS: '400' });
    try {
      await sleep(2500);
      const attempts = server.logs.join('').split('Database migration failed').length - 1;
      assert.ok(attempts >= 2,
        `the migration was attempted ${attempts} time(s); a transient failure must be retried`);
      assert.ok(server.isAlive(), 'retrying the migration killed the server');

      notes.push(`geçici hata sonrası migration yeniden deneniyor (${attempts} deneme gözlendi)`);
    } finally {
      await server.stop();
    }
  }

  // --- 5. the debug token is accepted in a header only ----------------------
  // It also accepted ?key=<token>. A secret in a URL is written to server logs,
  // kept in browser history, and sent onward in the Referer header — which is
  // exactly why this project already refused to carry session tokens that way.
  {
    const server = await startTestServer({ NODE_ENV: 'production', DEBUG_TOKEN: 'gizli-jeton' });
    try {
      const hidden = await fetch(`${server.url}/debug/snapshot`);
      assert.strictEqual(hidden.status, 404, `unauthenticated debug answered ${hidden.status}`);

      const viaQuery = await fetch(`${server.url}/debug/snapshot?key=gizli-jeton`);
      assert.strictEqual(viaQuery.status, 404,
        `the token still works in the query string (${viaQuery.status})`);

      const viaHeader = await fetch(`${server.url}/debug/snapshot`, {
        headers: { 'X-Debug-Token': 'gizli-jeton' },
      });
      assert.strictEqual(viaHeader.status, 200, `the header token was refused (${viaHeader.status})`);

      const wrongHeader = await fetch(`${server.url}/debug/snapshot`, {
        headers: { 'X-Debug-Token': 'yanlis' },
      });
      assert.strictEqual(wrongHeader.status, 404, 'a wrong token was accepted');

      notes.push('debug jetonu yalnızca başlıkta: ?key= 404, başlık 200, yanlış jeton 404');
    } finally {
      await server.stop();
    }
  }

  return notes.join(' · ');
};
