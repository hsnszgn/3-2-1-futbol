const socket = io();

const screens = {
  lobby: document.getElementById('screen-lobby'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  over: document.getElementById('screen-over'),
};

function showScreen(name) {
  for (const key in screens) screens[key].classList.toggle('active', key === name);
}

const nameInput = document.getElementById('nameInput');
const codeInput = document.getElementById('codeInput');
const lobbyStatus = document.getElementById('lobbyStatus');
const waitingText = document.getElementById('waitingText');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');

document.getElementById('btnQuickMatch').addEventListener('click', () => {
  lobbyStatus.textContent = '';
  waitingText.textContent = 'Rakip aranıyor...';
  roomCodeDisplay.textContent = '';
  showScreen('waiting');
  socket.emit('joinQueue', { name: nameInput.value });
});

document.getElementById('btnCreateRoom').addEventListener('click', () => {
  lobbyStatus.textContent = '';
  showScreen('waiting');
  waitingText.textContent = 'Arkadaşın katılmasını bekliyoruz...';
  socket.emit('createPrivateRoom', { name: nameInput.value });
});

document.getElementById('btnJoinRoom').addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!code) {
    lobbyStatus.textContent = 'Bir oda kodu gir.';
    return;
  }
  lobbyStatus.textContent = '';
  showScreen('waiting');
  waitingText.textContent = 'Odaya bağlanılıyor...';
  roomCodeDisplay.textContent = '';
  socket.emit('joinPrivateRoom', { name: nameInput.value, code });
});

document.getElementById('btnCancelWait').addEventListener('click', () => {
  socket.disconnect();
  socket.connect();
  showScreen('lobby');
});

socket.on('waiting', () => {
  waitingText.textContent = 'Rakip aranıyor...';
});

socket.on('privateRoomCreated', ({ code }) => {
  waitingText.textContent = 'Bu kodu arkadaşınla paylaş:';
  roomCodeDisplay.textContent = code;
});

socket.on('errorMessage', ({ message }) => {
  showScreen('lobby');
  lobbyStatus.textContent = message;
});

// --- GAME STATE ---
let mySocketId = null;
let oppName = '';
let myScoreEl = document.getElementById('myScore');
let oppScoreEl = document.getElementById('oppScore');
let roundLabel = document.getElementById('roundLabel');
let countdownDisplay = document.getElementById('countdownDisplay');
let teamPhase = document.getElementById('teamPhase');
let revealPhase = document.getElementById('revealPhase');
let guessPhase = document.getElementById('guessPhase');
let resultPhase = document.getElementById('resultPhase');
let teamInput = document.getElementById('teamInput');
let btnSubmitTeam = document.getElementById('btnSubmitTeam');
let teamFeedback = document.getElementById('teamFeedback');
let teamOppStatus = document.getElementById('teamOppStatus');
let guessInput = document.getElementById('guessInput');
let btnSubmitGuess = document.getElementById('btnSubmitGuess');
let guessFeedback = document.getElementById('guessFeedback');
let timerBar = document.getElementById('timerBar');
let resultText = document.getElementById('resultText');
let maxRounds = 5;
let opponentTeamCache = null;
let guessTimerInterval = null;

socket.on('connect', () => {
  mySocketId = socket.id;
});

socket.on('matched', ({ opponentName, maxRounds: mr }) => {
  oppName = opponentName;
  maxRounds = mr;
  document.getElementById('myName').textContent = nameInput.value.trim() || 'Sen';
  document.getElementById('oppName').textContent = oppName;
  showScreen('game');
});

function hideAllPhases() {
  [countdownDisplay, teamPhase, revealPhase, guessPhase, resultPhase].forEach((el) => {
    el.classList.add('hidden');
  });
  countdownDisplay.textContent = '';
}

socket.on('roundStart', ({ round, maxRounds: mr, scores }) => {
  maxRounds = mr;
  roundLabel.textContent = `Round ${round}/${maxRounds}`;
  updateScores(scores);
  hideAllPhases();
  teamInput.value = '';
  guessInput.value = '';
  teamFeedback.textContent = '';
  guessFeedback.textContent = '';
  teamOppStatus.textContent = '';
  opponentTeamCache = null;
  clearInterval(guessTimerInterval);
});

socket.on('countdown', ({ value }) => {
  hideAllPhases();
  countdownDisplay.classList.remove('hidden');
  countdownDisplay.textContent = value;
});

socket.on('openTeamSubmit', () => {
  hideAllPhases();
  teamPhase.classList.remove('hidden');
  teamInput.disabled = false;
  btnSubmitTeam.disabled = false;
  teamInput.value = '';
  teamInput.focus();
});

document.getElementById('teamInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitTeam();
});
document.getElementById('btnSubmitTeam').addEventListener('click', submitTeam);
teamInput.addEventListener('focus', () => scrollButtonIntoView(btnSubmitTeam));

function scrollButtonIntoView(btn) {
  // Mobile keyboards shrink the visual viewport after a short animation,
  // so wait a beat before scrolling the submit button into view.
  setTimeout(() => {
    btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 300);
}

function submitTeam() {
  const val = teamInput.value.trim();
  if (!val || teamInput.disabled) return;
  socket.emit('submitTeam', { team: val });
}

socket.on('teamAccepted', ({ display }) => {
  teamInput.disabled = true;
  btnSubmitTeam.disabled = true;
  teamFeedback.textContent = `✓ ${display} gönderildi. Rakip bekleniyor...`;
  teamFeedback.className = 'feedback ok';
});

socket.on('teamRejected', () => {
  teamFeedback.textContent = 'Tanınmayan takım adı, tekrar dene.';
  teamFeedback.className = 'feedback error';
});

socket.on('opponentTeamStatus', ({ submittedBy }) => {
  if (submittedBy.length === 1) {
    teamOppStatus.textContent = submittedBy[0] === mySocketId
      ? 'Rakip henüz yazmadı...'
      : 'Rakip yazdı, sıra sende!';
  }
});

socket.on('teamsRevealed', ({ teams, timeoutMs }) => {
  hideAllPhases();
  revealPhase.classList.remove('hidden');
  const myTeam = teams[mySocketId];
  const oppId = Object.keys(teams).find((id) => id !== mySocketId);
  const oppTeam = teams[oppId];
  opponentTeamCache = oppTeam;
  document.getElementById('revealMyTeam').textContent = myTeam.display;
  document.getElementById('revealOppTeam').textContent = oppTeam.display;
  document.getElementById('revealOppLabel').textContent = oppTeam.name.toUpperCase();

  setTimeout(() => {
    hideAllPhases();
    guessPhase.classList.remove('hidden');
    guessInput.disabled = false;
    btnSubmitGuess.disabled = false;
    guessInput.value = '';
    guessInput.focus();
    startGuessTimer(timeoutMs);
  }, 1600);
});

function startGuessTimer(timeoutMs) {
  clearInterval(guessTimerInterval);
  const start = Date.now();
  timerBar.style.width = '100%';
  guessTimerInterval = setInterval(() => {
    const elapsed = Date.now() - start;
    const pct = Math.max(0, 100 - (elapsed / timeoutMs) * 100);
    timerBar.style.width = pct + '%';
    if (elapsed >= timeoutMs) clearInterval(guessTimerInterval);
  }, 100);
}

document.getElementById('guessInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitGuess();
});
document.getElementById('btnSubmitGuess').addEventListener('click', submitGuess);
guessInput.addEventListener('focus', () => scrollButtonIntoView(btnSubmitGuess));

function submitGuess() {
  const val = guessInput.value.trim();
  if (!val || guessInput.disabled) return;
  socket.emit('submitGuess', { guess: val });
}

socket.on('guessRejected', ({ reason }) => {
  guessFeedback.textContent = reason === 'player_not_found'
    ? 'Bu isimde bir futbolcu bulunamadı.'
    : 'Bu oyuncu bu iki takımda birlikte oynamamış.';
  guessFeedback.className = 'feedback error';
  guessInput.value = '';
});

socket.on('roundResult', ({ winnerSocketId, playerName, scores }) => {
  clearInterval(guessTimerInterval);
  hideAllPhases();
  resultPhase.classList.remove('hidden');
  updateScores(scores);
  const iWon = winnerSocketId === mySocketId;
  resultText.textContent = iWon
    ? `Sen kazandın! (${playerName})`
    : `${oppName} kazandı! (${playerName})`;
  resultText.style.color = iWon ? '#2ecc71' : '#e74c3c';
});

socket.on('roundVoid', ({ reason }) => {
  clearInterval(guessTimerInterval);
  hideAllPhases();
  resultPhase.classList.remove('hidden');
  const messages = {
    timeout_team: 'Süre doldu, takım yazılmadı. Round tekrarlanıyor.',
    same_team: 'Aynı takımı yazdınız! Round tekrarlanıyor.',
    timeout_guess: 'Kimse doğru oyuncuyu bulamadı. Round tekrarlanıyor.',
  };
  resultText.textContent = messages[reason] || 'Round tekrarlanıyor.';
  resultText.style.color = '#7a7a88';
});

function updateScores(scores) {
  const ids = Object.keys(scores);
  const oppId = ids.find((id) => id !== mySocketId);
  myScoreEl.textContent = scores[mySocketId] ?? 0;
  oppScoreEl.textContent = oppId ? scores[oppId] ?? 0 : 0;
}

socket.on('gameOver', ({ scores, winnerSocketId }) => {
  updateScores(scores);
  showScreen('over');
  const title = document.getElementById('overTitle');
  const overScore = document.getElementById('overScore');
  if (!winnerSocketId) {
    title.textContent = 'Berabere!';
  } else {
    title.textContent = winnerSocketId === mySocketId ? 'Kazandın! 🏆' : `${oppName} Kazandı`;
  }
  overScore.textContent = `${scores[mySocketId] ?? 0} - ${Object.values(scores).find((v, i) => Object.keys(scores)[i] !== mySocketId) ?? 0}`;
});

socket.on('opponentLeft', () => {
  showScreen('lobby');
  lobbyStatus.textContent = 'Rakip bağlantıyı kopardı.';
});

let connectionNotice = null;
socket.on('opponentDisconnectedTemporarily', () => {
  connectionNotice = teamFeedback.textContent || guessFeedback.textContent;
  teamFeedback.textContent = 'Rakibin bağlantısı geçici olarak koptu, bekleniyor...';
  teamFeedback.className = 'feedback error';
  guessFeedback.textContent = 'Rakibin bağlantısı geçici olarak koptu, bekleniyor...';
  guessFeedback.className = 'feedback error';
});
socket.on('opponentReconnected', () => {
  teamFeedback.textContent = connectionNotice || '';
  guessFeedback.textContent = connectionNotice || '';
});

socket.io.on('reconnect', () => {
  // Our own connection dropped and came back — re-announce identity/room
  // membership isn't needed (connection state recovery restores it
  // server-side), but let the player know play can continue.
  if (screens.game.classList.contains('active')) {
    lobbyStatus.textContent = '';
  }
});

document.getElementById('btnRematch').addEventListener('click', () => {
  showScreen('lobby');
  lobbyStatus.textContent = '';
});
