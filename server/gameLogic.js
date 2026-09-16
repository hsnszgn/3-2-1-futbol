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

function isTypo(candidate, guess) {
  const threshold = Math.max(candidate.length, guess.length) <= 6 ? 1 : 2;
  return levenshtein(candidate, guess) <= threshold;
}

// "Muriqi" should count for "Vedat Muriqi", and "Hakan Calhanoglu" for
// "Hakan Çalhanoğlu" — but a single short token like "de" shouldn't match
// half the database.
function isPartialName(candidateTokens, guessTokens) {
  if (!guessTokens.length) return false;
  if (guessTokens.length === 1) {
    const token = guessTokens[0];
    if (token.length < 4) return false;
    return candidateTokens[candidateTokens.length - 1] === token
      || candidateTokens.includes(token);
  }
  return guessTokens.every((t) => candidateTokens.includes(t));
}

/**
 * Matches a free-text guess against the players already known to have played
 * for both teams (see server/wikidata.js). Accepts each player's primary name
 * plus any Wikidata aliases, tolerating small typos, partial names and
 * alternate spellings.
 *
 * @param {string} input raw text the player typed
 * @param {Array<{name: string, aliases?: string[]}>} candidates
 * @returns {string|null} the player's primary name, or null for no match
 */
function matchPlayerName(input, candidates) {
  const guess = normalize(input);
  if (!guess) return null;
  const guessTokens = guess.split(' ').filter(Boolean);

  let typoMatch = null;
  let partialMatch = null;
  let partialTypoMatch = null;

  for (const candidate of candidates) {
    const names = [candidate.name, ...(candidate.aliases || [])];
    for (const name of names) {
      const key = normalize(name);
      if (!key) continue;
      if (key === guess) return candidate.name;

      const candidateTokens = key.split(' ').filter(Boolean);
      if (!typoMatch && isTypo(key, guess)) typoMatch = candidate.name;
      if (!partialMatch && isPartialName(candidateTokens, guessTokens)) {
        partialMatch = candidate.name;
      }
      // A mistyped surname on its own ("Calhanoglou") is a very common way to
      // answer under time pressure, so check tokens individually too.
      if (!partialTypoMatch && guessTokens.length === 1 && guessTokens[0].length >= 4
        && candidateTokens.some((t) => t.length >= 4 && isTypo(t, guessTokens[0]))) {
        partialTypoMatch = candidate.name;
      }
    }
  }

  return typoMatch || partialMatch || partialTypoMatch;
}

module.exports = { matchPlayerName };
