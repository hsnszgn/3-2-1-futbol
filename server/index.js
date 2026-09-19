const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const { resolveTeam, normalize } = require('./data/teams');
const { matchPlayerName } = require('./gameLogic');
const { getCommonPlayers, resolveTeamByName, prefetchSquad } = require('./wikidata');
const squadStore = require('./squadStore');
const db = require('./db');
const accounts = require('./accounts');
const { createLimiter } = require('./rateLimit');
const brand = require('../config/brand');

// The local alias list handles the common cases instantly ("Man United",
// "GS"); anything it doesn't know — a club nobody added, or a Turkish name
// like "Marsilya" — is resolved live against Wikidata rather than rejected.
async function resolveTeamInput(text) {
  return resolveTeam(text) || resolveTeamByName(text);
}

function sameTeam(a, b) {
  return a.id === b.id || normalize(a.display) === normalize(b.display);
}

const PORT = process.env.PORT || 3000;
// Five rounds is the game. It is configurable only so tests can reach the
// end-game state (rematch, final score) without playing five full rounds.
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS) || 5;
// The phase lengths. Configurable only so tests can drive the timing paths —
// a window closing while an answer is still in flight is a real race, and
// waiting out the production clock to reach it would make the test unusable.
// The defaults are the game.
const TEAM_SUBMIT_MS = Number(process.env.TEAM_SUBMIT_MS) || 12000;
const PLAYER_GUESS_MS = Number(process.env.PLAYER_GUESS_MS) || 25000;
const NEXT_ROUND_DELAY_MS = Number(process.env.NEXT_ROUND_DELAY_MS) || 3500;
const RECONNECT_GRACE_MS = 12000;

// Everyone scoring a flat point wasted the tension of a speed game: knowing
// the answer instantly and dredging it up at the last second paid the same.
// Points now fall off with the clock, which also keeps a 0-3 game alive.
const SPEED_TIERS = [
  { withinMs: 5000, points: 3 },
  { withinMs: 12000, points: 2 },
];
const BASE_POINTS = 1;
// The reveal animation runs before anyone can type, so the speed clock starts
// after it. The server owns this number and tells the client when the guess
// window opens; the client no longer keeps its own copy to drift out of sync.
const REVEAL_HOLD_MS = 1600;

function pointsForSpeed(elapsedMs) {
  const tier = SPEED_TIERS.find((t) => elapsedMs <= t.withinMs);
  return tier ? tier.points : BASE_POINTS;
}

const app = express();

// Render terminates TLS in front of us, so without this every request looks
// like it came from the proxy and one person's flood would rate-limit everyone.
app.set('trust proxy', 1);

// Nothing here accepts anything but a small JSON object.
app.use(express.json({ limit: '8kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  // Invite links carry a room code; don't hand it to whatever is linked next.
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  // Everything the page loads is either ours or Google Fonts; nothing else may
  // run, and nothing may frame us.
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

// --- branding ---------------------------------------------------------------
// The name will change. Rather than a build step, the page is served with the
// brand injected, so every client file reads one object instead of a literal.
const BRAND_FOR_CLIENT = {
  name: brand.name,
  shortName: brand.shortName,
  tagline: brand.tagline,
  description: brand.description,
  storageKeys: brand.storageKeys,
  supportEmail: brand.supportEmail,
  themeColor: brand.themeColor,
};

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');
let indexCache = null;
function renderIndex() {
  if (indexCache) return indexCache;
  const raw = fs.readFileSync(INDEX_PATH, 'utf8');
  indexCache = raw
    .replace(/\{\{BRAND_NAME\}\}/g, brand.name)
    .replace(/\{\{BRAND_DESCRIPTION\}\}/g, brand.description)
    .replace(/\{\{BRAND_THEME_COLOR\}\}/g, brand.themeColor)
    .replace(/\{\{BRAND_LOCALE\}\}/g, brand.locale)
    .replace(/\{\{BRAND_URL\}\}/g, brand.siteUrl)
    .replace(/\{\{BRAND_JSON\}\}/g, JSON.stringify(BRAND_FOR_CLIENT).replace(/</g, '\\u003c'));
  return indexCache;
}

/**
 * Wraps an async route so a rejected promise becomes a response.
 *
 * Express 4 does not catch a rejection from an async handler: it is an
 * unhandled rejection, and the request is simply never answered. The client
 * waits until its own timeout, which is indistinguishable from the server being
 * down — a UNIQUE violation inside account deletion used to hang the request for
 * minutes rather than failing it.
 */
const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

app.get('/', (req, res) => res.type('html').send(renderIndex()));

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: brand.name,
    short_name: brand.shortName,
    description: brand.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: brand.backgroundColor,
    theme_color: brand.themeColor,
    lang: brand.locale,
    categories: ['games', 'sports'],
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});

app.get('/robots.txt', (req, res) => {
  res.type('text').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /debug/\nSitemap: ${brand.siteUrl}/sitemap.xml\n`);
});

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// Registration is the expensive one to abuse (it creates rows), login is the
// one worth guessing at, and the debug endpoints each fire live Wikidata
// queries. The general limit is loose enough that normal play never sees it,
// and registration is deliberately generous: a group of friends signing up
// from one wifi within an hour is the normal case here, not abuse.
const envInt = (name, fallback) => Number(process.env[name]) || fallback;
const limitApi = createLimiter('api', envInt('RATE_API', 120), 60 * 1000);
const limitRegister = createLimiter('register', envInt('RATE_REGISTER', 15), 60 * 60 * 1000);
const limitLogin = createLimiter('login', envInt('RATE_LOGIN', 12), 15 * 60 * 1000);
const limitLoginUser = createLimiter('login-user', envInt('RATE_LOGIN_USER', 8), 15 * 60 * 1000);
// Account export and deletion get their own budget. Sharing the login limiter
// meant somebody else fumbling their password on the same network could stop
// you deleting your own account — a right that must not be rate-limited away.
const limitAccount = createLimiter('account', envInt('RATE_ACCOUNT', 10), 15 * 60 * 1000);
const limitDebug = createLimiter('debug', envInt('RATE_DEBUG', 20), 60 * 1000);

// The debug endpoints each fire live Wikidata queries under our User-Agent and
// expose internal lookup state. Open to the world, they are both an
// information leak and a way to get our IP throttled by Wikidata. In
// production they exist only for whoever holds DEBUG_TOKEN.
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
function requireDebugAccess(req, res, next) {
  if (!IS_PRODUCTION) return next();
  if (DEBUG_TOKEN && req.get('x-debug-token') === DEBUG_TOKEN) return next();
  if (DEBUG_TOKEN && req.query.key === DEBUG_TOKEN) return next();
  return res.status(404).type('text').send('Not found');
}

app.use('/api', limitApi);

// --- accounts, stats, leaderboard -------------------------------------------
// All of these answer 503 when DATABASE_URL isn't set, so the game itself
// keeps working with accounts simply switched off.
function requireDb(res) {
  if (db.isEnabled()) return true;
  res.status(503).json({ reason: 'accounts_disabled' });
  return false;
}

app.post('/api/register', limitRegister, wrap(async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { username, password, displayName } = req.body || {};
    const result = await accounts.register(username, password, displayName);
    if (!result.ok) return res.status(400).json({ reason: result.reason });
    res.json({ token: result.token, username: result.player.username, displayName: result.player.display_name });
  } catch (err) {
    console.error('register failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
}));

app.post('/api/login', limitLogin, wrap(async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { username, password } = req.body || {};
    // Also limit attempts per account, so spreading them over many IPs does
    // not turn into an unlimited guess at one person's password. Only wrong
    // answers count, so signing in often is never what locks you out.
    const account = String(username || '').trim().toLowerCase();
    const allowed = limitLoginUser.check(account);
    if (!allowed.ok) {
      res.set('Retry-After', String(Math.ceil(allowed.retryAfterMs / 1000)));
      return res.status(429).json({ reason: 'rate_limited', retryAfterMs: allowed.retryAfterMs });
    }
    const result = await accounts.login(username, password);
    if (!result.ok) {
      limitLoginUser.take(account);
      return res.status(401).json({ reason: result.reason });
    }
    res.json({ token: result.token, username: result.player.username, displayName: result.player.display_name });
  } catch (err) {
    console.error('login failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
}));

// The token travels in a header, not the query string: URLs end up in server
// logs, browser history and Referer headers.
function tokenFrom(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

app.get('/api/me', wrap(async (req, res) => {
  if (!requireDb(res)) return;
  const player = await accounts.playerForToken(tokenFrom(req));
  if (!player) return res.status(401).json({ reason: 'not_signed_in' });
  res.json({ player: await accounts.profile(player.username) });
}));

// Data portability and erasure. Both require the password again: a stolen
// token should not be enough to download someone's history or wipe them out.
app.post('/api/account/export', limitAccount, wrap(async (req, res) => {
  if (!requireDb(res)) return;
  const player = await accounts.playerForToken(tokenFrom(req));
  if (!player) return res.status(401).json({ reason: 'not_signed_in' });
  // Checked without signing in again: login() mints a session, so asking to
  // export your own data used to leave an extra live token behind.
  if (!(await accounts.verifyCredentials(player.id, (req.body || {}).password))) {
    return res.status(403).json({ reason: 'bad_credentials' });
  }
  const data = await accounts.exportAccount(player.id);
  if (!data) return res.status(404).json({ reason: 'not_found' });
  res.set('Content-Disposition', `attachment; filename="${player.username}-verilerim.json"`);
  res.json(data);
}));

app.post('/api/account/delete', limitAccount, wrap(async (req, res) => {
  if (!requireDb(res)) return;
  const player = await accounts.playerForToken(tokenFrom(req));
  if (!player) return res.status(401).json({ reason: 'not_signed_in' });
  if (!(await accounts.verifyCredentials(player.id, (req.body || {}).password))) {
    return res.status(403).json({ reason: 'bad_credentials' });
  }
  const done = await accounts.deleteAccount(player.id);
  if (!done) return res.status(404).json({ reason: 'not_found' });
  // The account is gone; nothing holding its identity may keep using it.
  revokeAccountSockets({ playerId: player.id });
  console.log(`account deleted: id=${player.id}`);
  res.json({ ok: true });
}));

app.post('/api/logout', wrap(async (req, res) => {
  if (!requireDb(res)) return;
  const token = tokenFrom(req);
  await accounts.endSession(token);
  // Signing out has to reach the game, not just the database and this tab.
  revokeAccountSockets({ token });
  res.json({ ok: true });
}));

app.get('/api/leaderboard', wrap(async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({ entries: await accounts.leaderboard(50), tiers: accounts.TIERS });
  } catch (err) {
    console.error('leaderboard failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
}));

app.get('/api/profile/:username', wrap(async (req, res) => {
  if (!requireDb(res)) return;
  const stats = await accounts.profile(req.params.username);
  if (!stats) return res.status(404).json({ error: 'not_found' });
  res.json(stats);
}));

app.get('/api/config', (req, res) => {
  res.json({
    accountsEnabled: db.isEnabled(),
    minPasswordLength: accounts.MIN_PASSWORD_LENGTH,
    tiers: accounts.TIERS,
    activityRanks: accounts.ACTIVITY_RANKS,
    points: accounts.POINTS,
  });
});

// Cheap endpoint for an uptime pinger to hit. Render's free tier sleeps after
// 15 minutes idle and then takes ~40s to wake, which is long enough that an
// invited friend gives up before the page loads.
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Did the deploy-time squad build actually produce anything? Answers that in
// one look, without having to read build logs.
app.get('/debug/snapshot', requireDebugAccess, limitDebug, (req, res) => {
  res.json(squadStore.info());
});

// Diagnostics for a single matchup, e.g.
//   /debug/lookup?a=Inter Milan&b=AC Milan
//   /debug/lookup?a=Fenerbahce&b=Lazio&guess=Vedat Muriqi
// Shows whether the answer came from the shipped snapshot or a live lookup,
// which Wikidata items each club name resolved to, and what the common player
// list actually contains — so a "that player should have counted" report can
// be checked against real data instead of guessed at.
app.get('/debug/lookup', requireDebugAccess, limitDebug, wrap(async (req, res) => {
  const [teamA, teamB] = await Promise.all([
    resolveTeamInput(req.query.a),
    resolveTeamInput(req.query.b),
  ]);
  if (!teamA || !teamB) {
    res.status(400).json({
      error: 'unknown_team_name',
      resolvedA: teamA ? teamA.display : null,
      resolvedB: teamB ? teamB.display : null,
    });
    return;
  }

  const lookup = await getCommonPlayers(teamA, teamB);
  const guess = req.query.guess;
  res.json({
    ok: lookup.ok,
    reason: lookup.reason,
    resolvedTeams: { a: teamA, b: teamB },
    debug: lookup.debug,
    guess: guess || undefined,
    guessMatched: guess && lookup.ok ? matchPlayerName(guess, lookup.players) : undefined,
    snapshotLoaded: squadStore.info().loaded,
    players: lookup.ok ? lookup.players.map((p) => p.name) : undefined,
  });
}));

/**
 * The last word on any request that threw.
 *
 * Installed after every route, which is how Express finds it. Without it a
 * handler that throws answers nothing at all, and the message it would have
 * leaked is a stack trace — so the log gets the detail and the client gets a
 * status and a reason it can act on.
 */
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
app.use((err, req, res, next) => {
  console.error(`unhandled error on ${req.method} ${req.path}:`, err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'server_error' });
});

const server = http.createServer(app);
// Mobile connections drop and reconnect constantly (keyboard focus changes,
// backgrounding the tab, brief network blips). Without this, a reconnect gets
// a fresh socket.id/data, the server can no longer find the player's room,
// and every subsequent submitTeam/submitGuess silently no-ops. This restores
// the socket's id, rooms, and `data` (roomId, name) transparently on any
// reconnect within the window, so gameplay just continues.
const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  // Nothing this game sends is large. The default 1 MB ceiling is an open
  // invitation to push megabytes of junk at the parser.
  maxHttpBufferSize: 16 * 1024,
});

// --- socket event safety ----------------------------------------------------
// Everything arriving on a socket is attacker-controlled and unauthenticated.
// Two things follow from that.
//
// First, a payload is whatever the client felt like sending: null, a number, a
// string, an array. Destructuring it directly throws, and a default parameter
// (`= {}`) does NOT cover null, so every handler gets a normalised object.
//
// Second, a throw inside a handler is not caught by Socket.IO. It becomes an
// uncaughtException, and the process-level policy then takes the whole server
// down — every other game in progress with it. One bad client must only ever
// break its own connection.
const asPayload = (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});

function onSocketEvent(socket, event, handler) {
  socket.on(event, (raw) => {
    const fail = (err) => {
      console.error(`socket "${event}" failed for ${socket.id}:`, err && err.message);
    };
    const payload = asPayload(raw);
    const run = () => {
      let result;
      try {
        result = handler(payload);
      } catch (err) {
        fail(err);
        return;
      }
      // An async handler rejects long after the try/catch has returned.
      if (result && typeof result.then === 'function') result.then(undefined, fail);
    };

    // A recovered connection arrives carrying the identity it had before it
    // dropped, and that identity has to be re-checked. Until the check finishes,
    // nothing this connection asks for may run: starting the check and letting
    // the socket carry on meant a revoked account could queue, host and be
    // matched under its old name in the milliseconds before the answer came
    // back — and the check is a database round trip, so that window is real.
    if (socket.data.authPending) {
      socket.data.authPending.then(run, run);
      return;
    }
    run();
  });
}

/** Free-text from a client: strings only, control characters stripped. */
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

// Runs before 'connection', so socket.data.account is already there when the
// first joinQueue arrives. Recovered connections skip this and keep the data
// they had.
// One person with a script could otherwise open hundreds of sockets and fill
// the quick-match queue with ghosts. The cap is well above what a household
// or an office behind one address would ever need.
const MAX_SOCKETS_PER_IP = 25;

// Team names go on to build a Wikidata search URL, so their length is bounded
// before they ever travel.
const MAX_INPUT_LENGTH = 64;
const cleanInput = (value) => cleanText(value, MAX_INPUT_LENGTH);

// A rejected team costs two Wikidata searches and does not end the round, so a
// client could sit there spamming misses. Each socket gets a budget per round.
const MAX_TEAM_ATTEMPTS_PER_ROUND = 8;
const socketsPerIp = new Map();

const ipOf = (socket) => (socket.handshake.headers['x-forwarded-for'] || '')
  .split(',')[0].trim() || socket.handshake.address || 'unknown';

io.use((socket, next) => {
  const ip = ipOf(socket);
  const open = socketsPerIp.get(ip) || 0;
  if (open >= MAX_SOCKETS_PER_IP) return next(new Error('too_many_connections'));
  socketsPerIp.set(ip, open + 1);
  socket.once('disconnect', () => {
    const left = (socketsPerIp.get(ip) || 1) - 1;
    if (left > 0) socketsPerIp.set(ip, left);
    else socketsPerIp.delete(ip);
  });
  next();
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (token) {
      socket.data.sessionToken = String(token);
      socket.data.account = await accounts.playerForToken(token);
    }
  } catch (err) {
    console.error('session lookup failed:', err.message);
  }
  next();
});

/** @type {Map<string, {id: string, players: Object[], round: number, scores: Object, state: string, teamSubs: Object, timer: any}>} */
const rooms = new Map();
const queue = []; // socket ids waiting for random match
const codeRooms = new Map(); // room code -> { hostSocketId, createdAt }

// An invite has to outlive the act of sending it: tapping share backgrounds
// the browser and drops the host's socket, so anything tied to "host is
// connected right now" would delete the code before the friend ever taps it.
const INVITE_TTL_MS = 30 * 60 * 1000;
const HOST_WAIT_MS = 8000;

function waitForConnectedSocket(socketId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.connected) return resolve(s);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, 400);
    };
    poll();
  });
}

// Codes are kept across disconnects, so they need sweeping instead.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of codeRooms) {
    if (now - entry.createdAt > INVITE_TTL_MS) codeRooms.delete(code);
  }
}, 5 * 60 * 1000).unref();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/**
 * Every intent to enter a match carries a version.
 *
 * Joining an invite waits for the host, which can take seconds. In that window
 * the player may send a second join, queue instead, leave, or already be
 * matched. When the wait finally ends, the request that is waking up has to
 * know whether it still speaks for the player. Without this, a stale request
 * would report "this room is full" to somebody it had just successfully put
 * into a game — and the client turns any error into "back to the lobby".
 *
 * Anything that changes where a player is heading bumps the version, which
 * silently retires every attempt started before it.
 */
function newJoinAttempt(socket) {
  socket.data.joinAttempt = (socket.data.joinAttempt || 0) + 1;
  return socket.data.joinAttempt;
}
const joinAttemptIsCurrent = (socket, attempt) => socket.data.joinAttempt === attempt;

/** Still connected, and not already sitting in a live room. */
function isAvailableForMatch(socket) {
  if (!socket || !socket.connected) return false;
  return !(socket.data.roomId && rooms.has(socket.data.roomId));
}

/** Takes a socket out of the random queue, wherever it sits. */
function removeFromQueue(socket) {
  const spot = queue.findIndex((s) => s.id === socket.id);
  if (spot !== -1) queue.splice(spot, 1);
}

/** Drops any invite this socket is hosting. */
function dropPendingInvite(socket) {
  const code = socket.data.pendingCode;
  if (code && codeRooms.get(code) && codeRooms.get(code).hostSocketId === socket.id) {
    codeRooms.delete(code);
  }
  socket.data.pendingCode = null;
}

/**
 * The single way a match comes into existence.
 *
 * Both players are checked together and, only if both are genuinely free, are
 * they committed to the room and removed from every other waiting list in the
 * same step. Doing this in one place is what stops a player being pulled into
 * a second match: previously the queue and the invite list each handed out the
 * same socket without knowing about the other.
 *
 * @returns {boolean} whether a room was actually created.
 */
/**
 * Two connections signed into the SAME account are not two players.
 *
 * Nothing stops someone opening the game twice in one browser, and until this
 * check the two tabs could be matched with each other: the result was a
 * recorded game with the same id on both sides, which the stats query counts
 * once for that player — a win against nobody, awarded on demand.
 *
 * Guests are always distinct: an unsigned-in player has no account to share.
 */
function sameAccount(socketA, socketB) {
  const a = accountIdOf(socketA);
  const b = accountIdOf(socketB);
  return Boolean(a) && a === b;
}

function createRoom(socketA, socketB) {
  if (!socketA || !socketB || socketA.id === socketB.id) {
    console.error('createRoom called with one socket on both sides — ignoring');
    return false;
  }
  if (!isAvailableForMatch(socketA) || !isAvailableForMatch(socketB)) return false;
  if (sameAccount(socketA, socketB)) {
    console.error('refusing to match an account against itself:', accountIdOf(socketA));
    return false;
  }

  // Commit both players before anything can await, and retire any join
  // attempt either of them still has in flight.
  newJoinAttempt(socketA);
  newJoinAttempt(socketB);
  removeFromQueue(socketA);
  removeFromQueue(socketB);
  dropPendingInvite(socketA);
  dropPendingInvite(socketB);

  const roomId = randomUUID();
  const room = {
    id: roomId,
    // Identifies this GAME, not the room: a rematch is a new game in the same
    // room and gets a new one. It is what makes saving the result idempotent.
    gameId: randomUUID(),
    players: [
      // The seat records WHICH session it was taken with, not just which
      // account. Revocation has to reach a player whose connection is gone —
      // they have twelve seconds of recovery grace, and the match can finish
      // inside it — and a disconnected socket is not in io's socket list to be
      // found. A token-scoped sign-out must also not touch the same account's
      // other, still-valid sessions.
      { socketId: socketA.id, name: nameFor(socketA), accountId: accountIdOf(socketA), sessionToken: socketA.data.sessionToken || null },
      { socketId: socketB.id, name: nameFor(socketB), accountId: accountIdOf(socketB), sessionToken: socketB.data.sessionToken || null },
    ],
    round: 0,
    scores: { [socketA.id]: 0, [socketB.id]: 0 },
    state: 'idle',
    // One number per attempt at a round, counting up and never reset — not even
    // by a rematch. A voided round is replayed under the same round NUMBER, so
    // the round number cannot identify an attempt.
    //
    // It is a counter rather than a random id so that it can be COMPARED. The
    // client needs that: Socket.IO connection state recovery replays the events
    // a client missed, with their original payloads, so a returning player is
    // handed the closed attempt's phase and clock. Being able to see that a
    // replayed event is older than what it already has is what lets the client
    // ignore it.
    attempt: 0,
    teamSubs: {},
    teamAttempts: {},
    playerGuessResolved: false,
    // Server-authoritative window for the guess phase. The client is told when
    // it opens and when it closes and renders that; it does not decide either.
    guessOpensAt: 0,
    guessClosesAt: 0,
    teamClosesAt: 0,
    rematchRequests: new Set(),
    timer: null,
  };
  rooms.set(roomId, room);
  socketA.join(roomId);
  socketB.join(roomId);
  socketA.data.roomId = roomId;
  socketB.data.roomId = roomId;

  for (const s of [socketA, socketB]) {
    const opponent = s === socketA ? socketB : socketA;
    s.emit('matched', {
      roomId,
      opponentName: nameFor(opponent),
      myName: nameFor(s),
      maxRounds: MAX_ROUNDS,
    });
  }

  sendHeadToHead(room);
  startRound(room);
  return true;
}

const accountIdOf = (socket) => (socket.data.account ? socket.data.account.id : null);
// A signed-in player is known by their account name, so the leaderboard and
// the scoreboard can't disagree about who just played.
const nameFor = (socket) => (socket.data.account ? socket.data.account.display_name : socket.data.name);

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

// The running series only exists for two signed-in players; guests get
// nothing rather than a misleading 0-0.
async function sendHeadToHead(room) {
  const [a, b] = room.players;
  if (!db.isEnabled() || !a.accountId || !b.accountId) return;
  try {
    const tally = await accounts.headToHead(a.accountId, b.accountId);
    if (!tally.games) return;
    for (const seat of room.players) {
      const mine = seat === a ? tally.aWins : tally.bWins;
      const theirs = seat === a ? tally.bWins : tally.aWins;
      io.to(seat.socketId).emit('headToHead', {
        games: tally.games, myWins: mine, theirWins: theirs, draws: tally.draws,
      });
    }
  } catch (err) {
    console.error('head-to-head lookup failed:', err.message);
  }
}

function startRound(room, { retry = false } = {}) {
  clearTimer(room);
  if (!retry) room.round += 1;
  room.state = 'countdown';
  room.teamSubs = {};
  room.playerGuessResolved = false;

  io.to(room.id).emit('roundStart', {
    round: room.round,
    maxRounds: MAX_ROUNDS,
    scores: scoresForClient(room),
  });

  let count = 3;
  const tick = () => {
    // The room can be torn down mid-countdown when a player leaves.
    if (rooms.get(room.id) !== room) return;
    io.to(room.id).emit('countdown', { value: count > 0 ? count : 'GO' });
    if (count === 0) {
      openTeamSubmission(room);
      return;
    }
    count -= 1;
    room.timer = setTimeout(tick, 900);
  };
  room.timer = setTimeout(tick, 600);
}

function openTeamSubmission(room) {
  room.state = 'team-submit';
  // A fresh attempt: this is the point where a replayed round becomes a
  // genuinely new one as far as every in-flight submission is concerned.
  room.attempt += 1;
  room.teamSubs = {};
  room.teamAttempts = {};
  room.guessOpensAt = 0;
  room.guessClosesAt = 0;
  room.teamClosesAt = Date.now() + TEAM_SUBMIT_MS;
  io.to(room.id).emit('openTeamSubmit', phaseTiming(room, {
    timeoutMs: TEAM_SUBMIT_MS,
    closesAt: room.teamClosesAt,
  }));

  clearTimer(room);
  room.timer = onThisAttempt(room, () => resolveTeamsPhase(room), TEAM_SUBMIT_MS);
}

/**
 * Does this submission name the attempt that is actually open?
 *
 * A missing number is treated as stale too. The client is served from the same
 * origin as the server, so there is no version of it in the wild that does not
 * send one — and accepting unstamped submissions would leave the whole hole
 * open for anything that simply omits the field.
 */
function isCurrentAttempt(room, attempt) {
  return Number.isInteger(attempt) && attempt === room.attempt;
}

/**
 * Stamps a phase event with its attempt and the server's own clock.
 *
 * `serverNow` is what makes the absolute deadlines usable: the client cannot
 * trust its own clock to agree with ours (a phone can be minutes off), so it
 * works out the offset from this and measures the deadline against that,
 * instead of against a raw local Date.now().
 */
function phaseTiming(room, extra) {
  return { attempt: room.attempt, serverNow: Date.now(), ...extra };
}

/**
 * Brings a returning player back to the CURRENT state of the room.
 *
 * Connection state recovery replays the events this socket missed, with their
 * original payloads — including the clock of a phase that has since closed. So
 * a player who dropped mid-round came back to a full-length timer on a round
 * that was nearly over. The replayed events are ignored by the client because
 * they carry an older attempt number; this is what tells it the truth instead.
 */
function sendPhaseSync(room, socketId) {
  io.to(socketId).emit('phaseSync', phaseTiming(room, {
    state: room.state,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    scores: scoresForClient(room),
    teamClosesAt: room.teamClosesAt || 0,
    guessOpensAt: room.guessOpensAt || 0,
    guessClosesAt: room.guessClosesAt || 0,
    resolved: room.resolvedTeams && room.state === 'player-submit'
      ? Object.fromEntries(room.players.map((pl) => [
        pl.socketId,
        { display: room.resolvedTeams[pl.socketId].display, name: pl.name },
      ]))
      : null,
    mySubmittedTeam: room.teamSubs[socketId] ? room.teamSubs[socketId].display : null,
    guessResolved: Boolean(room.playerGuessResolved),
  }));
}

/**
 * setTimeout for a room, bound to the attempt that scheduled it.
 *
 * Timers used to fire against whatever state the room happened to be in. A
 * timer from an abandoned attempt could void or end the round that replaced it,
 * because `room` is the same object and the round number is the same too.
 */
function onThisAttempt(room, fn, delayMs) {
  const attempt = room.attempt;
  return setTimeout(() => {
    if (rooms.get(room.id) !== room || room.attempt !== attempt) return;
    fn();
  }, delayMs);
}

/**
 * Ends the current attempt and schedules what comes next.
 *
 * Announcing the void is not enough on its own. The attempt used to stay
 * "current" until the replay opened its own team window seconds later, and the
 * phase state stayed on team-submit — so a club name still resolving over the
 * network was accepted INTO the dead attempt, and then carried into the replay.
 * The attempt is retired here, the moment it is announced.
 */
function voidRound(room, reason, next) {
  io.to(room.id).emit('roundVoid', { reason });
  room.state = 'void';
  room.attempt += 1;
  room.timer = onThisAttempt(room, next, NEXT_ROUND_DELAY_MS);
}

function resolveTeamsPhase(room) {
  clearTimer(room);
  const ids = room.players.map((p) => p.socketId);
  const subA = room.teamSubs[ids[0]];
  const subB = room.teamSubs[ids[1]];

  if (!subA || !subB) {
    voidRound(room, 'timeout_team', () => startRound(room, { retry: true }));
    return;
  }

  if (sameTeam(subA, subB)) {
    voidRound(room, 'same_team', () => startRound(room, { retry: true }));
    return;
  }

  room.state = 'player-submit';
  room.resolvedTeams = { [ids[0]]: subA, [ids[1]]: subB };

  // Kick off the Wikidata lookup immediately, in parallel with the client's
  // reveal animation and the players' typing — by the time anyone submits a
  // guess, this has usually already resolved and matching is instant.
  room.commonPlayersPromise = getCommonPlayers(subA, subB);
  const lookupAttempt = room.attempt;
  room.commonPlayersPromise.then((result) => {
    // The lookup outlives the attempt that started it when the round is voided
    // while it is in flight, so its result is only allowed to act on its own
    // attempt.
    if (rooms.get(room.id) !== room || room.attempt !== lookupAttempt) return;
    if (room.state !== 'player-submit' || room.playerGuessResolved) return;

    if (!result.ok) {
      io.to(room.id).emit('lookupIssue', { reason: result.reason });
      return;
    }
    if (!result.players.length) {
      // Two clubs can genuinely share nobody, and then the round is
      // unwinnable by anyone. Letting it run down the clock would count it as
      // played — which on the last round simply hands the game to whoever is
      // ahead. Replay it instead, immediately, so nobody types for nothing.
      clearTimer(room);
      room.playerGuessResolved = true; // stop any in-flight guess from scoring

      // Let the reveal finish first — otherwise the players never see which
      // two clubs came up, and the round just blinks past them.
      const afterReveal = Math.max(0, (room.guessOpensAt || 0) - Date.now());
      room.timer = onThisAttempt(room, () => {
        voidRound(room, 'no_common_players', () => startRound(room, { retry: true }));
      }, afterReveal);
    }
  });

  // The window is decided here, once, by the server: answers are accepted from
  // guessOpensAt (after the reveal, when a player can actually type) until
  // guessClosesAt. Both are sent to the client so it renders the same clock
  // rather than running its own — the old client started a full-length timer
  // AFTER the reveal while the server's had already been running through it,
  // so the round closed a reveal early on every single round.
  room.guessOpensAt = Date.now() + REVEAL_HOLD_MS;
  room.guessClosesAt = room.guessOpensAt + PLAYER_GUESS_MS;

  io.to(room.id).emit('teamsRevealed', phaseTiming(room, {
    teams: {
      [ids[0]]: { display: subA.display, name: room.players.find((p) => p.socketId === ids[0]).name },
      [ids[1]]: { display: subB.display, name: room.players.find((p) => p.socketId === ids[1]).name },
    },
    opensInMs: REVEAL_HOLD_MS,
    timeoutMs: PLAYER_GUESS_MS,
    opensAt: room.guessOpensAt,
    closesAt: room.guessClosesAt,
  }));

  clearTimer(room);
  // An explicit "you may answer now", so neither the client nor a test has to
  // re-derive the opening from the reveal hold.
  room.timer = onThisAttempt(room, () => {
    io.to(room.id).emit('openGuess', phaseTiming(room, {
      timeoutMs: Math.max(0, room.guessClosesAt - Date.now()),
      opensAt: room.guessOpensAt,
      closesAt: room.guessClosesAt,
    }));

    room.timer = onThisAttempt(room, () => {
      if (room.playerGuessResolved) return;
      voidRound(room, 'timeout_guess', room.round >= MAX_ROUNDS
        ? () => endGame(room)
        : () => startRound(room));
    }, Math.max(0, room.guessClosesAt - Date.now()));
  }, REVEAL_HOLD_MS);
}

function scoresForClient(room) {
  const [a, b] = room.players;
  return {
    [a.socketId]: room.scores[a.socketId] || 0,
    [b.socketId]: room.scores[b.socketId] || 0,
  };
}

function endGame(room) {
  clearTimer(room);
  room.state = 'game-over';
  room.rematchRequests.clear();
  const [a, b] = room.players;
  const scoreA = room.scores[a.socketId] || 0;
  const scoreB = room.scores[b.socketId] || 0;
  let winnerSocketId = null;
  if (scoreA !== scoreB) winnerSocketId = scoreA > scoreB ? a.socketId : b.socketId;
  io.to(room.id).emit('gameOver', {
    scores: scoresForClient(room),
    winnerSocketId,
  });

  saveMatch(room, { scoreA, scoreB, winnerSocketId });
}

// Only games between two signed-in players count: a guest has nowhere to put
// the result, and a half-recorded game would distort both leaderboards.
async function saveMatch(room, { scoreA, scoreB, winnerSocketId }) {
  const [a, b] = room.players;
  if (!db.isEnabled() || !a.accountId || !b.accountId) return;
  const winnerId = winnerSocketId === a.socketId ? a.accountId
    : winnerSocketId === b.socketId ? b.accountId
    : null;
  try {
    await accounts.recordMatch({
      matchUid: room.gameId,
      playerAId: a.accountId,
      playerBId: b.accountId,
      scoreA,
      scoreB,
      winnerId,
    });
    await sendStatsUpdate(room);
  } catch (err) {
    console.error('could not record match:', err.message);
  }
}

// After a recorded game both players get their updated profile and the new
// state of the series between them.
async function sendStatsUpdate(room) {
  const [a, b] = room.players;
  try {
    const [profileA, profileB] = await Promise.all([
      accounts.profileById(a.accountId),
      accounts.profileById(b.accountId),
    ]);
    const byId = new Map([[a.accountId, profileA], [b.accountId, profileB]]);
    for (const seat of room.players) {
      io.to(seat.socketId).emit('statsUpdate', { me: byId.get(seat.accountId) });
    }
  } catch (err) {
    console.error('could not send stats update:', err.message);
  }
  sendHeadToHead(room);
}

/**
 * Takes a player's identity away from the connections that already have it.
 *
 * socket.data.account is read once, when the connection is authenticated, so a
 * session ended over HTTP left every socket already holding that identity still
 * using it — signed out in the browser, still signed in on the wire. Recovery
 * made it worse: it restores socket.data wholesale and skips the middleware, so
 * a reconnect brought the revoked identity back.
 *
 * Their seat in a running game loses its account too, so the game finishes but
 * is not recorded against someone who is no longer signed in.
 */
function revokeAccountSockets({ playerId = null, token = null } = {}) {
  const wanted = (seatOrData) => {
    if (token && seatOrData.sessionToken === String(token)) return true;
    return Boolean(playerId) && seatOrData.accountId === playerId;
  };

  let sockets = 0;
  for (const socket of io.of('/').sockets.values()) {
    if (!wanted({
      sessionToken: socket.data.sessionToken,
      accountId: socket.data.account ? socket.data.account.id : null,
    })) continue;

    socket.data.account = null;
    socket.data.sessionToken = null;
    socket.emit('sessionEnded');
    sockets += 1;
  }

  // Seats are cleared separately, by walking the rooms. A player whose
  // transport has dropped is not in the socket list above, but their seat is
  // still in a live room and the game can finish without them — which used to
  // record the result against the account they had just signed out of.
  let seats = 0;
  for (const room of rooms.values()) {
    for (const seat of room.players) {
      if (!seat.accountId || !wanted(seat)) continue;
      seat.accountId = null;
      seat.sessionToken = null;
      seats += 1;
    }
  }
  return { sockets, seats };
}

io.on('connection', (socket) => {
  // A clock sample the client can trust.
  //
  // Phase events carry absolute deadlines and the server time they were sent
  // at, but recovery replays them with their ORIGINAL payloads — so their
  // timestamp is stale, and using it to work out the clock offset reproduces
  // exactly the error the absolute deadline was meant to remove. This event is
  // created on this connection, so it is fresh by construction, and it is one
  // of only two the client will take the offset from (the other is phaseSync).
  socket.emit('clock', { serverNow: Date.now() });

  // A recovered connection (Socket.IO connection state recovery) already has
  // its previous socket.data (roomId, name) restored — don't wipe it.
  if (!socket.recovered) {
    socket.data.name = null;
    socket.data.roomId = null;
  }

  // Recovery restores socket.data and skips the middlewares, so the identity
  // that comes back is whatever this socket had before it dropped — including a
  // session that has been ended or an account that has been deleted since. It
  // is re-checked against the database rather than trusted.
  if (socket.recovered && socket.data.sessionToken) {
    const token = socket.data.sessionToken;

    const drop = () => {
      socket.data.account = null;
      socket.data.sessionToken = null;
      const room = rooms.get(socket.data.roomId);
      if (room) {
        const seat = room.players.find((pl) => pl.socketId === socket.id);
        if (seat) {
          seat.accountId = null;
          seat.sessionToken = null;
        }
      }
      socket.emit('sessionEnded');
    };

    // Held as a barrier rather than started and forgotten: onSocketEvent waits
    // on it, so nothing runs under an identity that has not been confirmed.
    socket.data.authPending = accounts.playerForToken(token)
      .then((player) => {
        // A sign-out or deletion that landed while the question was in flight
        // has already cleared this; a late answer must not bring it back.
        if (socket.data.sessionToken !== token) return;
        if (player) {
          socket.data.account = player;
          return;
        }
        drop();
      })
      .catch((err) => {
        // Fail closed. Keeping the old identity because the lookup broke is how
        // a revoked account goes on playing as itself.
        console.error('session re-check failed, dropping identity:', err && err.message);
        if (socket.data.sessionToken === token) drop();
      })
      .finally(() => {
        socket.data.authPending = null;
      });
  }

  if (socket.recovered && socket.data.roomId) {
    const room = rooms.get(socket.data.roomId);
    if (room) {
      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }
      socket.join(room.id);
      socket.to(room.id).emit('opponentReconnected');
      // The replayed events this socket is about to receive describe the room
      // as it was when it dropped. Tell it what is true now.
      sendPhaseSync(room, socket.id);
    } else {
      // Room was already torn down before this socket made it back.
      socket.data.roomId = null;
    }
  }

  // One connection, one place in the world: either waiting, or in a game.
  // Repeating the request is harmless but never gets you a second seat — two
  // joinQueue events used to put the same socket in two different matches,
  // leaving orphaned rooms and timers behind.
  const isQueued = () => queue.some((s) => s.id === socket.id);
  const isPlaying = () => Boolean(socket.data.roomId) && rooms.has(socket.data.roomId);

  onSocketEvent(socket, 'joinQueue', ({ name }) => {
    const safeName = cleanText(name, 24) || `Oyuncu${Math.floor(Math.random() * 1000)}`;
    socket.data.name = safeName;

    if (isPlaying()) return;
    // Choosing the random queue retires any invite join still waiting — and it
    // has to happen before the "already queued" shortcut below. With the bump
    // after it, a player who was already queued, then asked to join a friend's
    // invite, then changed their mind back to the queue kept the invite join
    // alive: when the host came back, they were matched with the host despite
    // the queue being their latest choice.
    newJoinAttempt(socket);

    if (isQueued()) {
      socket.emit('waiting');
      return;
    }

    // Pull opponents off the front until one is genuinely free. Someone who
    // left, or who joined a friend's invite while waiting here, is stale.
    //
    // Your own other tab is not an opponent, but it is not stale either: it is
    // set aside and put back, and the scan carries on. Stopping at it would
    // leave you waiting while a perfectly good stranger sat behind it.
    const setAside = [];
    let paired = false;
    while (queue.length) {
      const opponent = queue.shift();
      if (opponent.id === socket.id) continue;
      if (!isAvailableForMatch(opponent)) continue;
      if (sameAccount(opponent, socket)) {
        setAside.push(opponent);
        continue;
      }
      if (createRoom(opponent, socket)) {
        paired = true;
        break;
      }
    }
    // Back at the front, in the order they were waiting.
    for (let i = setAside.length - 1; i >= 0; i -= 1) queue.unshift(setAside[i]);
    if (paired) return;

    queue.push(socket);
    socket.emit('waiting');
  });

  onSocketEvent(socket, 'createPrivateRoom', ({ name }) => {
    const safeName = cleanText(name, 24) || `Oyuncu${Math.floor(Math.random() * 1000)}`;
    socket.data.name = safeName;

    if (isPlaying()) return;
    // Hosting your own invite retires an invite join still waiting on someone
    // else's host. This runs before the idempotent branch below for the same
    // reason as in joinQueue: re-requesting your existing code is still a
    // statement that you intend to host, not to join.
    newJoinAttempt(socket);

    // Asking twice re-sends the code you already hold rather than minting a
    // new invite on every click.
    if (socket.data.pendingCode && codeRooms.has(socket.data.pendingCode)) {
      socket.emit('privateRoomCreated', { code: socket.data.pendingCode });
      return;
    }
    // A socket waiting for a friend should not also be in the random queue.
    const spot = queue.findIndex((s) => s.id === socket.id);
    if (spot !== -1) queue.splice(spot, 1);

    let code = makeRoomCode();
    while (codeRooms.has(code)) code = makeRoomCode();
    codeRooms.set(code, { hostSocketId: socket.id, createdAt: Date.now() });
    socket.data.pendingCode = code;
    socket.emit('privateRoomCreated', { code });
  });

  onSocketEvent(socket, 'joinPrivateRoom', async ({ name, code }) => {
    const safeName = cleanText(name, 24) || `Oyuncu${Math.floor(Math.random() * 1000)}`;
    socket.data.name = safeName;
    // A second join supersedes the first: the newest intent is the real one.
    const attempt = newJoinAttempt(socket);
    const normalizedCode = cleanText(code, 12).toUpperCase();
    const entry = codeRooms.get(normalizedCode);

    if (isPlaying()) return;
    // Joining your own invite would build a room with the same socket on both
    // sides — and, for a signed-in player, a match against themselves.
    if (entry && entry.hostSocketId === socket.id) {
      socket.emit('errorMessage', { message: 'Bu kod senin davetin — arkadaşına gönder.' });
      return;
    }
    if (!entry) {
      socket.emit('errorMessage', { message: 'Oda kodu bulunamadı ya da süresi doldu.' });
      return;
    }
    if (Date.now() - entry.createdAt > INVITE_TTL_MS) {
      codeRooms.delete(normalizedCode);
      socket.emit('errorMessage', { message: 'Bu davetin süresi dolmuş, yeni bir kod oluşturun.' });
      return;
    }

    // Sharing an invite means leaving the browser, which drops the host's
    // socket — so a host who looks offline right now is usually just on their
    // way back. Give them a moment before writing the invite off.
    const hostSocket = await waitForConnectedSocket(entry.hostSocketId, HOST_WAIT_MS);

    // That wait can be seconds long, so everything is re-checked against the
    // state as it is now. The version check comes FIRST and returns silently:
    // if this attempt has been superseded — by a duplicate request, by the
    // player queueing or leaving, or by the match this very player is already
    // in — it must not speak at all. Reporting a failure here would eject a
    // player from a game that succeeded.
    if (!joinAttemptIsCurrent(socket, attempt)) return;
    if (!isAvailableForMatch(socket)) return; // joiner already got a game
    if (codeRooms.get(normalizedCode) !== entry) {
      socket.emit('errorMessage', { message: 'Bu oda çoktan dolmuş.' });
      return;
    }
    if (!hostSocket) {
      codeRooms.delete(normalizedCode);
      socket.emit('errorMessage', { message: 'Oda sahibi çevrimdışı, yeni bir kod isteyin.' });
      return;
    }
    if (!isAvailableForMatch(hostSocket)) {
      socket.emit('errorMessage', { message: 'Bu oda çoktan dolmuş.' });
      return;
    }
    // Joining your own invite from a second tab while signed into the same
    // account is the same problem as matching yourself in the queue.
    if (sameAccount(hostSocket, socket)) {
      socket.emit('errorMessage', { message: 'Bu hesap zaten bu odada — kendinle oynayamazsın.' });
      return;
    }

    codeRooms.delete(normalizedCode);
    if (!createRoom(hostSocket, socket)) {
      socket.emit('errorMessage', { message: 'Odaya girilemedi, tekrar dene.' });
    }
  });

  onSocketEvent(socket, 'submitTeam', async ({ team, attempt } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    // Staleness is checked before anything else so the player is actually told.
    // A submission stranded by a dropped transport usually arrives when the
    // room has moved to another phase entirely, and a check further down would
    // drop it silently — leaving the player watching a spinner for a club they
    // did send.
    // The attempt the PLAYER typed this for, as stamped by their client.
    //
    // Taking the attempt from the room when the message arrives is not enough.
    // A client that loses its transport queues what it sends and replays it on
    // reconnect, so a club chosen for a window that has since closed arrived
    // afterwards and was entered into the next attempt — spending that
    // attempt's one team choice on something the player never picked for it.
    if (!isCurrentAttempt(room, attempt)) {
      socket.emit('teamRejected', { reason: 'stale_round' });
      return;
    }
    if (room.state !== 'team-submit') return;
    if (room.teamSubs[socket.id]) return; // already submitted

    const attempts = (room.teamAttempts[socket.id] || 0) + 1;
    room.teamAttempts[socket.id] = attempts;
    if (attempts > MAX_TEAM_ATTEMPTS_PER_ROUND) {
      socket.emit('teamRejected', { reason: 'too_many_attempts' });
      return;
    }

    const name = cleanInput(team);
    if (!name) {
      socket.emit('teamRejected', { reason: 'unknown_team' });
      return;
    }

    const resolved = await resolveTeamInput(name);

    // Resolving may have gone to the network — make sure this is still the same
    // attempt at the same round, and that it is still waiting for this team.
    if (rooms.get(socket.data.roomId) !== room || room.attempt !== attempt) return;
    if (room.state !== 'team-submit') return;
    if (room.teamSubs[socket.id]) return;

    if (!resolved) {
      socket.emit('teamRejected', { reason: 'unknown_team' });
      return;
    }
    room.teamSubs[socket.id] = resolved;
    socket.emit('teamAccepted', { display: resolved.display });

    // Start pulling this club's squad now, while the other player is still
    // typing — by the reveal it is usually already cached.
    prefetchSquad(resolved);

    const ids = room.players.map((p) => p.socketId);
    io.to(room.id).emit('opponentTeamStatus', {
      submittedBy: ids.filter((id) => room.teamSubs[id]),
    });

    if (room.teamSubs[ids[0]] && room.teamSubs[ids[1]]) {
      resolveTeamsPhase(room);
    }
  });

  onSocketEvent(socket, 'submitGuess', async ({ guess, attempt } = {}) => {
    // Everything that decides WHEN this answer arrived is read before any
    // await. Reading the clock after the Wikidata lookup made the score depend
    // on how slow Wikidata happened to be: the same answer, typed at the same
    // moment, was worth +3 on a fast day and +1 on a slow one.
    const receivedAt = Date.now();
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    // Same protocol rule as submitTeam, and checked first for the same reason:
    // an answer replayed from a client's offline queue usually lands in a
    // different phase, and must be refused out loud rather than dropped.
    if (!isCurrentAttempt(room, attempt)) {
      socket.emit('guessTooLate', { reason: 'stale_round' });
      return;
    }
    if (room.state !== 'player-submit') return;
    const safeGuess = cleanInput(guess);
    if (!safeGuess) return;

    // Answers are only accepted inside the window the server published. The
    // reveal is still running before guessOpensAt, so an answer sent then came
    // from a client that skipped the reveal — and it used to be scored as
    // elapsed 0, i.e. a guaranteed top-tier +3 for answering before the
    // question was officially open.
    if (receivedAt < room.guessOpensAt) {
      socket.emit('guessTooEarly', {
        opensInMs: Math.max(0, room.guessOpensAt - receivedAt),
      });
      return;
    }
    if (room.guessClosesAt && receivedAt > room.guessClosesAt) {
      socket.emit('guessTooLate', { reason: 'window_closed' });
      return;
    }
    // A correct answer the opponent beat you to isn't a wrong answer — say so,
    // otherwise a perfectly good guess looks like it was silently rejected.
    if (room.playerGuessResolved) {
      socket.emit('guessTooLate', { reason: 'opponent_was_faster' });
      return;
    }
    if (!room.commonPlayersPromise) return;

    const lookup = await room.commonPlayersPromise;

    // Re-check everything after the await — the round may have ended, the
    // opponent may have already won it, the round may have been voided and
    // replayed, or the room may be gone entirely.
    if (rooms.get(socket.data.roomId) !== room || room.attempt !== attempt) return;
    if (room.state !== 'player-submit') return;
    if (room.playerGuessResolved) {
      socket.emit('guessTooLate', { reason: 'opponent_was_faster' });
      return;
    }

    if (!lookup.ok) {
      socket.emit('guessRejected', { reason: lookup.reason, guess: safeGuess });
      return;
    }

    const matched = matchPlayerName(safeGuess, lookup.players);
    if (!matched) {
      socket.emit('guessRejected', { reason: 'player_not_found', guess: safeGuess });
      return;
    }

    room.playerGuessResolved = true;
    clearTimer(room);

    // Scored from when the answer arrived, not from when the lookup finished.
    const elapsedMs = Math.max(0, receivedAt - room.guessOpensAt);
    const points = pointsForSpeed(elapsedMs);
    room.scores[socket.id] = (room.scores[socket.id] || 0) + points;

    io.to(room.id).emit('roundResult', {
      winnerSocketId: socket.id,
      playerName: matched,
      points,
      elapsedMs,
      scores: scoresForClient(room),
    });

    if (room.round >= MAX_ROUNDS) {
      room.timer = onThisAttempt(room, () => endGame(room), NEXT_ROUND_DELAY_MS);
    } else {
      room.timer = onThisAttempt(room, () => startRound(room), NEXT_ROUND_DELAY_MS);
    }
  });

  // "Bir daha!" is the natural reflex after a game — keep the pair together
  // instead of sending them back to the lobby to re-match from scratch.
  onSocketEvent(socket, 'requestRematch', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'game-over') return;

    room.rematchRequests.add(socket.id);
    const ids = room.players.map((p) => p.socketId);

    if (ids.every((id) => room.rematchRequests.has(id))) {
      room.rematchRequests.clear();
      room.round = 0;
      // A new game, so a new id — otherwise the rematch's result would collide
      // with the first game's row and be silently dropped.
      room.gameId = randomUUID();
      for (const id of ids) room.scores[id] = 0;
      io.to(room.id).emit('rematchStarting');
      startRound(room);
      return;
    }

    socket.emit('rematchWaiting');
    socket.to(room.id).emit('opponentWantsRematch');
  });

  onSocketEvent(socket, 'leaveRoom', () => cleanupSocket(socket));

  socket.on('disconnect', () => {
    const idx = queue.findIndex((s) => s.id === socket.id);
    if (idx !== -1) queue.splice(idx, 1);
    // Deliberately NOT deleting socket.data.pendingCode here: a host who taps
    // "share" is disconnecting precisely because they are sending the invite.
    // The code expires on its own (INVITE_TTL_MS) instead.

    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // Don't tear the room down immediately: mobile sockets drop and come
    // back constantly (keyboard focus, backgrounding, brief network blips).
    // Give connection state recovery a window to bring the same socket back
    // into this room before we tell the opponent they left for good.
    socket.to(roomId).emit('opponentDisconnectedTemporarily');
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => {
      room.cleanupTimer = null;
      const current = rooms.get(roomId);
      if (!current) return;
      clearTimer(current);
      io.to(roomId).emit('opponentLeft', { disconnected: true });
      rooms.delete(roomId);
    }, RECONNECT_GRACE_MS);
  });
});

function cleanupSocket(socket, disconnected = false) {
  // Leaving retires any pending join even when there is no room yet: a player
  // who cancelled while waiting for an invite host must not be dropped into
  // that game when the host finally reappears.
  newJoinAttempt(socket);
  removeFromQueue(socket);
  dropPendingInvite(socket);

  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  clearTimer(room);
  socket.to(roomId).emit('opponentLeft', { disconnected });
  rooms.delete(roomId);
  socket.data.roomId = null;
}

// Render sends SIGTERM on every deploy and scale event. Without this the
// process is killed mid-request and open sockets are dropped without notice.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  io.emit('serverRestarting');
  io.close();
  server.close(() => {
    db.close().finally(() => process.exit(0));
  });
  // Don't hang forever on a socket that refuses to close.
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash should be loud and fatal, not a half-dead process serving errors.
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection:', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});

server.listen(PORT, () => {
  // Report the port actually bound, not the requested one: with PORT=0 the OS
  // chooses, and logging the request would print a useless "0".
  const bound = server.address();
  console.log(`${brand.name} server listening on port ${bound ? bound.port : PORT}`);
  // Creating the tables is safe to repeat, and a failure here only disables
  // accounts — the game itself must still come up.
  db.migrate().then((ready) => {
    if (!ready) return;
    const purge = () => accounts.purgeExpiredSessions()
      .catch((err) => console.error('session purge failed:', err.message));
    purge();
    setInterval(purge, 6 * 60 * 60 * 1000).unref();
  });
});
