const { normalize } = require('./data/teams');

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

/**
 * Matches a free-text guess against a pre-fetched list of player names
 * (already known to have played for both teams — see server/wikidata.js).
 * Exact match on the normalized name first, then a small-typo fuzzy fallback.
 */
function matchPlayerName(input, candidateNames) {
  const norm = normalize(input);
  if (!norm) return null;

  let exact = null;
  let bestFuzzy = null;
  let bestDist = Infinity;

  for (const name of candidateNames) {
    const key = normalize(name);
    if (!key) continue;
    if (key === norm) {
      exact = name;
      break;
    }
    const maxLen = Math.max(key.length, norm.length);
    const threshold = maxLen <= 6 ? 1 : 2;
    const dist = levenshtein(key, norm);
    if (dist <= threshold && dist < bestDist) {
      bestFuzzy = name;
      bestDist = dist;
    }
  }

  return exact || bestFuzzy;
}

module.exports = { matchPlayerName };
