// Accounts, the leaderboard, and everything ranked.
//
// Kept apart from app.js because none of it touches the live game loop: it
// talks to the HTTP API, while app.js talks over the socket. The only thing
// the two share is the session token, which app.js sends on the handshake so
// the server knows whose match it is recording.

const Accounts = (() => {
  const TOKEN_KEY = (window.__BRAND && window.__BRAND.storageKeys.token) || '321futbol.token';

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

  // Three states, not two. "No accounts in this deployment" and "accounts are
  // configured but the service is not ready yet" look identical to a client that
  // only asks whether the feature works, and they are not the same thing at all:
  // the second one is temporary, so a page that is already open has to be able
  // to come back from it without being reloaded.
  const DISABLED = 'disabled';        // this deployment runs without accounts
  const UNAVAILABLE = 'unavailable';  // configured, not ready — keep checking
  const READY = 'ready';
  let status = DISABLED;

  // Bounded backoff. A page left open while the server comes up should find its
  // own way back, but it must not turn into a permanent poller: the steps grow,
  // the last one repeats, and after MAX_RECHECKS the page stops on its own and
  // leaves the retry button as the way forward.
  const RECHECK_STEPS_MS = [3000, 6000, 12000, 24000, 30000];
  const MAX_RECHECKS = 20;
  let recheckTimer = null;
  let recheckCount = 0;

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

  /**
   * The line that tells a player why the sign-in button is not there. Only
   * shown for UNAVAILABLE: a deployment without accounts should not advertise
   * an absence, but a service that is coming up should say so rather than look
   * like a missing feature.
   */
  function paintAccountNotice() {
    const notice = $('accountNotice');
    if (!notice) return;
    notice.classList.toggle('hidden', status !== UNAVAILABLE);
    if (status !== UNAVAILABLE) return;
    const stopped = !recheckTimer && recheckCount >= MAX_RECHECKS;
    $('accountNoticeText').textContent = stopped
      ? 'Hesap sistemi hâlâ hazır değil. Misafir olarak oynamaya devam edebilirsin.'
      : 'Hesap sistemi şu an hazır değil, bağlanmayı denemeyi sürdürüyoruz.'
        + ' Misafir olarak oynayabilirsin.';
  }

  function paintAccountCard() {
    const card = $('accountCard');
    card.classList.toggle('hidden', !me);
    $('btnAuth').classList.toggle('hidden', !enabled || Boolean(me));
    $('btnBoard').classList.toggle('hidden', !enabled);
    paintAccountNotice();
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
    const { ok, status: httpStatus, body } = await api('/api/me');
    if (ok && body.player) {
      me = body.player;
    } else if (httpStatus === 401 || (body && body.reason === 'not_signed_in')) {
      // Expired, revoked or unknown token: drop it instead of retrying forever.
      saveToken('');
      me = null;
    } else {
      // The service could not answer — 503 while the database is away, or a
      // request that never arrived. The session is not the thing that is wrong,
      // so the token STAYS: throwing it away here would sign a player out for
      // good over an outage that lasted a few seconds. The account surface
      // steps back to "not ready" and comes back on its own.
      me = null;
      if (status === READY) {
        status = UNAVAILABLE;
        enabled = false;
        scheduleRecheck();
      }
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
    forget();
  }

  /**
   * Drops this browser's session without telling the server — for when the
   * server is the one that ended it (signed out from another device, or the
   * account was deleted). Keeping the token after that leaves a signed-in
   * looking UI presenting a credential that no longer works.
   */
  function forget() {
    saveToken('');
    me = null;
    paintAccountCard();
    notify();
  }

  // ------------------------------------------------------------- service state

  function cancelRecheck() {
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = null;
  }

  function scheduleRecheck() {
    cancelRecheck();
    if (status !== UNAVAILABLE) return;
    if (recheckCount >= MAX_RECHECKS) {
      paintAccountNotice(); // stops trying; the button is still there
      return;
    }
    const wait = RECHECK_STEPS_MS[Math.min(recheckCount, RECHECK_STEPS_MS.length - 1)];
    recheckCount += 1;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      readConfig();
    }, wait);
  }

  /**
   * Reads the service state and applies it.
   *
   * Runs on load and on every recheck. It touches nothing but the account
   * surface — no socket, no screen change — so a match in progress carries on
   * regardless of what it finds. When the service becomes ready it re-verifies
   * the stored session, which is what brings a signed-in player's card back.
   */
  async function readConfig() {
    const { ok, body } = await api('/api/config');
    if (ok) {
      tiers = (body && body.tiers) || tiers;
      minPassword = (body && body.minPasswordLength) || minPassword;
      $('authHint').textContent =
        `Oyunda bu isimle görüneceksin. Şifre en az ${minPassword} karakter. E-posta istemiyoruz.`;
    }

    const was = status;
    if (!ok) {
      // A request that never arrived says nothing about configuration. Treat it
      // as the retryable state rather than claiming this deployment has no
      // accounts — that claim would stick until a reload.
      status = UNAVAILABLE;
    } else if (body.accountsEnabled) {
      status = READY;
    } else {
      status = body.accountsConfigured ? UNAVAILABLE : DISABLED;
    }
    enabled = status === READY;
    paintAccountCard();

    if (status === UNAVAILABLE) {
      scheduleRecheck();
      return status;
    }
    cancelRecheck();
    if (status === READY && was !== READY) {
      recheckCount = 0;
      await refreshMe();
    }
    return status;
  }

  /** The manual way on, for a player who does not want to wait out the backoff. */
  async function retryNow() {
    recheckCount = 0;
    cancelRecheck();
    const btn = $('btnAccountRetry');
    if (btn) btn.disabled = true;
    try {
      return await readConfig();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --------------------------------------------------------------------- init

  async function init() {
    await readConfig();

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
    const retryButton = $('btnAccountRetry');
    if (retryButton) retryButton.addEventListener('click', retryNow);
  }

  return {
    init,
    getToken: () => token,
    isEnabled: () => enabled,
    /** 'disabled' | 'unavailable' | 'ready' — see the constants above. */
    getStatus: () => status,
    readConfig,
    retryNow,
    getMe: () => me,
    setMe: (player) => { me = player; paintAccountCard(); },
    forget,
    onChange: (fn) => changeHandlers.push(fn),
    refreshMe,
  };
})();
