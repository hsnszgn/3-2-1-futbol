/**
 * The account client's state machine, driven directly.
 *
 * The browser spec (test/browser/account-readiness.spec.js) covers the path a
 * player actually walks: service down, service back, card returns. What it cannot
 * drive is the awkward half of the state machine — a fetch that REJECTS instead
 * of answering, and a retry budget that has to run out. Both need controlled HTTP
 * and controlled clocks, so they are driven here against the real production
 * file, with a minimal DOM.
 *
 * SCOPE, deliberately stated: this is not a browser test and does not replace
 * one. Nothing here proves anything about rendering, layout or real fetch
 * semantics; it proves what the state machine does with a given sequence of
 * answers. Two bugs it now guards were both invisible to the browser spec:
 *
 *   1. fetch() rejects on a network failure rather than returning a status. That
 *      rejection propagated out of init(), so no button listener was bound and no
 *      recheck was ever scheduled — the page could only come back by reloading,
 *      which is precisely what the recovery work removed.
 *   2. /api/config answering "ready" reset the retry budget even when /api/me
 *      then failed, so the backoff never grew past its first step and the
 *      20-attempt limit was never reached: an endless 3-second poll.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'accounts.js'), 'utf8');

/**
 * Loads the real accounts.js with controlled HTTP, storage and clocks.
 * Timers are collected rather than run, so the backoff can be inspected and
 * stepped without waiting out half a minute of real delays.
 */
function harness({ fetch, token = '' }) {
  const timers = new Map();
  // Every timer ever asked for, and whether it was cancelled. api() sets a
  // request timeout and always clears it, so the ones that survive are the
  // rechecks — which is what the backoff assertions are about. Counting all of
  // them made a 20-attempt budget read as 62.
  const scheduled = [];
  const nodes = new Map();
  let nextTimer = 0;
  let stored = token;

  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      const listeners = new Map();
      nodes.set(id, {
        textContent: '', value: '', style: {}, disabled: false, listeners,
        addEventListener(event, fn) { listeners.set(event, fn); },
        click() { const fn = listeners.get('click'); return fn && fn(); },
        classList: {
          toggle(name, on) { const yes = on === undefined ? !classes.has(name) : on; if (yes) classes.add(name); else classes.delete(name); },
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains(name) { return classes.has(name); },
        },
      });
    }
    return nodes.get(id);
  }

  const context = vm.createContext({
    window: {},
    document: { getElementById: node },
    localStorage: {
      getItem: () => stored,
      setItem: (_k, v) => { stored = v; },
      removeItem: () => { stored = ''; },
    },
    fetch,
    console,
    showScreen() {},
    AbortController,
    setTimeout(fn, ms) {
      const id = ++nextTimer;
      timers.set(id, fn);
      scheduled.push({ id, ms, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
      const entry = scheduled.find((t) => t.id === id);
      if (entry) entry.cancelled = true;
    },
  });
  vm.runInContext(SOURCE, context);

  return {
    node,
    timers,
    /** Delays of the timers that were not cancelled: the recheck backoff. */
    get delays() { return scheduled.filter((t) => !t.cancelled).map((t) => t.ms); },
    run: (code) => vm.runInContext(code, context),
    storedToken: () => stored,
    /** Fires the oldest pending timer and lets its promises settle. */
    async tick() {
      const entry = timers.entries().next().value;
      if (!entry) throw new Error('no timer was scheduled');
      const [id, fn] = entry;
      timers.delete(id);
      fn();
      await new Promise(setImmediate);
    },
  };
}

const answer = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

module.exports = async function run() {
  const notes = [];

  // --- 1. the ordinary path still works ------------------------------------
  // The control. Without it, the two failure cases below could pass on a client
  // that never recovers from anything at all.
  {
    let ready = false;
    const app = harness({ fetch: async () => answer(200, { accountsConfigured: true, accountsEnabled: ready }) });
    await app.run('Accounts.init()');
    assert.strictEqual(app.run('Accounts.getStatus()'), 'unavailable',
      'a configured-but-unready service was not reported as temporary');
    ready = true;
    await app.tick();
    assert.strictEqual(app.run('Accounts.isEnabled()'), true,
      'the client never came back after the service became ready');
    notes.push('kontrol: unavailable → ready geçişi zamanlayıcıyla kendiliğinden oldu');
  }

  // --- 2. a network failure is retryable, not a verdict ---------------------
  {
    let failing = true;
    let calls = 0;
    const app = harness({
      fetch: async () => {
        calls += 1;
        if (failing) throw new TypeError('Failed to fetch');
        return answer(200, { accountsConfigured: true, accountsEnabled: true });
      },
    });

    // init() must not reject, whatever the network does.
    await app.run('Accounts.init()');
    assert.strictEqual(app.run('Accounts.getStatus()'), 'unavailable',
      'a network failure was treated as "this deployment has no accounts"');
    assert.strictEqual(app.timers.size, 1,
      'no recheck was scheduled after a network failure');
    // The retry button is the way out of exactly this situation, so it must be
    // wired up even though the first request never landed.
    assert.ok(app.node('btnAccountRetry').listeners.has('click'),
      'the retry button was left inert because the first request failed');
    assert.ok(app.node('accountNoticeText').textContent.length > 10,
      'nothing was said to the player about the outage');

    // And it recovers from it.
    failing = false;
    await app.tick();
    assert.strictEqual(app.run('Accounts.isEnabled()'), true,
      'the client did not recover once the network came back');
    notes.push(`ağ reddi retry edilebilir duruma çevrildi (init reddetmiyor, buton bağlı, ${calls} istekte toparlandı)`);
  }

  // --- 3. the retry budget is finite, and the backoff really grows ----------
  // The loop this guards: config says ready, /api/me says 503, and the reset on
  // "ready" handed the budget back every single time.
  {
    const app = harness({
      token: 'saklanan-jeton',
      fetch: async (url) => (url === '/api/config'
        ? answer(200, { accountsConfigured: true, accountsEnabled: true })
        : answer(503, { reason: 'accounts_unavailable' })),
    });
    await app.run('Accounts.init()');
    for (let i = 0; i < 60 && app.timers.size; i += 1) await app.tick();

    assert.strictEqual(app.timers.size, 0,
      'the client is still scheduling rechecks after its budget should have run out');
    assert.strictEqual(app.delays.length, 20,
      `the retry limit was not honoured: ${app.delays.length} attempts were scheduled`);
    assert.deepStrictEqual([...new Set(app.delays)], [3000, 6000, 12000, 24000, 30000],
      `the backoff did not grow: ${JSON.stringify([...new Set(app.delays)])}`);
    // An outage is not a sign-out.
    assert.strictEqual(app.storedToken(), 'saklanan-jeton',
      'a failing account endpoint threw the stored session away');
    assert.strictEqual(app.run('Accounts.getStatus()'), 'unavailable',
      'the client claimed the service was ready while the account endpoint was failing');

    // The manual button starts a fresh budget — that is a person asking, not a loop.
    app.node('btnAccountRetry').click();
    await new Promise(setImmediate);
    assert.ok(app.timers.size >= 1, 'the manual retry did not start a new attempt');
    notes.push(`config hazır + /api/me 503: tam 20 deneme, gecikmeler ${[...new Set(app.delays)].join('/')}ms, jeton korundu, manuel tekrar yeni bütçe açıyor`);
  }

  return notes.join(' · ');
};
