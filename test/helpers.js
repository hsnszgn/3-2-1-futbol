/**
 * Shared plumbing for the test suite.
 *
 * Tests run against the real server in a child process. That matters: the
 * bugs worth guarding against here are process-level (an uncaught exception
 * killing everyone's game), and an in-process require() would hide exactly
 * that failure mode.
 */
const { fork } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');

/**
 * Boots server/index.js on a free port with Wikidata mocked.
 *
 * @param {object} [env] extra environment variables for the child.
 */
async function startTestServer(env = {}) {
  // Port 0 means "whatever is free"; the fixture reports the port it actually
  // got. Picking a random number here used to collide with another test server
  // and surface as "server did not come up", which looks like a flaky test but
  // is really a broken harness.
  const requestedPort = env.PORT || '0';

  // Inheriting the caller's environment would hand the test server whatever
  // DATABASE_URL happens to be exported — including a production one. The
  // server runs migrations and a session purge at startup, so that is a write
  // to a live database, not a read. Tests start with NO database unless one is
  // passed in explicitly, and a test that needs one must name it.
  const inherited = { ...process.env };
  delete inherited.DATABASE_URL;

  // A test can ask for a fixture that makes one part of the server
  // controllable: AUTH_FIXTURE for the account lookup, or FIXTURE naming any
  // entry file in test/fixtures. Everything they do not control is the real
  // production path.
  const entryFile = env.FIXTURE || (env.AUTH_FIXTURE ? 'auth-server-entry.js' : 'server-entry.js');
  const entry = path.join(__dirname, 'fixtures', entryFile);

  const child = fork(entry, [], {
    cwd: ROOT,
    env: {
      ...inherited,
      // Explicit empty string: config/brand.js and db.js both read this, and an
      // absent key would let a parent shell value creep back in via any layer
      // that merges environments.
      DATABASE_URL: env.DATABASE_URL || '',
      PORT: String(requestedPort),
      NODE_ENV: env.NODE_ENV || 'test',
      // Limits exist to stop abuse, not to stop tests; each test drives one
      // client hard from a single address.
      RATE_API: '100000',
      RATE_REGISTER: '100000',
      RATE_LOGIN: '100000',
      RATE_ACCOUNT: '100000',
      RATE_DEBUG: '100000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const portReady = new Promise((resolve) => {
    child.on('message', (msg) => {
      if (msg && msg.type === 'listening') resolve(msg.port);
    });
  });

  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const port = await Promise.race([
    portReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('server never reported a port')), 15000)),
  ]);
  const url = `http://127.0.0.1:${port}`;
  await waitForHttp(`${url}/healthz`, 10000, () => exited);

  return {
    url,
    port,
    logs,
    /** Sends a control message to the fixture and waits for its acknowledgement. */
    control(message, ackType, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off('message', onMessage);
          reject(new Error(`fixture did not acknowledge "${ackType}"`));
        }, timeoutMs);
        function onMessage(msg) {
          if (msg && msg.type === ackType) {
            clearTimeout(timer);
            child.off('message', onMessage);
            resolve(msg);
          }
        }
        child.on('message', onMessage);
        if (message) child.send(message);
      });
    },
    /** Resolves with the first fixture message of this type. */
    nextMessage(type, timeoutMs = 10000) {
      return this.control(null, type, timeoutMs);
    },
    /** Collects fixture messages of a type as they arrive. */
    collect(type) {
      const seen = [];
      child.on('message', (msg) => {
        if (msg && msg.type === type) seen.push(msg);
      });
      return seen;
    },
    isAlive: () => !exited,
    exitInfo: () => exitInfo,
    async stop() {
      if (exited) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

/**
 * Waits until the server's account service is actually usable.
 *
 * /healthz answers as soon as the port is open, and the migration runs AFTER
 * that. Against a database that already has the schema it finishes in
 * milliseconds, so tests that registered an account straight away passed
 * everywhere — until CI ran them on a genuinely empty database, where creating
 * the schema takes long enough that the first register answered
 * 503 accounts_unavailable. Readiness is a thing to wait for, not to assume.
 */
async function waitForAccounts(server, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try {
      const res = await fetch(`${server.url}/api/config`);
      if (res.ok) ready = Boolean((await res.json()).accountsEnabled);
    } catch (err) {
      // not answering yet
    }
    if (ready) return;
    if (!server.isAlive()) throw new Error('server exited before accounts became ready');
    if (Date.now() > deadline) {
      throw new Error(`accounts never became ready within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForHttp(url, timeoutMs, hasExited) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hasExited && hasExited()) throw new Error('server exited before it was ready');
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not come up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.reconnection] keep the client alive across a
 *   dropped transport, so Socket.IO connection state recovery can be exercised.
 * @param {number} [options.reconnectionDelay] how long the client stays away
 *   before coming back. Tests that need the server to actually sit in its
 *   "waiting for the host" path have to keep the host away long enough for
 *   requests to pile up behind it.
 */
function connectClient(url, auth, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: Boolean(options.reconnection),
      reconnectionDelay: options.reconnectionDelay || 50,
      auth: auth || {},
    });
    // Submissions must name the attempt they were typed for, exactly as the real
    // client does, so tests track it the same way: the newest attempt seen on a
    // phase event. Without this every test would have to plumb the number by
    // hand, and one that forgot would silently be testing the protocol gate
    // instead of whatever it meant to test.
    socket.currentAttempt = -1;
    for (const event of ['openTeamSubmit', 'teamsRevealed', 'openGuess', 'phaseSync']) {
      socket.on(event, (payload) => {
        if (payload && typeof payload.attempt === 'number' && payload.attempt >= socket.currentAttempt) {
          socket.currentAttempt = payload.attempt;
        }
      });
    }

    const timer = setTimeout(() => reject(new Error('socket did not connect')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolves with the first payload of `event`, or rejects on timeout. */
function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, handler);
  });
}

/**
 * Waits for a phase event on EVERY socket, not just one.
 *
 * Each socket learns the current attempt from its own copy of the event, and
 * they do not arrive in lockstep. A test that waits on one player and then
 * submits for both will have the second submit an attempt it has not been told
 * about yet — which the server correctly refuses. The real client cannot have
 * this problem: a player cannot type into a phase their screen has not reached.
 */
function waitForAll(sockets, event, timeoutMs = 15000) {
  return Promise.all(sockets.map((s) => waitFor(s, event, timeoutMs)));
}

/**
 * Emits a submission stamped with the attempt this socket is currently on —
 * what the real client does in `submitTeam` / `submitGuess`.
 */
function submit(socket, event, payload = {}) {
  socket.emit(event, { ...payload, attempt: socket.currentAttempt });
}

/** Keeps expected server-side error logging out of the test output. */
function silenceConsole() {
  return () => {};
}

module.exports = { startTestServer, connectClient, waitFor, waitForAll, waitForHttp, waitForAccounts, submit, silenceConsole };
