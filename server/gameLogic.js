const { normalize } = require('./data/teams');
const { PLAYERS } = require('./data/players');

// Build lookup: normalized player name -> { name, teams: Set<teamId> }
const PLAYER_INDEX = new Map();
for (const p of PLAYERS) {
  const key = normalize(p.name);
  if (!PLAYER_INDEX.has(key)) {
    PLAYER_INDEX.set(key, { name: p.name, teams: new Set(p.teams) });
  } else {
    for (const t of p.teams) PLAYER_INDEX.get(key).teams.add(t);
  }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findPlayer(input) {
  const norm = normalize(input);
  if (!norm) return null;
  if (PLAYER_INDEX.has(norm)) return PLAYER_INDEX.get(norm);
  // fuzzy fallback for small typos
  let best = null;
  let bestDist = Infinity;
  for (const [key, val] of PLAYER_INDEX.entries()) {
    const maxLen = Math.max(key.length, norm.length);
    const threshold = maxLen <= 6 ? 1 : 2;
    const dist = levenshtein(key, norm);
    if (dist <= threshold && dist < bestDist) {
      best = val;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Validate a player-name guess against two resolved team ids.
 * Returns { ok: true, playerName } or { ok: false, reason }
 */
function validateGuess(playerNameInput, teamIdA, teamIdB) {
  const player = findPlayer(playerNameInput);
  if (!player) return { ok: false, reason: 'player_not_found' };
  if (player.teams.has(teamIdA) && player.teams.has(teamIdB)) {
    return { ok: true, playerName: player.name };
  }
  return { ok: false, reason: 'no_common_team' };
}

module.exports = { validateGuess, findPlayer };
