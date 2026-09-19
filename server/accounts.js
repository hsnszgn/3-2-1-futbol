// Accounts, sessions and the numbers behind the leaderboard.
//
// Passwords are hashed with scrypt from node:crypto rather than bcrypt: it is
// deliberately slow, built in, and keeps this project at zero native
// dependencies.

const crypto = require('crypto');
const db = require('./db');

const SCRYPT_KEYLEN = 64;
const USERNAME_RE = /^[a-z0-9_]{3,16}$/;
const MIN_PASSWORD_LENGTH = 6;
// Long enough that nobody is signed out mid-season, short enough that a token
// copied off a shared phone does not work forever.
const SESSION_TTL = '60 days';

// Match points. Draws are worth something, otherwise a drawn game feels like
// nothing happened.
const POINTS = { win: 3, draw: 1, loss: 0 };

// Skill tiers, by points. Thresholds are descending so the first match wins.
const TIERS = [
  { key: 'elit', label: 'Elit', minPoints: 200, color: '#fa6b1d' },
  { key: 'platin', label: 'Platin', minPoints: 100, color: '#7fd7e8' },
  { key: 'altin', label: 'Altın', minPoints: 50, color: '#f2c14e' },
  { key: 'gumus', label: 'Gümüş', minPoints: 20, color: '#c3c8d4' },
  { key: 'bronz', label: 'Bronz', minPoints: 0, color: '#b07a4f' },
];

// Activity rank, by games played — deliberately independent of results, so
// someone who turns up constantly is recognised even on a losing run.
const ACTIVITY_RANKS = [
  { key: 'efsane', label: 'Efsane', minGames: 100 },
  { key: 'mudavim', label: 'Müdavim', minGames: 30 },
  { key: 'duzenli', label: 'Düzenli', minGames: 10 },
  { key: 'caylak', label: 'Çaylak', minGames: 0 },
];

const MEDALS = ['🥇', '🥈', '🥉'];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) return reject(err);
      resolve(`${salt}:${derived.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const candidate = await hashPassword(password, salt);
  const a = Buffer.from(candidate.split(':')[1], 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Derived numbers for one row of raw win/draw/loss counts. */
function decorate(row, rank) {
  const games = Number(row.games) || 0;
  const wins = Number(row.wins) || 0;
  const draws = Number(row.draws) || 0;
  const losses = Number(row.losses) || 0;
  const points = wins * POINTS.win + draws * POINTS.draw;

  return {
    username: row.username,
    displayName: row.display_name,
    games,
    wins,
    draws,
    losses,
    points,
    // Shown alongside the counts so it is obvious what the ranking is based on.
    winRate: games ? Math.round((wins / games) * 100) : 0,
    pointsPerGame: games ? Number((points / games).toFixed(2)) : 0,
    tier: TIERS.find((t) => points >= t.minPoints),
    activity: ACTIVITY_RANKS.find((r) => games >= r.minGames),
    rank: rank || null,
    medal: rank && rank <= MEDALS.length ? MEDALS[rank - 1] : null,
  };
}

async function register(rawUsername, password, rawDisplayName) {
  const username = String(rawUsername || '').trim().toLowerCase();
  const displayName = String(rawDisplayName || rawUsername || '').trim().slice(0, 24);

  if (!USERNAME_RE.test(username)) {
    return { ok: false, reason: 'invalid_username' };
  }
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'weak_password' };
  }

  const passwordHash = await hashPassword(String(password));
  try {
    const { rows } = await db.query(
      `INSERT INTO players (username, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING id, username, display_name`,
      [username, displayName || username, passwordHash],
    );
    return { ok: true, player: rows[0], token: await createSession(rows[0].id) };
  } catch (err) {
    if (err.code === '23505') return { ok: false, reason: 'username_taken' };
    throw err;
  }
}

async function login(rawUsername, password) {
  const username = String(rawUsername || '').trim().toLowerCase();
  const { rows } = await db.query(
    'SELECT id, username, display_name, password_hash FROM players WHERE username = $1 AND deleted_at IS NULL',
    [username],
  );
  const player = rows[0];
  if (!player) {
    // Hash anyway: answering instantly for an unknown username, and slowly for
    // a known one, tells an attacker which usernames exist.
    await hashPassword(String(password || ''), 'timing');
    return { ok: false, reason: 'bad_credentials' };
  }
  if (!(await verifyPassword(String(password || ''), player.password_hash))) {
    return { ok: false, reason: 'bad_credentials' };
  }
  return {
    ok: true,
    player: { id: player.id, username: player.username, display_name: player.display_name },
    token: await createSession(player.id),
  };
}

/**
 * Checks a password without signing anyone in.
 *
 * Re-authentication before a destructive action used to call login(), which
 * mints a session as a side effect — so asking to export your data left an
 * extra live token behind. This answers the only question being asked.
 */
async function verifyCredentials(playerId, password) {
  if (!db.isEnabled()) return false;
  const { rows } = await db.query(
    'SELECT password_hash FROM players WHERE id = $1 AND deleted_at IS NULL',
    [playerId],
  );
  if (!rows[0]) return false;
  return verifyPassword(String(password || ''), rows[0].password_hash);
}

async function createSession(playerId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessions (token, player_id, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_TTL}')`,
    [token, playerId],
  );
  return token;
}

async function playerForToken(token) {
  if (!token || !db.isEnabled()) return null;
  const { rows } = await db.query(
    `SELECT p.id, p.username, p.display_name
     FROM sessions s JOIN players p ON p.id = s.player_id
     WHERE s.token = $1 AND s.expires_at > now() AND p.deleted_at IS NULL`,
    [String(token)],
  );
  return rows[0] || null;
}

/** Signing out has to end the session on the server, not just in the browser. */
async function endSession(token) {
  if (!token || !db.isEnabled()) return;
  await db.query('DELETE FROM sessions WHERE token = $1', [String(token)]);
}

/**
 * Ends every session a player holds — used when an account is deleted, and
 * available for a "sign out everywhere" action.
 */
async function endAllSessions(playerId) {
  if (!db.isEnabled()) return 0;
  const { rowCount } = await db.query('DELETE FROM sessions WHERE player_id = $1', [playerId]);
  return rowCount;
}

/** Expired rows are dead weight; clear them out periodically. */
async function purgeExpiredSessions() {
  if (!db.isEnabled()) return 0;
  const { rowCount } = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  return rowCount;
}

/**
 * Records a finished game, at most once.
 *
 * `matchUid` is minted when the game starts and is the same for every attempt
 * to save it, so a retry, a duplicated end-of-game transition or two servers
 * racing each other all end up with one row. Without it, one extra call was one
 * extra game in everybody's record.
 *
 * @returns {Promise<boolean>} true if this call is the one that wrote the row.
 */
async function recordMatch({ playerAId, playerBId, scoreA, scoreB, winnerId, matchUid }) {
  // A game against yourself is not a game. The matchmaker refuses to build one
  // and the table has a constraint against it; this is the third place, because
  // a recorded self-match is a free win that silently inflates a leaderboard.
  if (!playerAId || !playerBId || playerAId === playerBId) {
    console.error('refusing to record a match with one player on both sides:', playerAId);
    return false;
  }
  if (!matchUid) {
    console.error('refusing to record a match without an id');
    return false;
  }
  const { rowCount } = await db.query(
    `INSERT INTO matches (player_a, player_b, score_a, score_b, winner_id, match_uid)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (match_uid) DO NOTHING`,
    [playerAId, playerBId, scoreA, scoreB, winnerId, String(matchUid)],
  );
  return rowCount > 0;
}

async function leaderboard(limit = 50) {
  const { rows } = await db.query(
    `${db.STATS_SELECT}
     WHERE p.deleted_at IS NULL
     GROUP BY p.id
     HAVING COUNT(m.id) > 0
     ORDER BY (COUNT(*) FILTER (WHERE m.winner_id = p.id) * ${POINTS.win}
             + COUNT(*) FILTER (WHERE m.id IS NOT NULL AND m.winner_id IS NULL) * ${POINTS.draw}) DESC,
              COUNT(*) FILTER (WHERE m.winner_id = p.id) DESC,
              COUNT(m.id) DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((row, i) => decorate(row, i + 1));
}

async function profile(rawUsername) {
  const username = String(rawUsername || '').trim().toLowerCase();
  const { rows } = await db.query(
    `${db.STATS_SELECT} WHERE p.username = $1 AND p.deleted_at IS NULL GROUP BY p.id`,
    [username],
  );
  if (!rows[0]) return null;

  // Rank comes from the same ordering as the leaderboard.
  const board = await leaderboard(1000);
  const listed = board.find((entry) => entry.username === username);
  return listed || decorate(rows[0], null);
}

/**
 * Everything stored about one player, for a data-portability request.
 * Read from the same tables the game reads, so it cannot go stale.
 */
async function exportAccount(playerId) {
  const { rows: who } = await db.query(
    'SELECT id, username, display_name, created_at FROM players WHERE id = $1 AND deleted_at IS NULL',
    [playerId],
  );
  if (!who[0]) return null;

  const { rows: matches } = await db.query(
    `SELECT m.id, m.played_at, m.score_a, m.score_b,
            a.display_name AS player_a, b.display_name AS player_b,
            CASE WHEN m.winner_id IS NULL THEN 'beraberlik'
                 WHEN m.winner_id = $1 THEN 'galibiyet'
                 ELSE 'maglubiyet' END AS sonuc
     FROM matches m
     JOIN players a ON a.id = m.player_a
     JOIN players b ON b.id = m.player_b
     WHERE m.player_a = $1 OR m.player_b = $1
     ORDER BY m.played_at`,
    [playerId],
  );

  const { rows: sessions } = await db.query(
    'SELECT created_at, expires_at FROM sessions WHERE player_id = $1 ORDER BY created_at',
    [playerId],
  );

  return {
    disaAktarildi: new Date().toISOString(),
    hesap: {
      kullaniciAdi: who[0].username,
      gorunenAd: who[0].display_name,
      kayitTarihi: who[0].created_at,
      // Never exported: the password hash is a credential, not user data.
    },
    istatistikler: await profile(who[0].username),
    maclar: matches,
    // Session rows carry no IP or device data — only when they were created.
    oturumlar: sessions,
  };
}

/**
 * Deletes a player's personal data.
 *
 * The row is tombstoned rather than dropped: matches reference players with
 * ON DELETE CASCADE, so a hard delete would take the opponent's history with
 * it. Identifying fields are cleared, the password and every session are
 * destroyed, and the account can no longer be logged into or seen anywhere.
 */
/**
 * Anonymises an account and ends every session it has, atomically.
 *
 * Two things were wrong before. It ran as two independent queries, so a failure
 * between them left the sessions deleted and the account still live — signed
 * out everywhere but not deleted. And the tombstone username was
 * `silinmis_<id>`, which any player could have registered first: usernames are
 * [a-z0-9_], so `silinmis_42` is a perfectly legal name, and deleting player 42
 * would then fail on the UNIQUE constraint. The tombstone now uses a colon,
 * which the username rules can never produce.
 *
 * The row itself stays. The OPPONENT's match history and head-to-head record
 * are built from it, and deleting one player must not erase another player's
 * wins.
 */
async function deleteAccount(playerId) {
  return db.transaction(async (client) => {
    // Lock the row first, so two delete requests arriving together are
    // serialised rather than both reading "not yet deleted".
    const { rows } = await client.query(
      'SELECT id, deleted_at FROM players WHERE id = $1 FOR UPDATE',
      [playerId],
    );
    if (!rows[0] || rows[0].deleted_at) return false;

    await client.query('DELETE FROM sessions WHERE player_id = $1', [playerId]);
    await client.query(
      `UPDATE players
       SET username = 'deleted:' || id,
           display_name = 'Silinmiş oyuncu',
           password_hash = '',
           deleted_at = now()
       WHERE id = $1`,
      [playerId],
    );
    return true;
  });
}

/** Same as profile(), for a player we already know by id. */
async function profileById(playerId) {
  const { rows } = await db.query('SELECT username FROM players WHERE id = $1', [playerId]);
  return rows[0] ? profile(rows[0].username) : null;
}

/**
 * The running series between two players: who is ahead across all their games.
 */
async function headToHead(playerAId, playerBId) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)                                                              AS games,
       COUNT(*) FILTER (WHERE winner_id = $1)                                AS a_wins,
       COUNT(*) FILTER (WHERE winner_id = $2)                                AS b_wins,
       COUNT(*) FILTER (WHERE winner_id IS NULL)                             AS draws
     FROM matches
     WHERE (player_a = $1 AND player_b = $2) OR (player_a = $2 AND player_b = $1)`,
    [playerAId, playerBId],
  );
  const row = rows[0] || {};
  return {
    games: Number(row.games) || 0,
    aWins: Number(row.a_wins) || 0,
    bWins: Number(row.b_wins) || 0,
    draws: Number(row.draws) || 0,
  };
}

module.exports = {
  register,
  login,
  playerForToken,
  verifyCredentials,
  endSession,
  endAllSessions,
  purgeExpiredSessions,
  exportAccount,
  deleteAccount,
  recordMatch,
  leaderboard,
  profile,
  profileById,
  headToHead,
  decorate,
  TIERS,
  ACTIVITY_RANKS,
  POINTS,
  MIN_PASSWORD_LENGTH,
};
