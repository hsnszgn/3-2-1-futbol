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
const USER_AGENT = '3-2-1-Futbol/1.0 (https://github.com/hsnszgn/3-2-1-futbol)';

const TEAM_RESOLVE_BUDGET_MS = 6000;

const SQUAD_TTL_MS = 6 * 60 * 60 * 1000; // a club's historical squad barely moves

const teamCandidateCache = new Map(); // display name -> { candidates, expiresAt }
const squadCache = new Map(); // club candidate-qid key -> { qids, expiresAt }
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
    .slice(0, 8) // a small VALUES list keeps the query cheap enough to survive
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

/**
 * Every player who has ever been a member of one club (all of that club's
 * candidate items), as bare QIDs.
 *
 * Deliberately one club per query and no labels: asking for both clubs at
 * once meant joining two property paths across two VALUES blocks, which is
 * expensive enough that the public query service times it out. One club is a
 * plain scan. It also caches per club, so a popular club is fetched once and
 * every later matchup involving it is free.
 *
 * p:P54/ps:P54 rather than wdt:P54 is what makes recent transfers work: wdt:
 * only exposes best-ranked statements, so once an editor marks a player's
 * current club as preferred, every earlier club disappears from it.
 */
async function fetchSquadQids(qids, deadline) {
  const key = [...qids].sort().join(',');
  const cached = squadCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.qids;

  const values = qids.map((q) => `wd:${q}`).join(' ');
  const query = `
    SELECT DISTINCT ?player WHERE {
      VALUES ?team { ${values} }
      ?player p:P54/ps:P54 ?team .
    }
    LIMIT 5000
  `;
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const data = await fetchJsonWithRetry(url, SPARQL_TIMEOUT_MS, deadline);
  const rows = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const playerQids = rows.map((r) => r.player && r.player.value).filter(Boolean);

  squadCache.set(key, { qids: playerQids, expiresAt: Date.now() + SQUAD_TTL_MS });
  return playerQids;
}

const qidOf = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

/** Names + alternate spellings for the (usually short) intersection. */
async function fetchPlayerNames(playerUris, deadline) {
  if (!playerUris.length) return [];
  const values = playerUris.slice(0, 250).map((uri) => `wd:${qidOf(uri)}`).join(' ');
  const query = `
    SELECT ?player ?playerLabel ?playerAltLabel WHERE {
      VALUES ?player { ${values} }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tr,es,it,de,fr". }
    }
  `;
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const data = await fetchJsonWithRetry(url, SPARQL_TIMEOUT_MS, deadline);
  const rows = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];

  const byQid = new Map();
  for (const row of rows) {
    const uri = row.player && row.player.value;
    const label = row.playerLabel && row.playerLabel.value;
    if (!uri || !label) continue;
    // The label service returns altLabels as one comma-separated string.
    const aliases = row.playerAltLabel && row.playerAltLabel.value
      ? row.playerAltLabel.value.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (!byQid.has(uri)) byQid.set(uri, { name: label, aliases });
  }
  return [...byQid.values()];
}

/** Warms one club's squad cache, so the reveal doesn't have to wait for it. */
async function prefetchSquad(team) {
  try {
    const deadline = Date.now() + LOOKUP_BUDGET_MS;
    const candidates = await resolveTeamCandidates(team.display, deadline, team.qid);
    if (!candidates.length) return;
    await fetchSquadQids(candidates.map((c) => c.qid), deadline);
  } catch (err) {
    // Best effort only — the real lookup will report any failure.
  }
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

    // Fetch each squad separately (cheap, cacheable per club) and intersect
    // here rather than making the query service do the join.
    const [squadA, squadB] = await Promise.all([
      fetchSquadQids(candA.map((c) => c.qid), deadline),
      fetchSquadQids(candB.map((c) => c.qid), deadline),
    ]);
    debug.squadSizes = { a: squadA.length, b: squadB.length };

    const inB = new Set(squadB);
    const shared = squadA.filter((uri) => inB.has(uri));
    debug.commonCount = shared.length;

    const players = await fetchPlayerNames(shared, deadline);
    debug.playerCount = players.length;
    debug.elapsedMs = Date.now() - startedAt;
    return { ok: true, players, debug };
  } catch (err) {
    debug.error = err.message;
    debug.elapsedMs = Date.now() - startedAt;
    return { ok: false, reason: 'lookup_failed', debug };
  }
}

module.exports = { getCommonPlayers, resolveTeamByName, prefetchSquad };
