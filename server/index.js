const path = require('path');
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
const MAX_ROUNDS = 5;
const TEAM_SUBMIT_MS = 12000;
const PLAYER_GUESS_MS = 25000;
const NEXT_ROUND_DELAY_MS = 3500;
const RECONNECT_GRACE_MS = 12000;

// Everyone scoring a flat point wasted the tension of a speed game: knowing
// the answer instantly and dredging it up at the last second paid the same.
// Points now fall off with the clock, which also keeps a 0-3 game alive.
const SPEED_TIERS = [
  { withinMs: 5000, points: 3 },
  { withinMs: 12000, points: 2 },
];
const BASE_POINTS = 1;
// Must match the reveal hold in public/app.js, so the speed clock starts when
// the player can actually type.
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
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

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
const limitDebug = createLimiter('debug', envInt('RATE_DEBUG', 20), 60 * 1000);

app.use('/api', limitApi);

// --- accounts, stats, leaderboard -------------------------------------------
// All of these answer 503 when DATABASE_URL isn't set, so the game itself
// keeps working with accounts simply switched off.
function requireDb(res) {
  if (db.isEnabled()) return true;
  res.status(503).json({ reason: 'accounts_disabled' });
  return false;
}

app.post('/api/register', limitRegister, async (req, res) => {
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
});

app.post('/api/login', limitLogin, async (req, res) => {
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
});

// The token travels in a header, not the query string: URLs end up in server
// logs, browser history and Referer headers.
function tokenFrom(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

app.get('/api/me', async (req, res) => {
  if (!requireDb(res)) return;
  const player = await accounts.playerForToken(tokenFrom(req));
  if (!player) return res.status(401).json({ reason: 'not_signed_in' });
  res.json({ player: await accounts.profile(player.username) });
});

app.post('/api/logout', async (req, res) => {
  if (!requireDb(res)) return;
  await accounts.endSession(tokenFrom(req));
  res.json({ ok: true });
});

app.get('/api/leaderboard', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({ entries: await accounts.leaderboard(50), tiers: accounts.TIERS });
  } catch (err) {
    console.error('leaderboard failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/profile/:username', async (req, res) => {
  if (!requireDb(res)) return;
  const stats = await accounts.profile(req.params.username);
  if (!stats) return res.status(404).json({ error: 'not_found' });
  res.json(stats);
});

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
app.get('/debug/snapshot', limitDebug, (req, res) => {
  res.json(squadStore.info());
});

// Diagnostics for a single matchup, e.g.
//   /debug/lookup?a=Inter Milan&b=AC Milan
//   /debug/lookup?a=Fenerbahce&b=Lazio&guess=Vedat Muriqi
// Shows whether the answer came from the shipped snapshot or a live lookup,
// which Wikidata items each club name resolved to, and what the common player
// list actually contains — so a "that player should have counted" report can
// be checked against real data instead of guessed at.
app.get('/debug/lookup', limitDebug, async (req, res) => {
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
});

// Runs before 'connection', so socket.data.account is already there when the
// first joinQueue arrives. Recovered connections skip this and keep the data
// they had.
// One person with a script could otherwise open hundreds of sockets and fill
// the quick-match queue with ghosts. The cap is well above what a household
// or an office behind one address would ever need.
const MAX_SOCKETS_PER_IP = 25;
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
    if (token) socket.data.account = await accounts.playerForToken(token);
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

function createRoom(socketA, socketB) {
  const roomId = randomUUID();
  const room = {
    id: roomId,
    players: [
      { socketId: socketA.id, name: nameFor(socketA), accountId: accountIdOf(socketA) },
      { socketId: socketB.id, name: nameFor(socketB), accountId: accountIdOf(socketB) },
    ],
    round: 0,
    scores: { [socketA.id]: 0, [socketB.id]: 0 },
    state: 'idle',
    teamSubs: {},
    playerGuessResolved: false,
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
  room.teamSubs = {};
  io.to(room.id).emit('openTeamSubmit', { timeoutMs: TEAM_SUBMIT_MS });

  clearTimer(room);
  room.timer = setTimeout(() => resolveTeamsPhase(room), TEAM_SUBMIT_MS);
}

function resolveTeamsPhase(room) {
  clearTimer(room);
  const ids = room.players.map((p) => p.socketId);
  const subA = room.teamSubs[ids[0]];
  const subB = room.teamSubs[ids[1]];

  if (!subA || !subB) {
    io.to(room.id).emit('roundVoid', { reason: 'timeout_team' });
    room.timer = setTimeout(() => startRound(room, { retry: true }), NEXT_ROUND_DELAY_MS);
    return;
  }

  if (sameTeam(subA, subB)) {
    io.to(room.id).emit('roundVoid', { reason: 'same_team' });
    room.timer = setTimeout(() => startRound(room, { retry: true }), NEXT_ROUND_DELAY_MS);
    return;
  }

  room.state = 'player-submit';
  room.resolvedTeams = { [ids[0]]: subA, [ids[1]]: subB };

  // Kick off the Wikidata lookup immediately, in parallel with the client's
  // reveal animation and the players' typing — by the time anyone submits a
  // guess, this has usually already resolved and matching is instant.
  room.commonPlayersPromise = getCommonPlayers(subA, subB);
  room.commonPlayersPromise.then((result) => {
    if (rooms.get(room.id) !== room || room.state !== 'player-submit' || room.playerGuessResolved) return;

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
      room.timer = setTimeout(() => {
        io.to(room.id).emit('roundVoid', { reason: 'no_common_players' });
        room.timer = setTimeout(() => startRound(room, { retry: true }), NEXT_ROUND_DELAY_MS);
      }, afterReveal);
    }
  });

  io.to(room.id).emit('teamsRevealed', {
    teams: {
      [ids[0]]: { display: subA.display, name: room.players.find((p) => p.socketId === ids[0]).name },
      [ids[1]]: { display: subB.display, name: room.players.find((p) => p.socketId === ids[1]).name },
    },
    timeoutMs: PLAYER_GUESS_MS,
  });

  // The clock for speed scoring starts when the guess window opens on the
  // client, which is after the reveal animation — not now.
  room.guessOpensAt = Date.now() + REVEAL_HOLD_MS;

  clearTimer(room);
  room.timer = setTimeout(() => {
    if (!room.playerGuessResolved) {
      io.to(room.id).emit('roundVoid', { reason: 'timeout_guess' });
      if (room.round >= MAX_ROUNDS) {
        room.timer = setTimeout(() => endGame(room), NEXT_ROUND_DELAY_MS);
      } else {
        room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
      }
    }
  }, PLAYER_GUESS_MS);
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

io.on('connection', (socket) => {
  // A recovered connection (Socket.IO connection state recovery) already has
  // its previous socket.data (roomId, name) restored — don't wipe it.
  if (!socket.recovered) {
    socket.data.name = null;
    socket.data.roomId = null;
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
    } else {
      // Room was already torn down before this socket made it back.
      socket.data.roomId = null;
    }
  }

  socket.on('joinQueue', ({ name }) => {
    const safeName = (name || '').toString().trim().slice(0, 24) || `Oyuncu${Math.floor(Math.random() * 1000)}`;
    socket.data.name = safeName;

    if (queue.length > 0 && queue[0].id !== socket.id) {
      const opponent = queue.shift();
      if (!opponent.connected) {
        queue.push(socket);
        socket.emit('waiting');
        return;
      }
      createRoom(opponent, socket);
    } else {
      queue.push(socket);
      socket.emit('waiting');
    }
  });

  socket.on('createPrivateRoom', ({ name }) => {
    const safeName = (name || '').toString().trim().slice(0, 24) || `Oyuncu${Math.floor(Math.random() * 1000)}`;
    socket.data.name = safeName;
    let code = makeRoomCode();
    while (codeRooms.has(code)) code = makeRoomCode();
    codeRooms.set(code, { hostSocketId: socket.id, createdAt: Date.now() });
    socket.data.pendingCode = code;
    socket.emit('privateRoomCreated', { code });
  });

  socket.on('joinPrivateRoom', async ({ name, code }) => {
    const safeName = (name || '').toString().trim().slice(0, 24) || `Oyuncu${Math.floor(Math.random() * 1000)}`;
    socket.data.name = safeName;
    const normalizedCode = (code || '').toString().trim().toUpperCase();
    const entry = codeRooms.get(normalizedCode);

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
    if (!hostSocket) {
      codeRooms.delete(normalizedCode);
      socket.emit('errorMessage', { message: 'Oda sahibi çevrimdışı, yeni bir kod isteyin.' });
      return;
    }
    if (hostSocket.data.roomId && rooms.has(hostSocket.data.roomId)) {
      socket.emit('errorMessage', { message: 'Bu oda çoktan dolmuş.' });
      return;
    }

    codeRooms.delete(normalizedCode);
    createRoom(hostSocket, socket);
  });

  socket.on('submitTeam', async ({ team }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'team-submit') return;
    if (room.teamSubs[socket.id]) return; // already submitted

    const resolved = await resolveTeamInput(team);

    // Resolving may have gone to the network — make sure the round is still
    // waiting for this team before acting on the answer.
    if (rooms.get(socket.data.roomId) !== room || room.state !== 'team-submit') return;
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

  socket.on('submitGuess', async ({ guess }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'player-submit') return;
    // A correct answer the opponent beat you to isn't a wrong answer — say so,
    // otherwise a perfectly good guess looks like it was silently rejected.
    if (room.playerGuessResolved) {
      socket.emit('guessTooLate');
      return;
    }
    if (!room.commonPlayersPromise) return;

    const lookup = await room.commonPlayersPromise;

    // Re-check everything after the await — the round may have ended, the
    // opponent may have already won it, or the room may be gone entirely.
    if (rooms.get(socket.data.roomId) !== room || room.state !== 'player-submit') return;
    if (room.playerGuessResolved) {
      socket.emit('guessTooLate');
      return;
    }

    if (!lookup.ok) {
      socket.emit('guessRejected', { reason: lookup.reason, guess });
      return;
    }

    const matched = matchPlayerName(guess, lookup.players);
    if (!matched) {
      socket.emit('guessRejected', { reason: 'player_not_found', guess });
      return;
    }

    room.playerGuessResolved = true;
    clearTimer(room);

    const elapsedMs = Math.max(0, Date.now() - (room.guessOpensAt || Date.now()));
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
      room.timer = setTimeout(() => endGame(room), NEXT_ROUND_DELAY_MS);
    } else {
      room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
    }
  });

  // "Bir daha!" is the natural reflex after a game — keep the pair together
  // instead of sending them back to the lobby to re-match from scratch.
  socket.on('requestRematch', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'game-over') return;

    room.rematchRequests.add(socket.id);
    const ids = room.players.map((p) => p.socketId);

    if (ids.every((id) => room.rematchRequests.has(id))) {
      room.rematchRequests.clear();
      room.round = 0;
      for (const id of ids) room.scores[id] = 0;
      io.to(room.id).emit('rematchStarting');
      startRound(room);
      return;
    }

    socket.emit('rematchWaiting');
    socket.to(room.id).emit('opponentWantsRematch');
  });

  socket.on('leaveRoom', () => cleanupSocket(socket));

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

server.listen(PORT, () => {
  console.log(`3-2-1 Futbol server listening on port ${PORT}`);
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
