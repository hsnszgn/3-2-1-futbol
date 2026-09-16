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
// A lookup that outlives the round is worse than one that fails: the player
// taps submit, sees "checking...", and never gets an answer because the round
// timed out around them. So the whole lookup runs against a single budget that
// is comfortably shorter than the guess window in server/index.js.
const LOOKUP_BUDGET_MS = 14000;
const SEARCH_TIMEOUT_MS = 5000;
const SPARQL_TIMEOUT_MS = 9000;
const TEAM_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYERS_TTL_MS = 60 * 60 * 1000;
const USER_AGENT = '3-2-1-Futbol/1.0 (https://github.com/hsnszgn/3-2-1-futbol)';

const TEAM_RESOLVE_BUDGET_MS = 6000;

const teamCandidateCache = new Map(); // display name -> { candidates, expiresAt }
const commonPlayersCache = new Map(); // candidate-qid key -> { players, expiresAt }
const freeTextTeamCache = new Map(); // typed name -> { team, expiresAt }

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

// Retries only while the shared deadline still allows it, so a slow Wikidata
// can never stretch a lookup past the end of the round.
async function fetchJsonWithRetry(url, timeoutMs, deadline) {
  const firstAttempt = Math.min(timeoutMs, deadline - Date.now());
  if (firstAttempt <= 0) throw new Error('lookup budget exhausted');
  try {
    return await fetchJson(url, firstAttempt);
  } catch (err) {
    const retryWindow = Math.min(timeoutMs, deadline - Date.now());
    if (retryWindow < 1500) throw err;
    return fetchJson(url, retryWindow);
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

// Descriptions come back in whatever language was searched, so this has to
// recognise a club in Turkish ("futbol kulübü") as well as English —
// otherwise every Turkish-language hit gets filtered out as "not a club".
const CLUBBY = new RegExp([
  'football', 'soccer', 'futbol', 'fútbol', 'futebol', 'calcio', 'calcistic',
  'fussball', 'fußball', 'voetbal', 'kulüb', 'kulub', 'sports? club',
  'sport(s)? team', 'verein', '\\bf\\.?c\\.?\\b', '\\bc\\.?f\\.?\\b',
  '\\ba\\.?c\\.?\\b', '\\bs\\.?k\\.?\\b',
].join('|'), 'i');
const isClubby = (r) => CLUBBY.test(r.description || '') || CLUBBY.test(r.label || '');

async function searchItems(term, language, deadline) {
  const url = `${SEARCH_ENDPOINT}?action=wbsearchentities&search=${encodeURIComponent(term)}`
    + `&language=${language}&uselang=${language}&type=item&format=json&limit=50`;
  const data = await fetchJsonWithRetry(url, SEARCH_TIMEOUT_MS, deadline);
  return data && Array.isArray(data.search) ? data.search : [];
}

async function resolveTeamCandidates(displayName, deadline, seedQid) {
  const cacheKey = seedQid ? `${displayName}|${seedQid}` : displayName;
  const cached = teamCandidateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.candidates;

  const results = await searchItems(displayName, 'en', deadline);

  const matching = results.filter((r) => labelLooksLikeTeam(r.label || '', displayName)
    || labelLooksLikeTeam(r.match && r.match.text ? r.match.text : '', displayName));

  // A club name is very often also a place name ("Valencia" is a city, a
  // province, a town in Venezuela...), and those can outrank the club in
  // search results. Sorting club-looking hits to the front means the club
  // survives the cap below even when it ranks low.
  const ranked = [...matching.filter(isClubby), ...matching.filter((r) => !isClubby(r))]
    .slice(0, 20)
    .map((r) => ({ qid: r.id, label: r.label, description: r.description || '' }));

  // When the name was resolved live (a club outside the local list, or typed
  // in Turkish), that exact item is the one the player meant — keep it at the
  // front, and let the name search add the club's other items around it.
  const candidates = seedQid && !ranked.some((c) => c.qid === seedQid)
    ? [{ qid: seedQid, label: displayName, description: 'resolved from typed name' }, ...ranked]
    : ranked;

  teamCandidateCache.set(cacheKey, { candidates, expiresAt: Date.now() + TEAM_TTL_MS });
  return candidates;
}

/**
 * Turns free text the player typed into a club, for anything the local alias
 * list in data/teams.js doesn't cover — clubs nobody thought to add
 * (Deportivo, Leganés) and Turkish exonyms ("Marsilya" for Marseille), which
 * is why the Turkish search runs alongside the English one.
 *
 * @returns {Promise<{id: string, display: string, qid: string}|null>}
 */
async function resolveTeamByName(rawName) {
  const key = normalize(rawName);
  if (!key) return null;
  const cached = freeTextTeamCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.team;

  const deadline = Date.now() + TEAM_RESOLVE_BUDGET_MS;
  let team = null;
  try {
    const [en, tr] = await Promise.all([
      searchItems(rawName, 'en', deadline).catch(() => []),
      searchItems(rawName, 'tr', deadline).catch(() => []),
    ]);
    const club = [...en, ...tr].find(isClubby);
    if (club) team = { id: club.id, display: club.label, qid: club.id };
  } catch (err) {
    return null;
  }

  freeTextTeamCache.set(key, { team, expiresAt: Date.now() + TEAM_TTL_MS });
  return team;
}

async function fetchCommonPlayers(qidsA, qidsB, deadline) {
  const key = `${[...qidsA].sort().join(',')}|${[...qidsB].sort().join(',')}`;
  const cached = commonPlayersCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.players;

  const valuesA = qidsA.map((q) => `wd:${q}`).join(' ');
  const valuesB = qidsB.map((q) => `wd:${q}`).join(' ');
  // p:P54/ps:P54 rather than wdt:P54, and this is the whole ballgame for
  // recent transfers: wdt: only exposes "truthy" statements, so as soon as an
  // editor marks a player's current club as preferred rank, every previous
  // club disappears from wdt: — a player who just moved looks like he has
  // only ever played for one team. Going through the statement node returns
  // the full career regardless of rank.
  //
  // No occupation filter either: plenty of real players lack the occupation
  // claim, and membership of both clubs is already the question being asked.
  // The label service supplies a name (falling back across languages) plus
  // alternate spellings, so nobody is dropped for missing an English label.
  const query = `
    SELECT DISTINCT ?player ?playerLabel ?playerAltLabel WHERE {
      VALUES ?teamA { ${valuesA} }
      VALUES ?teamB { ${valuesB} }
      ?player p:P54/ps:P54 ?teamA .
      ?player p:P54/ps:P54 ?teamB .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tr,es,it,de,fr". }
    }
    LIMIT 3000
  `;
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const data = await fetchJsonWithRetry(url, SPARQL_TIMEOUT_MS, deadline);
  const rows = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];

  const byQid = new Map();
  for (const row of rows) {
    const qid = row.player && row.player.value;
    const label = row.playerLabel && row.playerLabel.value;
    if (!qid || !label) continue;
    // The label service returns altLabels as one comma-separated string.
    const aliases = row.playerAltLabel && row.playerAltLabel.value
      ? row.playerAltLabel.value.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (!byQid.has(qid)) byQid.set(qid, { name: label, aliases });
  }
  const players = [...byQid.values()];

  commonPlayersCache.set(key, { players, expiresAt: Date.now() + PLAYERS_TTL_MS });
  return players;
}

/**
 * Resolves two team display names to the players who played for both.
 * Returns { ok: true, players: [{name, aliases}], debug } or { ok: false, reason, debug }.
 */
async function getCommonPlayers(teamA, teamB) {
  const startedAt = Date.now();
  const deadline = startedAt + LOOKUP_BUDGET_MS;
  const debug = { teamA: teamA.display, teamB: teamB.display };
  try {
    const [candA, candB] = await Promise.all([
      resolveTeamCandidates(teamA.display, deadline, teamA.qid),
      resolveTeamCandidates(teamB.display, deadline, teamB.qid),
    ]);
    debug.candidatesA = candA;
    debug.candidatesB = candB;

    if (!candA.length || !candB.length) {
      return { ok: false, reason: 'team_not_found', debug };
    }

    const players = await fetchCommonPlayers(
      candA.map((c) => c.qid),
      candB.map((c) => c.qid),
      deadline,
    );
    debug.playerCount = players.length;
    debug.elapsedMs = Date.now() - startedAt;
    return { ok: true, players, debug };
  } catch (err) {
    debug.error = err.message;
    debug.elapsedMs = Date.now() - startedAt;
    return { ok: false, reason: 'lookup_failed', debug };
  }
}

module.exports = { getCommonPlayers, resolveTeamByName };
