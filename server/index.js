const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const { resolveTeam, normalize } = require('./data/teams');
const { matchPlayerName } = require('./gameLogic');
const { getCommonPlayers, resolveTeamByName, prefetchSquad } = require('./wikidata');
const squadStore = require('./squadStore');

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

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Cheap endpoint for an uptime pinger to hit. Render's free tier sleeps after
// 15 minutes idle and then takes ~40s to wake, which is long enough that an
// invited friend gives up before the page loads.
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Did the deploy-time squad build actually produce anything? Answers that in
// one look, without having to read build logs.
app.get('/debug/snapshot', (req, res) => {
  res.json(squadStore.info());
});

// Diagnostics for a single matchup, e.g.
//   /debug/lookup?a=Inter Milan&b=AC Milan
//   /debug/lookup?a=Fenerbahce&b=Lazio&guess=Vedat Muriqi
// Shows whether the answer came from the shipped snapshot or a live lookup,
// which Wikidata items each club name resolved to, and what the common player
// list actually contains — so a "that player should have counted" report can
// be checked against real data instead of guessed at.
app.get('/debug/lookup', async (req, res) => {
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

/** @type {Map<string, {id: string, players: Object[], round: number, scores: Object, state: string, teamSubs: Object, timer: any}>} */
const rooms = new Map();
const queue = []; // socket ids waiting for random match
const codeRooms = new Map(); // roomCode -> roomId, for friend-code matching

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
      { socketId: socketA.id, name: socketA.data.name },
      { socketId: socketB.id, name: socketB.data.name },
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
      opponentName: opponent.data.name,
      maxRounds: MAX_ROUNDS,
    });
  }
  startRound(room);
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
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
    if (!result.ok) {
      io.to(room.id).emit('lookupIssue', { reason: result.reason });
    } else if (!result.players.length) {
      // Perfectly possible for two clubs to share nobody — say so, rather than
      // letting every guess come back as "no such player".
      io.to(room.id).emit('lookupIssue', { reason: 'no_common_players' });
    }
  });

  io.to(room.id).emit('teamsRevealed', {
    teams: {
      [ids[0]]: { display: subA.display, name: room.players.find((p) => p.socketId === ids[0]).name },
      [ids[1]]: { display: subB.display, name: room.players.find((p) => p.socketId === ids[1]).name },
    },
    timeoutMs: PLAYER_GUESS_MS,
  });

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
    codeRooms.set(code, { hostSocketId: socket.id });
    socket.data.pendingCode = code;
    socket.emit('privateRoomCreated', { code });
  });

  socket.on('joinPrivateRoom', ({ name, code }) => {
    const safeName = (name || '').toString().trim().slice(0, 24) || `Oyuncu${Math.floor(Math.random() * 1000)}`;
    socket.data.name = safeName;
    const normalizedCode = (code || '').toString().trim().toUpperCase();
    const entry = codeRooms.get(normalizedCode);
    if (!entry) {
      socket.emit('errorMessage', { message: 'Oda kodu bulunamadı.' });
      return;
    }
    const hostSocket = io.sockets.sockets.get(entry.hostSocketId);
    if (!hostSocket || !hostSocket.connected) {
      socket.emit('errorMessage', { message: 'Oda sahibi bağlantısı koptu.' });
      codeRooms.delete(normalizedCode);
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
    room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;

    io.to(room.id).emit('roundResult', {
      winnerSocketId: socket.id,
      playerName: matched,
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
    if (socket.data.pendingCode) codeRooms.delete(socket.data.pendingCode);

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
});
