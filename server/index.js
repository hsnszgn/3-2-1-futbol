const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const { resolveTeam } = require('./data/teams');
const { validateGuess } = require('./gameLogic');

const PORT = process.env.PORT || 3000;
const MAX_ROUNDS = 5;
const TEAM_SUBMIT_MS = 12000;
const PLAYER_GUESS_MS = 25000;
const NEXT_ROUND_DELAY_MS = 3500;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

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

function startRound(room) {
  clearTimer(room);
  room.round += 1;
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
    room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
    return;
  }

  if (subA.id === subB.id) {
    io.to(room.id).emit('roundVoid', { reason: 'same_team' });
    room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
    return;
  }

  room.state = 'player-submit';
  room.resolvedTeams = { [ids[0]]: subA, [ids[1]]: subB };
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
      room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
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
  socket.data.name = null;
  socket.data.roomId = null;

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

  socket.on('submitTeam', ({ team }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'team-submit') return;
    if (room.teamSubs[socket.id]) return; // already submitted
    const resolved = resolveTeam(team);
    if (!resolved) {
      socket.emit('teamRejected', { reason: 'unknown_team' });
      return;
    }
    room.teamSubs[socket.id] = resolved;
    socket.emit('teamAccepted', { display: resolved.display });

    const ids = room.players.map((p) => p.socketId);
    io.to(room.id).emit('opponentTeamStatus', {
      submittedBy: ids.filter((id) => room.teamSubs[id]),
    });

    if (room.teamSubs[ids[0]] && room.teamSubs[ids[1]]) {
      resolveTeamsPhase(room);
    }
  });

  socket.on('submitGuess', ({ guess }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'player-submit' || room.playerGuessResolved) return;
    const ids = room.players.map((p) => p.socketId);
    const otherId = ids.find((id) => id !== socket.id);
    const teamMine = room.resolvedTeams[socket.id];
    const teamOther = room.resolvedTeams[otherId];

    const result = validateGuess(guess, teamMine.id, teamOther.id);
    if (!result.ok) {
      socket.emit('guessRejected', { reason: result.reason, guess });
      return;
    }

    room.playerGuessResolved = true;
    clearTimer(room);
    room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;

    io.to(room.id).emit('roundResult', {
      winnerSocketId: socket.id,
      playerName: result.playerName,
      scores: scoresForClient(room),
    });

    if (room.round >= MAX_ROUNDS) {
      room.timer = setTimeout(() => endGame(room), NEXT_ROUND_DELAY_MS);
    } else {
      room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
    }
  });

  socket.on('leaveRoom', () => cleanupSocket(socket));

  socket.on('disconnect', () => {
    const idx = queue.findIndex((s) => s.id === socket.id);
    if (idx !== -1) queue.splice(idx, 1);
    if (socket.data.pendingCode) codeRooms.delete(socket.data.pendingCode);
    cleanupSocket(socket, true);
  });
});

function cleanupSocket(socket, disconnected = false) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimer(room);
  socket.to(roomId).emit('opponentLeft', { disconnected });
  rooms.delete(roomId);
  socket.data.roomId = null;
}

server.listen(PORT, () => {
  console.log(`3-2-1 Futbol server listening on port ${PORT}`);
});
