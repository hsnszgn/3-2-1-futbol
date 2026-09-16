// Live football data via Wikidata's public SPARQL + search APIs (free, no
// API key). Two lookups per round instead of a hand-curated local list:
//   1. Resolve each team's display name to a Wikidata QID (cached forever
//      for the life of the process — club identities don't change).
//   2. Fetch every player who has "member of sports team" (P54) claims for
//      BOTH resolved QIDs, cached briefly per team pair.
// Both caches mean a repeat matchup (or a popular club) after the first
// lookup resolves instantly with no network call.

const SEARCH_ENDPOINT = 'https://www.wikidata.org/w/api.php';
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const FETCH_TIMEOUT_MS = 6000;
const TEAM_QID_TTL_MS = 24 * 60 * 60 * 1000; // club identity never changes; cache long
const COMMON_PLAYERS_TTL_MS = 60 * 60 * 1000; // 1h — transfer history rarely changes mid-session

const teamQidCache = new Map(); // normalizedDisplayName -> { qid, expiresAt }
const commonPlayersCache = new Map(); // "qidA|qidB" -> { players, expiresAt }

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': '3-2-1-Futbol/1.0 (https://github.com/hsnszgn/3-2-1-futbol)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTeamQid(displayName) {
  const cached = teamQidCache.get(displayName);
  if (cached && cached.expiresAt > Date.now()) return cached.qid;

  const url = `${SEARCH_ENDPOINT}?action=wbsearchentities&search=${encodeURIComponent(displayName)}&language=en&type=item&format=json&limit=6&origin=*`;
  const data = await fetchWithTimeout(url);
  const results = data && Array.isArray(data.search) ? data.search : [];

  const isClub = (r) => /football|soccer/i.test(r.description || '');
  const best = results.find(isClub) || results[0];
  if (!best) return null;

  teamQidCache.set(displayName, { qid: best.id, expiresAt: Date.now() + TEAM_QID_TTL_MS });
  return best.id;
}

async function fetchCommonPlayers(qidA, qidB) {
  const key = [qidA, qidB].sort().join('|');
  const cached = commonPlayersCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.players;

  const query = `
    SELECT DISTINCT ?playerLabel WHERE {
      ?player wdt:P54 wd:${qidA}.
      ?player wdt:P54 wd:${qidB}.
      ?player wdt:P106 wd:Q937857.
      ?player rdfs:label ?playerLabel.
      FILTER(LANG(?playerLabel) = "en")
    }
    LIMIT 500
  `;
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const data = await fetchWithTimeout(url);
  const rows = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const players = rows.map((row) => row.playerLabel.value).filter(Boolean);

  commonPlayersCache.set(key, { players, expiresAt: Date.now() + COMMON_PLAYERS_TTL_MS });
  return players;
}

/**
 * Resolves two team display names to their common player list.
 * Returns { ok: true, players: string[] } or { ok: false, reason }.
 */
async function getCommonPlayers(teamDisplayA, teamDisplayB) {
  try {
    const [qidA, qidB] = await Promise.all([
      resolveTeamQid(teamDisplayA),
      resolveTeamQid(teamDisplayB),
    ]);
    if (!qidA || !qidB) {
      return { ok: false, reason: 'team_not_found' };
    }
    const players = await fetchCommonPlayers(qidA, qidB);
    return { ok: true, players };
  } catch (err) {
    return { ok: false, reason: 'lookup_failed' };
  }
}

module.exports = { getCommonPlayers };
