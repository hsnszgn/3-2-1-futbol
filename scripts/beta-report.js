#!/usr/bin/env node
/**
 * The beta report (roadmap M4/M6). Read-only.
 *
 *   npm run beta:report -- --from 2026-10-01T00:00:00Z --to 2026-10-08T00:00:00Z \
 *     --cohort beta-01 --release <sha> --format markdown
 *
 * Reads the measurement events and prints the counts, the two completion ratios
 * and a status. It writes nothing and fixes nothing: a report that repairs its
 * own input cannot be used as evidence about the thing it repaired.
 *
 * The connection string comes from the environment (REPORT_DATABASE_URL, falling
 * back to DATABASE_URL), never from the command line, so it does not end up in a
 * shell history or a CI log. A read-only database user is the intended way to run
 * this.
 *
 * Deliberate properties, each of them a way this report could otherwise lie:
 *
 *  * Scope is by START time, `[from, to)`. A game that runs past `to` still
 *    belongs to the window it started in, so the denominator cannot be trimmed
 *    by choosing when to stop looking.
 *  * `as_of` is printed. Events can arrive late; the same window recomputed
 *    later may say something different, and the reader has to be able to see
 *    which run they are holding.
 *  * A failed query, a degraded measurement, or a window without continuous
 *    heartbeat evidence is OBSERVABILITY_GAP or INSUFFICIENT_DATA — never PASS
 *    with empty numbers.
 *  * `--gate` makes the exit code follow the release gate (report PASS AND the
 *    last 72 hours continuously observed with real games), not just the report.
 *  * Percentages are never printed without the raw counts beside them.
 */

const { Client } = require('pg');
const { collect, buildReport, markdown, clientConfig } = require('../server/betaReport');

function parseArgs(argv) {
  const args = { format: 'markdown' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i += 1] : 'true';
    args[key] = value;
  }
  return args;
}

function isoOrNull(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--${label} is not a date: ${value}`);
  return date;
}

/**
 * The game set both commands work on. One function, so the report and the
 * reconciliation cannot quietly look at two different windows.
 */
function scopeFromArgs(args) {
  return {
    from: isoOrNull(args.from, 'from'),
    to: isoOrNull(args.to, 'to'),
    cohort: args.cohort || null,
    release: args.release || null,
    environment: args.environment || null,
    // Only real beta traffic counts towards H. Overridable for inspection, but
    // the default is the one the gate is about.
    trafficKind: args['traffic-kind'] || 'human_beta',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.REPORT_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!url) {
    console.error('REPORT_DATABASE_URL (or DATABASE_URL) is required; the connection string is '
      + 'never taken from the command line.');
    process.exit(2);
  }
  const scope = scopeFromArgs(args);
  let config;
  try {
    config = clientConfig(url);
  } catch (err) {
    console.error(`refusing to connect: ${err.message}`);
    process.exit(2);
  }
  const client = new Client(config);
  let report;
  try {
    await client.connect();
    report = await buildReport(client, scope, {
      minGames: Number(args['min-games'] || 100),
      minTechnicalPct: Number(args['min-technical'] || 98),
      heartbeatMs: args['heartbeat-ms'] ? Number(args['heartbeat-ms']) : undefined,
    });
  } catch (err) {
    // connect() failing lands here: still a report, still not a pass.
    report = await buildReport({ query: async () => { throw err; } }, scope, {});
  } finally {
    await client.end().catch(() => {});
  }

  if ((args.format || 'markdown') === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(markdown(report));
  }
  // Non-zero for anything that is not a pass, so a scheduler notices.
  const passed = args.gate === 'true' ? report.gate === 'PASS' : report.status === 'PASS';
  process.exit(passed ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`beta-report failed: ${err && err.stack}`);
    process.exit(2);
  });
}

module.exports = { parseArgs, collect, markdown, clientConfig, scopeFromArgs, buildReport };
