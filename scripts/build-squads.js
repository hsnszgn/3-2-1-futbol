#!/usr/bin/env node
// Builds server/data/squads.json: for every club in the local alias list, the
// set of players who ever played there, plus their names.
//
// Runs at deploy time (see render.yaml), not at runtime, so a round never
// waits on Wikidata. It is deliberately forgiving — a club that fails, or a
// run that hits the time box, just means that club falls back to the live
// lookup at runtime. Partial data is still shipped.
//
// Run locally with: npm run build:squads

const fs = require('fs');
const path = require('path');
const { TEAMS } = require('../server/data/teams');
const { resolveTeamCandidates, fetchSquadQids, fetchPlayerNames } = require('../server/wikidata');

const OUT_PATH = path.join(__dirname, '..', 'server', 'data', 'squads.json');
const TIME_BUDGET_MS = Number(process.env.SQUAD_BUILD_BUDGET_MS || 9 * 60 * 1000);
const PER_CALL_BUDGET_MS = 25000;
const POLITENESS_MS = Number(process.env.SQUAD_BUILD_DELAY_MS || 250);
const NAME_BATCH = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qidOf = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

async function main() {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;

  const squads = {};
  const clubOf = new Map(); // player qid -> how many clubs they appear in
  let failed = 0;

  for (const team of TEAMS) {
    if (outOfTime()) {
      console.warn(`Time budget reached — stopping after ${Object.keys(squads).length} clubs`);
      break;
    }
    try {
      const deadline = Date.now() + PER_CALL_BUDGET_MS;
      const candidates = await resolveTeamCandidates(team.display, deadline);
      if (!candidates.length) throw new Error('no candidate items');

      const uris = await fetchSquadQids(candidates.map((c) => c.qid), Date.now() + PER_CALL_BUDGET_MS);
      const qids = uris.map(qidOf);
      squads[team.id] = qids;
      for (const qid of qids) clubOf.set(qid, (clubOf.get(qid) || 0) + 1);

      console.log(`${team.display}: ${qids.length} players`);
    } catch (err) {
      failed += 1;
      console.warn(`${team.display}: FAILED (${err.message})`);
    }
    await sleep(POLITENESS_MS);
  }

  // Only players who turn up at more than one club can ever be an answer, so
  // those are the only names worth shipping.
  const needed = [...clubOf.entries()].filter(([, count]) => count > 1).map(([qid]) => qid);
  console.log(`Fetching names for ${needed.length} players who appear at 2+ clubs`);

  const names = {};
  for (let i = 0; i < needed.length; i += NAME_BATCH) {
    if (outOfTime()) {
      console.warn('Time budget reached during name fetch — shipping what we have');
      break;
    }
    const batch = needed.slice(i, i + NAME_BATCH);
    try {
      const rows = await fetchPlayerNames(
        batch.map((qid) => `http://www.wikidata.org/entity/${qid}`),
        Date.now() + PER_CALL_BUDGET_MS,
      );
      for (const row of rows) {
        if (row && row.qid && row.name) names[row.qid] = { name: row.name, aliases: row.aliases || [] };
      }
    } catch (err) {
      console.warn(`name batch ${i}: FAILED (${err.message})`);
    }
    await sleep(POLITENESS_MS);
  }

  // Every squad keeps all of its players, including any whose name we didn't
  // manage to fetch. Dropping them here is what silently turned correct
  // answers into rejections; the server resolves the stragglers at runtime.
  const unnamed = Object.values(squads)
    .flat()
    .filter((qid) => clubOf.get(qid) > 1 && !names[qid]).length;
  if (unnamed) console.warn(`${unnamed} multi-club players have no name yet; server will fetch these on demand`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    builtAt: new Date().toISOString(),
    squads,
    names,
  }));

  const sizeMb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`  clubs: ${Object.keys(squads).length} (${failed} failed)`);
  console.log(`  named players: ${Object.keys(names).length}`);
  console.log(`  size: ${sizeMb} MB, took ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
}

main().catch((err) => {
  // Never fail the deploy over this — the server falls back to live lookups.
  console.error('Squad build failed:', err.message);
  process.exit(0);
});
