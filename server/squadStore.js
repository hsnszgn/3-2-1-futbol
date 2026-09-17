// A snapshot of "who played for which club", generated at deploy time by
// scripts/build-squads.js and shipped with the server.
//
// The point is that a round must never wait on the network. Live Wikidata
// lookups work, but they put a multi-second, occasionally failing call inside
// a 25-second round — which is exactly how a correct answer ends up rejected.
// With the snapshot loaded, any matchup between two known clubs is answered
// from memory, instantly and deterministically. Clubs outside it (and a
// missing snapshot entirely) still fall through to the live lookup.

const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, 'data', 'squads.json');

let squads = new Map(); // team id -> Set of player qids
let names = new Map(); // player qid -> { name, aliases }
let meta = { loaded: false };

function load() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const data = JSON.parse(raw);
    squads = new Map(Object.entries(data.squads || {}).map(([id, qids]) => [id, new Set(qids)]));
    names = new Map(Object.entries(data.names || {}));
    meta = {
      loaded: true,
      builtAt: data.builtAt || null,
      teams: squads.size,
      players: names.size,
    };
    console.log(`Squad snapshot loaded: ${meta.teams} clubs, ${meta.players} players (built ${meta.builtAt})`);
  } catch (err) {
    meta = { loaded: false, error: err.code === 'ENOENT' ? 'no snapshot file' : err.message };
    console.log(`Squad snapshot not loaded (${meta.error}) — falling back to live lookups`);
  }
}

const has = (teamId) => squads.has(teamId);

/**
 * Players common to two known clubs, straight from memory.
 * Returns null when either club is missing from the snapshot.
 *
 * The squad sets are complete, but the name table may not be (the build fetches
 * names best-effort). A player whose name is missing is reported separately
 * rather than dropped — dropping them silently turns a valid answer into a
 * rejection, which is worse than one small live lookup.
 */
function commonPlayers(teamIdA, teamIdB) {
  const a = squads.get(teamIdA);
  const b = squads.get(teamIdB);
  if (!a || !b) return null;

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const players = [];
  const missingQids = [];
  for (const qid of small) {
    if (!large.has(qid)) continue;
    const entry = names.get(qid);
    if (entry) players.push(entry);
    else missingQids.push(qid);
  }
  return { players, missingQids };
}

const info = () => meta;

load();

module.exports = { has, commonPlayers, info };
