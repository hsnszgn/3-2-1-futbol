// Live football data via Wikidata's public search + SPARQL APIs (free, no key).
//
// The hard part is NOT the player data, it's pinning down which Wikidata item a
// typed club name refers to. Many clubs have several items: the parent
// multi-sport club ("Fenerbahçe S.K.", described as a "Turkish sports club"),
// the football section, historical/renamed entities, reserve sides. Players'
// "member of sports team" (P54) claims hang off the football item, so picking a
// single best-guess item silently yields zero results whenever the guess lands
// on the parent club.
//
// So instead of choosing one item, we keep every search hit whose label really
// looks like the club the player typed, and union over all of them in the
// query. Unioning is safe: only actual sports teams ever appear as P54 values,
// so irrelevant candidates simply contribute no rows.

const { normalize } = require('./data/teams');

const SEARCH_ENDPOINT = 'https://www.wikidata.org/w/api.php';
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const SEARCH_TIMEOUT_MS = 8000;
const SPARQL_TIMEOUT_MS = 15000;
const TEAM_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYERS_TTL_MS = 60 * 60 * 1000;
const USER_AGENT = '3-2-1-Futbol/1.0 (https://github.com/hsnszgn/3-2-1-futbol)';

const teamCandidateCache = new Map(); // display name -> { candidates, expiresAt }
const commonPlayersCache = new Map(); // candidate-qid key -> { players, expiresAt }

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json, application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetry(url, timeoutMs) {
  try {
    return await fetchJson(url, timeoutMs);
  } catch (err) {
    return fetchJson(url, timeoutMs);
  }
}

const squash = (str) => normalize(str).replace(/ /g, '');

// Keeps "Fenerbahçe S.K. (football)" for a "Fenerbahce" search while rejecting
// "Internacional" for an "Inter Milan" one.
function labelLooksLikeTeam(label, searchTerm) {
  const a = squash(label);
  const b = squash(searchTerm);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

const CLUBBY = /football|soccer|\bf\.?c\.?\b|\bc\.?f\.?\b|\ba\.?c\.?\b|\bs\.?k\.?\b|sports club|sport(s)? team/i;

async function resolveTeamCandidates(displayName) {
  const cached = teamCandidateCache.get(displayName);
  if (cached && cached.expiresAt > Date.now()) return cached.candidates;

  const url = `${SEARCH_ENDPOINT}?action=wbsearchentities&search=${encodeURIComponent(displayName)}`
    + '&language=en&uselang=en&type=item&format=json&limit=50';
  const data = await fetchJsonWithRetry(url, SEARCH_TIMEOUT_MS);
  const results = data && Array.isArray(data.search) ? data.search : [];

  const matching = results.filter((r) => labelLooksLikeTeam(r.label || '', displayName)
    || labelLooksLikeTeam(r.match && r.match.text ? r.match.text : '', displayName));

  // A club name is very often also a place name ("Valencia" is a city, a
  // province, a town in Venezuela...), and those can outrank the club in
  // search results. Sorting club-looking hits to the front means the club
  // survives the cap below even when it ranks low.
  const clubby = (r) => CLUBBY.test(r.description || '') || CLUBBY.test(r.label || '');
  const candidates = [...matching.filter(clubby), ...matching.filter((r) => !clubby(r))]
    .slice(0, 20)
    .map((r) => ({ qid: r.id, label: r.label, description: r.description || '' }));

  teamCandidateCache.set(displayName, { candidates, expiresAt: Date.now() + TEAM_TTL_MS });
  return candidates;
}

async function fetchCommonPlayers(qidsA, qidsB) {
  const key = `${[...qidsA].sort().join(',')}|${[...qidsB].sort().join(',')}`;
  const cached = commonPlayersCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.players;

  const valuesA = qidsA.map((q) => `wd:${q}`).join(' ');
  const valuesB = qidsB.map((q) => `wd:${q}`).join(' ');
  // No occupation filter: plenty of real players lack the occupation claim, and
  // P54 membership of both clubs is already the thing being asked about.
  // altLabels come along so alternate spellings of a name also match.
  const query = `
    SELECT DISTINCT ?player ?playerLabel ?alt WHERE {
      VALUES ?teamA { ${valuesA} }
      VALUES ?teamB { ${valuesB} }
      ?player wdt:P54 ?teamA .
      ?player wdt:P54 ?teamB .
      ?player rdfs:label ?playerLabel .
      FILTER(LANG(?playerLabel) = "en")
      OPTIONAL { ?player skos:altLabel ?alt . FILTER(LANG(?alt) IN ("en", "tr")) }
    }
    LIMIT 3000
  `;
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const data = await fetchJsonWithRetry(url, SPARQL_TIMEOUT_MS);
  const rows = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];

  // Collapse the label/altLabel rows into one entry per player.
  const byQid = new Map();
  for (const row of rows) {
    const qid = row.player && row.player.value;
    const label = row.playerLabel && row.playerLabel.value;
    if (!qid || !label) continue;
    if (!byQid.has(qid)) byQid.set(qid, { name: label, aliases: [] });
    if (row.alt && row.alt.value) byQid.get(qid).aliases.push(row.alt.value);
  }
  const players = [...byQid.values()];

  commonPlayersCache.set(key, { players, expiresAt: Date.now() + PLAYERS_TTL_MS });
  return players;
}

/**
 * Resolves two team display names to the players who played for both.
 * Returns { ok: true, players: [{name, aliases}], debug } or { ok: false, reason, debug }.
 */
async function getCommonPlayers(teamDisplayA, teamDisplayB) {
  const debug = { teamA: teamDisplayA, teamB: teamDisplayB };
  try {
    const [candA, candB] = await Promise.all([
      resolveTeamCandidates(teamDisplayA),
      resolveTeamCandidates(teamDisplayB),
    ]);
    debug.candidatesA = candA;
    debug.candidatesB = candB;

    if (!candA.length || !candB.length) {
      return { ok: false, reason: 'team_not_found', debug };
    }

    const players = await fetchCommonPlayers(candA.map((c) => c.qid), candB.map((c) => c.qid));
    debug.playerCount = players.length;
    return { ok: true, players, debug };
  } catch (err) {
    debug.error = err.message;
    return { ok: false, reason: 'lookup_failed', debug };
  }
}

module.exports = { getCommonPlayers };
