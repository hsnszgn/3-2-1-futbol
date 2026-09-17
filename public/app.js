// The token rides along on the handshake so the server knows which account
// this socket belongs to before the first event arrives.
const BRAND = window.__BRAND || { name: '3-2-1 Futbol' };

const socket = io({ auth: { token: Accounts.getToken() } });

const screens = {
  lobby: document.getElementById('screen-lobby'),
  auth: document.getElementById('screen-auth'),
  board: document.getElementById('screen-board'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  over: document.getElementById('screen-over'),
};

function showScreen(name) {
  for (const key in screens) screens[key].classList.toggle('active', key === name);
  // The mute button sits in a different corner during a game — see style.css.
  document.body.classList.toggle('in-game', name === 'game');
}

const btnMute = document.getElementById('btnMute');
const verdictPoints = document.getElementById('verdictPoints');

function paintMuteButton() {
  btnMute.textContent = Sound.isMuted() ? '🔇' : '🔊';
}
paintMuteButton();
btnMute.addEventListener('click', () => {
  Sound.toggleMute();
  paintMuteButton();
});
// Audio can only start from a user gesture; any lobby tap counts.
document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

// Signing in or out changes who the server thinks we are, and the handshake
// only happens once — so reconnect to carry the new token.
Accounts.onChange((player) => {
  socket.auth = { token: Accounts.getToken() };
  if (player && !nameInput.value.trim()) nameInput.value = player.displayName;
  if (socket.connected) {
    socket.disconnect();
    socket.connect();
  }
});
Accounts.init();

const nameInput = document.getElementById('nameInput');
const codeInput = document.getElementById('codeInput');
const lobbyStatus = document.getElementById('lobbyStatus');
const waitingText = document.getElementById('waitingText');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const btnShareInvite = document.getElementById('btnShareInvite');
const shareStatus = document.getElementById('shareStatus');
let currentInviteCode = null;

const inviteUrlFor = (code) => `${location.origin}/?oda=${code}`;


document.getElementById('btnQuickMatch').addEventListener('click', () => {
  lobbyStatus.textContent = '';
  waitingText.textContent = 'Rakip aranıyor...';
  roomCodeDisplay.textContent = '';
  hideShareInvite();
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
  hideShareInvite();
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

function hideShareInvite() {
  currentInviteCode = null;
  btnShareInvite.classList.add('hidden');
  shareStatus.textContent = '';
}

socket.on('privateRoomCreated', ({ code }) => {
  currentInviteCode = code;
  waitingText.textContent = 'Arkadaşını davet et';
  roomCodeDisplay.textContent = code;
  btnShareInvite.classList.remove('hidden');
  shareStatus.textContent = '';
});

// One tap to hand someone a link that drops them straight into this room —
// typing a code by hand is where an invite usually dies.
btnShareInvite.addEventListener('click', async () => {
  if (!currentInviteCode) return;
  const url = inviteUrlFor(currentInviteCode);
  const text = `3-2-1 Futbol'da sana meydan okuyorum! Odama katıl: ${url}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: BRAND.name, text, url });
      return;
    } catch (err) {
      return; // user dismissed the share sheet
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    shareStatus.textContent = 'Link kopyalandı, arkadaşına yapıştır!';
  } catch (err) {
    shareStatus.textContent = url;
  }
});

// Arriving from an invite link: prefill the code so joining is one tap.
const inviteFromUrl = (new URLSearchParams(location.search).get('oda') || '')
  .trim().toUpperCase().slice(0, 6);
if (inviteFromUrl) {
  codeInput.value = inviteFromUrl;
  document.getElementById('inviteCode').textContent = inviteFromUrl;
  document.getElementById('inviteBanner').classList.remove('hidden');
  document.getElementById('btnJoinRoom').classList.replace('btn-ghost', 'btn-primary');
  document.getElementById('btnQuickMatch').classList.replace('btn-primary', 'btn-ghost');
  nameInput.focus();
}

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
let timerBarTeam = document.getElementById('timerBarTeam');
let resultText = document.getElementById('resultText');
let verdictBox = document.getElementById('verdictBox');
let verdictMark = document.getElementById('verdictMark');
let teamLockedName = document.getElementById('teamLockedName');
let roundPips = document.getElementById('roundPips');
let vignette = document.getElementById('vignette');
let maxRounds = 5;
let currentRound = 1;
let opponentTeamCache = null;
let guessTimerInterval = null;
let teamTimerInterval = null;
let revealTimer = null;

function buzz(ms) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function renderPips(round) {
  if (roundPips.children.length !== maxRounds) {
    roundPips.innerHTML = '';
    for (let i = 0; i < maxRounds; i++) roundPips.appendChild(document.createElement('i'));
  }
  [...roundPips.children].forEach((pip, i) => {
    pip.classList.toggle('current', i === round - 1 && !pip.classList.contains('won') && !pip.classList.contains('lost'));
  });
}

function markPip(round, outcome) {
  const pip = roundPips.children[round - 1];
  if (!pip) return;
  pip.classList.remove('current');
  if (outcome) pip.classList.add(outcome);
}

socket.on('connect', () => {
  mySocketId = socket.id;
});

socket.on('matched', ({ opponentName, myName: serverName, maxRounds: mr }) => {
  oppName = opponentName;
  maxRounds = mr;
  h2hBanner.classList.add('hidden');
  overH2h.classList.add('hidden');
  overStats.classList.add('hidden');
  // A signed-in player is named by their account, so the scoreboard and the
  // leaderboard always agree.
  const myName = serverName || nameInput.value.trim() || 'Sen';
  document.getElementById('myName').textContent = myName;
  document.getElementById('oppName').textContent = oppName;
  document.getElementById('myAvatar').textContent = myName.charAt(0).toUpperCase();
  document.getElementById('oppAvatar').textContent = (oppName || 'R').charAt(0).toUpperCase();
  roundPips.innerHTML = '';
  showScreen('game');
});

const h2hBanner = document.getElementById('h2hBanner');
const overH2h = document.getElementById('overH2h');
const overStats = document.getElementById('overStats');

// "Aranızda 3-1 öndesin" — the running series, only ever sent when both
// players are signed in and have met before.
socket.on('headToHead', ({ games, myWins, theirWins, draws }) => {
  const lead = myWins > theirWins ? 'öndesin'
    : myWins < theirWins ? 'gerideysin'
    : 'berabersiniz';
  const drawNote = draws ? ` · ${draws} beraberlik` : '';
  const text = `Aranızda ${games} maç · ${myWins}-${theirWins} ${lead}${drawNote}`;
  for (const el of [h2hBanner, overH2h]) {
    el.textContent = text;
    el.classList.remove('hidden');
  }
});

// Sent right after a recorded game, so the new standing is visible without
// having to open the leaderboard.
socket.on('statsUpdate', ({ me }) => {
  if (!me) return;
  Accounts.setMe(me);
  overStats.textContent = `${me.points} puan · ${me.wins}G ${me.draws}B ${me.losses}M`
    + ` · ${me.tier ? me.tier.label : ''}${me.rank ? ` · #${me.rank}` : ''}`;
  overStats.classList.remove('hidden');
  if (me.tier) overStats.style.color = me.tier.color;
});

function hideAllPhases() {
  [countdownDisplay, teamPhase, revealPhase, guessPhase, resultPhase].forEach((el) => {
    el.classList.add('hidden');
  });
  countdownDisplay.textContent = '';
}

socket.on('roundStart', ({ round, maxRounds: mr, scores }) => {
  clearPendingTeam();
  clearTimeout(revealTimer);
  maxRounds = mr;
  currentRound = round;
  roundLabel.textContent = `Tur ${round}/${maxRounds}`;
  renderPips(round);
  updateScores(scores);
  hideAllPhases();
  teamPhase.classList.remove('locked');
  teamInput.value = '';
  guessInput.value = '';
  teamFeedback.textContent = '';
  guessFeedback.textContent = '';
  teamOppStatus.textContent = '';
  opponentTeamCache = null;
  clearInterval(guessTimerInterval);
  clearInterval(teamTimerInterval);
  vignette.classList.remove('active');
});

socket.on('countdown', ({ value }) => {
  hideAllPhases();
  countdownDisplay.classList.remove('hidden');
  countdownDisplay.classList.toggle('go', value === 'GO');
  countdownDisplay.textContent = value;
  // Restart the pop animation on every beat.
  countdownDisplay.style.animation = 'none';
  void countdownDisplay.offsetWidth;
  countdownDisplay.style.animation = '';
  buzz(value === 'GO' ? 25 : 12);
  if (value === 'GO') Sound.go(); else Sound.tick();
});

socket.on('openTeamSubmit', ({ timeoutMs }) => {
  hideAllPhases();
  teamPhase.classList.remove('hidden', 'locked');
  teamInput.disabled = false;
  btnSubmitTeam.disabled = false;
  teamInput.value = '';
  teamInput.focus();
  runTimer(timerBarTeam, timeoutMs, (id) => { teamTimerInterval = id; }, () => teamTimerInterval);
});

// Drains a timer bar and turns it red for the last quarter, so time pressure
// reads as colour and motion rather than just a shrinking width.
function runTimer(bar, timeoutMs, setId, getId, onLow) {
  clearInterval(getId());
  const start = Date.now();
  bar.style.width = '100%';
  bar.classList.remove('low');
  const id = setInterval(() => {
    const pct = Math.max(0, 100 - ((Date.now() - start) / timeoutMs) * 100);
    bar.style.width = pct + '%';
    if (pct <= 28) {
      bar.classList.add('low');
      if (onLow) onLow();
    }
    if (pct <= 0) clearInterval(getId());
  }, 100);
  setId(id);
}

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

let pendingTeamTimer = null;

function clearPendingTeam() {
  if (pendingTeamTimer) {
    clearTimeout(pendingTeamTimer);
    pendingTeamTimer = null;
  }
}

function submitTeam() {
  const val = teamInput.value.trim();
  if (!val || teamInput.disabled) return;
  socket.emit('submitTeam', { team: val });

  // An unknown club is looked up live, which takes a moment — say so rather
  // than leaving the button looking dead.
  teamFeedback.textContent = 'Kontrol ediliyor...';
  teamFeedback.className = 'feedback';
  clearPendingTeam();
  pendingTeamTimer = setTimeout(() => {
    teamFeedback.textContent = 'Takım aranıyor, bekle...';
  }, 2000);
}

socket.on('teamAccepted', ({ display }) => {
  clearPendingTeam();
  teamInput.disabled = true;
  btnSubmitTeam.disabled = true;
  teamLockedName.textContent = display;
  teamPhase.classList.add('locked');
  Sound.lock();
  teamFeedback.textContent = '';
  teamFeedback.className = 'feedback';
  teamOppStatus.textContent = 'Rakip bekleniyor...';
});

socket.on('teamRejected', () => {
  clearPendingTeam();
  teamFeedback.textContent = 'Tanınmayan takım adı, tekrar dene.';
  teamFeedback.className = 'feedback error';
});

socket.on('opponentTeamStatus', ({ submittedBy }) => {
  if (submittedBy.length !== 1) return;
  if (submittedBy[0] === mySocketId) {
    teamOppStatus.textContent = 'Rakip hâlâ yazıyor...';
  } else {
    teamOppStatus.textContent = `${oppName} hazır — sıra sende!`;
    buzz(15);
    Sound.opponentReady();
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

  clearInterval(teamTimerInterval);
  buzz(20);

  // The pause on the reveal is the drama — don't rush past it.
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    hideAllPhases();
    guessPhase.classList.remove('hidden');
    guessInput.disabled = false;
    btnSubmitGuess.disabled = false;
    guessInput.value = '';
    guessInput.focus();
    runTimer(
      timerBar,
      timeoutMs,
      (id) => { guessTimerInterval = id; },
      () => guessTimerInterval,
      () => vignette.classList.add('active'),
    );
  }, 1600);
});

document.getElementById('guessInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitGuess();
});
document.getElementById('btnSubmitGuess').addEventListener('click', submitGuess);
guessInput.addEventListener('focus', () => scrollButtonIntoView(btnSubmitGuess));

let pendingGuessTimer = null;

function clearPendingGuess() {
  if (pendingGuessTimer) {
    clearTimeout(pendingGuessTimer);
    pendingGuessTimer = null;
  }
}

function submitGuess() {
  const val = guessInput.value.trim();
  if (!val || guessInput.disabled) return;
  guessFeedback.textContent = 'Kontrol ediliyor...';
  guessFeedback.className = 'feedback';
  socket.emit('submitGuess', { guess: val });

  // Never let a slow answer look like a dead button.
  clearPendingGuess();
  pendingGuessTimer = setTimeout(() => {
    guessFeedback.textContent = 'Doğrulama uzun sürüyor, bekle...';
    guessFeedback.className = 'feedback';
  }, 3000);
}

const GUESS_REJECT_MESSAGES = {
  player_not_found: 'Bu isimde, iki takımda da oynamış bir futbolcu bulunamadı.',
  no_common_team: 'Bu oyuncu bu iki takımda birlikte oynamamış.',
  lookup_failed: 'Doğrulama servisine şu an ulaşılamıyor, birkaç saniye sonra tekrar dene.',
  team_not_found: 'Bu takımlardan biri veri kaynağında bulunamadı.',
  no_common_players: 'Bu iki takımda birlikte oynamış futbolcu bulunamadı.',
};

socket.on('guessRejected', ({ reason }) => {
  clearPendingGuess();
  guessFeedback.textContent = GUESS_REJECT_MESSAGES[reason] || 'Geçersiz cevap, tekrar dene.';
  guessFeedback.className = 'feedback error';
  guessInput.value = '';
  Sound.reject();
});

socket.on('lookupIssue', ({ reason }) => {
  guessFeedback.textContent = GUESS_REJECT_MESSAGES[reason] || 'Doğrulama servisinde bir sorun oluştu.';
  guessFeedback.className = 'feedback error';
});

// The round was already won while this guess was on its way — the answer
// wasn't wrong, the opponent was simply faster.
socket.on('guessTooLate', () => {
  clearPendingGuess();
  guessFeedback.textContent = 'Rakip senden hızlı davrandı!';
  guessFeedback.className = 'feedback error';
  guessInput.disabled = true;
  btnSubmitGuess.disabled = true;
});

socket.on('roundResult', ({ winnerSocketId, playerName, points, elapsedMs, scores }) => {
  clearPendingGuess();
  clearTimeout(revealTimer);
  clearInterval(guessTimerInterval);
  vignette.classList.remove('active');
  hideAllPhases();
  resultPhase.classList.remove('hidden');
  updateScores(scores);

  const iWon = winnerSocketId === mySocketId;
  verdictBox.className = `verdict ${iWon ? 'win' : 'lose'}`;
  verdictMark.textContent = iWon ? '✓' : '✕';

  const seconds = ((elapsedMs || 0) / 1000).toFixed(1);
  if (iWon) {
    verdictPoints.textContent = `+${points}`;
    verdictPoints.classList.remove('hidden');
    resultText.textContent = `${seconds} saniyede buldun!\n${playerName}`;
  } else {
    verdictPoints.classList.add('hidden');
    resultText.textContent = `${oppName} senden hızlıydı: ${seconds} sn (+${points})\nDoğru cevap: ${playerName}`;
  }
  resultText.style.whiteSpace = 'pre-line';
  markPip(currentRound, iWon ? 'won' : 'lost');
  buzz(iWon ? [18, 60, 18] : 40);
  if (iWon) Sound.win(); else Sound.lose();
});

socket.on('roundVoid', ({ reason }) => {
  clearPendingGuess();
  clearTimeout(revealTimer);
  clearInterval(guessTimerInterval);
  clearInterval(teamTimerInterval);
  vignette.classList.remove('active');
  hideAllPhases();
  resultPhase.classList.remove('hidden');
  const messages = {
    timeout_team: 'Süre doldu, takım yazılmadı.\nTur tekrarlanıyor.',
    same_team: 'Aynı takımı yazdınız!\nTur tekrarlanıyor.',
    timeout_guess: 'Kimse doğru oyuncuyu bulamadı.',
    no_common_players: 'Bu iki takımda birlikte oynamış futbolcu yok.\nTur tekrarlanıyor.',
  };
  verdictBox.className = 'verdict';
  verdictMark.textContent = '–';
  verdictPoints.classList.add('hidden');
  resultText.textContent = messages[reason] || 'Tur tekrarlanıyor.';
  resultText.style.whiteSpace = 'pre-line';
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
  document.getElementById('btnRematch').disabled = false;
  document.getElementById('rematchStatus').textContent = '';
  const title = document.getElementById('overTitle');
  const overScore = document.getElementById('overScore');
  const oppId = Object.keys(scores).find((id) => id !== mySocketId);
  if (!winnerSocketId) {
    title.textContent = 'Berabere';
  } else {
    title.textContent = winnerSocketId === mySocketId ? 'Kazandın' : `${oppName} Kazandı`;
  }
  title.style.color = winnerSocketId === mySocketId ? '#2ecc71' : '';
  overScore.textContent = `${scores[mySocketId] ?? 0} - ${(oppId && scores[oppId]) || 0}`;
  buzz(winnerSocketId === mySocketId ? [20, 70, 20, 70, 30] : 45);
  if (winnerSocketId === mySocketId) Sound.gameWin(); else Sound.gameLose();
});

socket.on('opponentLeft', () => {
  showScreen('lobby');
  document.getElementById('rematchStatus').textContent = '';
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

const btnRematch = document.getElementById('btnRematch');
const rematchStatus = document.getElementById('rematchStatus');

btnRematch.addEventListener('click', () => {
  btnRematch.disabled = true;
  rematchStatus.textContent = 'Rakip bekleniyor...';
  rematchStatus.className = 'status-line';
  socket.emit('requestRematch');
});

document.getElementById('btnBackToLobby').addEventListener('click', () => {
  socket.emit('leaveRoom');
  showScreen('lobby');
  lobbyStatus.textContent = '';
});

socket.on('rematchWaiting', () => {
  rematchStatus.textContent = 'Rakip bekleniyor...';
  rematchStatus.className = 'status-line';
});

socket.on('opponentWantsRematch', () => {
  rematchStatus.textContent = `${oppName} rövanş istiyor!`;
  rematchStatus.className = 'status-line wants';
  buzz(20);
});

socket.on('rematchStarting', () => {
  btnRematch.disabled = false;
  rematchStatus.textContent = '';
  roundPips.innerHTML = '';
  showScreen('game');
});
