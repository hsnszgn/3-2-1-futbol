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
  const port = 4000 + Math.floor(Math.random() * 1000);
  const child = fork(path.join(__dirname, 'fixtures', 'server-entry.js'), [], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
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

  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const url = `http://127.0.0.1:${port}`;
  await waitForHttp(`${url}/healthz`, 10000, () => exited);

  return {
    url,
    port,
    logs,
    isAlive: () => !exited,
    exitInfo: () => exitInfo,
    async stop() {
      if (exited) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
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

function connectClient(url, auth) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: auth || {},
    });
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

/** Keeps expected server-side error logging out of the test output. */
function silenceConsole() {
  return () => {};
}

module.exports = { startTestServer, connectClient, waitFor, waitForHttp, silenceConsole };
