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

// The shortest guess worth treating loosely. Below this, one edit is most of
// the word: "ba" would reach "be", "de" would reach "da". Short answers have to
// be exact, and an exact answer is already matched before any of this runs.
const MIN_FUZZY_LENGTH = 4;

function isTypo(candidate, guess) {
  if (guess.length < MIN_FUZZY_LENGTH || candidate.length < MIN_FUZZY_LENGTH) return false;
  const threshold = Math.max(candidate.length, guess.length) <= 6 ? 1 : 2;
  return levenshtein(candidate, guess) <= threshold;
}

/**
 * Does this guess actually pick someone out?
 *
 * "Muriqi" should count for "Vedat Muriqi", and "Hakan Calhanoglu" for
 * "Hakan Çalhanoğlu". "de de" should not count for Kevin De Bruyne — and it
 * did: the multi-token branch only asked whether every token appeared
 * somewhere in the name, so repeating a particle was enough. Typing "de de"
 * scored a point against anyone with a "de" in their name.
 *
 * Two rules fix it without narrowing what a real player would type:
 *
 *   - Repeating a token adds nothing, so duplicates are dropped first. "de de"
 *     becomes "de", which the single-token rule already refuses as too short.
 *   - What is left has to carry some weight: either a token of real length, or
 *     the player's surname. "van der sar" passes on the surname even though
 *     none of its parts is long; "van der" alone does not, and should not.
 *
 * Order is deliberately not required: "salah mohamed" is a normal way to answer.
 */
function isPartialName(candidateTokens, guessTokens) {
  if (!guessTokens.length || !candidateTokens.length) return false;

  const distinct = [...new Set(guessTokens)];
  if (distinct.length === 1) {
    const token = distinct[0];
    if (token.length < MIN_FUZZY_LENGTH) return false;
    return candidateTokens.includes(token);
  }

  if (!distinct.every((t) => candidateTokens.includes(t))) return false;

  const surname = candidateTokens[candidateTokens.length - 1];
  const carriesWeight = distinct.some((t) => t.length >= MIN_FUZZY_LENGTH)
    || distinct.includes(surname);
  return carriesWeight;
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
      if (!partialTypoMatch && guessTokens.length === 1
        && guessTokens[0].length >= MIN_FUZZY_LENGTH
        && candidateTokens.some((t) => isTypo(t, guessTokens[0]))) {
        partialTypoMatch = candidate.name;
      }
    }
  }

  return typoMatch || partialMatch || partialTypoMatch;
}

module.exports = { matchPlayerName };
