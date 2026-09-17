// Accounts, the leaderboard, and everything ranked.
//
// Kept apart from app.js because none of it touches the live game loop: it
// talks to the HTTP API, while app.js talks over the socket. The only thing
// the two share is the session token, which app.js sends on the handshake so
// the server knows whose match it is recording.

const Accounts = (() => {
  const TOKEN_KEY = '321futbol.token';

  let token = '';
  try {
    token = localStorage.getItem(TOKEN_KEY) || '';
  } catch (err) {
    token = ''; // private browsing — stay signed out rather than crash
  }

  let me = null;
  let enabled = false;
  let tiers = [];
  const changeHandlers = [];

  const $ = (id) => document.getElementById(id);
  const notify = () => changeHandlers.forEach((fn) => fn(me));

  function saveToken(value) {
    token = value || '';
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (err) { /* nothing we can do; the session just won't survive a reload */ }
  }

  // The token goes in a header rather than the URL, so it stays out of logs
  // and browser history.
  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  // ---------------------------------------------------------------- rendering

  function tierBadge(el, tier) {
    el.textContent = tier ? tier.label : '';
    el.style.color = tier ? tier.color : '';
    el.style.borderColor = tier ? tier.color : '';
    el.classList.toggle('hidden', !tier);
  }

  function paintAccountCard() {
    const card = $('accountCard');
    card.classList.toggle('hidden', !me);
    $('btnAuth').classList.toggle('hidden', !enabled || Boolean(me));
    $('btnBoard').classList.toggle('hidden', !enabled);
    // Signed in, the account name is the name — asking for another one just
    // invites a mismatch with the leaderboard.
    $('nameInput').classList.toggle('hidden', Boolean(me));
    if (!me) return;

    $('accAvatar').textContent = (me.displayName || '?').charAt(0).toUpperCase();
    $('accName').textContent = me.displayName;
    tierBadge($('accTier'), me.tier);
    $('accPoints').textContent = me.points;
    $('accWins').textContent = me.wins;
    $('accDraws').textContent = me.draws;
    $('accLosses').textContent = me.losses;
    $('accRate').textContent = `${me.winRate}%`;
    $('accActivity').textContent = me.activity ? me.activity.label : '';
    // Someone who has not played yet has no place in the table; say so rather
    // than showing them a rank of nothing.
    $('accRank').textContent = me.games
      ? `${me.medal || ''} ${me.rank ? `#${me.rank}` : ''} · ${me.games} maç`.trim()
      : 'Henüz maç yok';
  }

  function paintLeaderboard(entries) {
    const list = $('boardList');
    list.innerHTML = '';
    if (!entries.length) {
      $('boardStatus').textContent = 'Henüz oynanmış maç yok. İlk sırayı sen kap.';
      return;
    }
    $('boardStatus').textContent = '';

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'board-row';
      if (me && entry.username === me.username) row.classList.add('is-me');
      if (entry.medal) row.classList.add('podium');
      row.style.setProperty('--tier-color', entry.tier ? entry.tier.color : '#888');

      row.innerHTML = `
        <span class="board-rank">${entry.medal || entry.rank}</span>
        <span class="board-id">
          <span class="board-name">${escapeHtml(entry.displayName)}</span>
          <span class="board-sub">
            <span class="badge tier-badge">${escapeHtml(entry.tier ? entry.tier.label : '')}</span>
            <span class="badge activity-badge">${escapeHtml(entry.activity ? entry.activity.label : '')}</span>
          </span>
        </span>
        <span class="board-nums">
          <span class="board-points">${entry.points}<i>p</i></span>
          <span class="board-wdl">
            <b class="stat-w">${entry.wins}</b>/<b class="stat-d">${entry.draws}</b>/<b class="stat-l">${entry.losses}</b>
          </span>
          <span class="board-avg">${entry.pointsPerGame} ort · %${entry.winRate}</span>
        </span>`;
      row.querySelector('.tier-badge').style.color = entry.tier ? entry.tier.color : '';
      row.querySelector('.tier-badge').style.borderColor = entry.tier ? entry.tier.color : '';
      list.appendChild(row);
    }
  }

  function paintLegend() {
    const legend = $('tierLegend');
    legend.innerHTML = '';
    // Ascending, so the ladder reads the way people climb it.
    for (const tier of [...tiers].reverse()) {
      const chip = document.createElement('span');
      chip.className = 'badge tier-badge';
      chip.textContent = `${tier.label} ${tier.minPoints}p+`;
      chip.style.color = tier.color;
      chip.style.borderColor = tier.color;
      legend.appendChild(chip);
    }
  }

  const escapeHtml = (text) => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ------------------------------------------------------------------ actions

  async function refreshMe() {
    if (!token || !enabled) {
      me = null;
      paintAccountCard();
      return null;
    }
    const { ok, body } = await api('/api/me');
    if (!ok || !body.player) {
      // Expired or unknown token: drop it instead of retrying forever.
      saveToken('');
      me = null;
    } else {
      me = body.player;
    }
    paintAccountCard();
    notify();
    return me;
  }

  async function openBoard() {
    showScreen('board');
    $('boardStatus').textContent = 'Yükleniyor...';
    const { ok, body } = await api('/api/leaderboard');
    if (!ok) {
      $('boardStatus').textContent = 'Lider tablosu şu an yüklenemedi.';
      return;
    }
    tiers = body.tiers || tiers;
    paintLegend();
    paintLeaderboard(body.entries || []);
  }

  let minPassword = 6;

  const REASONS = {
    invalid_username: 'Kullanıcı adı 3-16 karakter olmalı: küçük harf, rakam ve _',
    weak_password: () => `Şifre en az ${minPassword} karakter olmalı.`,
    username_taken: 'Bu kullanıcı adı alınmış.',
    bad_credentials: 'Kullanıcı adı veya şifre hatalı.',
    accounts_disabled: 'Kayıt sistemi şu an kapalı.',
    not_signed_in: 'Oturumun sona ermiş, tekrar giriş yap.',
    rate_limited: 'Çok fazla deneme yaptın. Biraz bekleyip tekrar dene.',
  };

  function reasonText(reason) {
    const text = REASONS[reason];
    return (typeof text === 'function' ? text() : text) || 'Bir şeyler ters gitti, tekrar dene.';
  }

  let mode = 'login';

  function setMode(next) {
    mode = next;
    $('tabLogin').classList.toggle('active', mode === 'login');
    $('tabRegister').classList.toggle('active', mode === 'register');
    $('btnAuthSubmit').textContent = mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
    // The hint explains what the username is used for; it only applies when
    // one is being chosen.
    $('authHint').classList.toggle('hidden', mode !== 'register');
    $('authStatus').textContent = '';
  }

  async function submitAuth() {
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value;
    const status = $('authStatus');

    if (!username || !password) {
      status.textContent = 'Kullanıcı adı ve şifre gerekli.';
      return;
    }

    $('btnAuthSubmit').disabled = true;
    status.textContent = 'Gönderiliyor...';
    // The username is the name: one thing to remember, nothing else to fill in.
    const payload = { username, password };
    const { ok, body } = await api(`/api/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('btnAuthSubmit').disabled = false;

    if (!ok || !body.token) {
      status.textContent = reasonText(body.reason);
      return;
    }
    saveToken(body.token);
    $('authPassword').value = '';
    status.textContent = '';
    await refreshMe();
    showScreen('lobby');
  }

  function logout() {
    // Tell the server first: while the token is still set, the request carries
    // it, and the session must end there and not just in this browser.
    api('/api/logout', { method: 'POST' }).catch(() => {});
    saveToken('');
    me = null;
    paintAccountCard();
    notify();
  }

  // --------------------------------------------------------------------- init

  async function init() {
    const { ok, body } = await api('/api/config');
    enabled = Boolean(ok && body.accountsEnabled);
    tiers = (body && body.tiers) || [];
    minPassword = (body && body.minPasswordLength) || minPassword;
    $('authHint').textContent =
      `Oyunda bu isimle görüneceksin. Şifre en az ${minPassword} karakter. E-posta istemiyoruz.`;
    paintAccountCard();
    if (enabled) await refreshMe();

    $('btnAuth').addEventListener('click', () => { setMode('login'); showScreen('auth'); });
    $('btnBoard').addEventListener('click', openBoard);
    $('btnLogout').addEventListener('click', logout);
    $('btnAuthBack').addEventListener('click', () => showScreen('lobby'));
    $('btnBoardBack').addEventListener('click', () => showScreen('lobby'));
    $('tabLogin').addEventListener('click', () => setMode('login'));
    $('tabRegister').addEventListener('click', () => setMode('register'));
    $('btnAuthSubmit').addEventListener('click', submitAuth);
    for (const id of ['authUsername', 'authPassword']) {
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    }
  }

  return {
    init,
    getToken: () => token,
    isEnabled: () => enabled,
    getMe: () => me,
    setMe: (player) => { me = player; paintAccountCard(); },
    onChange: (fn) => changeHandlers.push(fn),
    refreshMe,
  };
})();
