#!/usr/bin/env node
/**
 * Measurement retention, by hand (roadmap M1).
 *
 *   npm run beta:retention            # counts what WOULD be deleted, deletes nothing
 *   npm run beta:retention -- --apply # deletes it
 *
 * The server runs the same purge on its own when TELEMETRY_ENABLED=1. This
 * command exists for the case the server cannot cover — measurement switched
 * off again with rows still stored — and it defaults to a dry run because it
 * deletes from whatever database the environment names.
 *
 * Connection string from REPORT_DATABASE_URL / DATABASE_URL only, under the
 * server's TLS policy (server/dbTls.js).
 */
const { Client } = require('pg');
const { clientConfig } = require('./beta-report');
const retention = require('../server/retention');

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.REPORT_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!url) {
    console.error('REPORT_DATABASE_URL (or DATABASE_URL) is required; the connection string is '
      + 'never taken from the command line.');
    process.exit(2);
  }
  let config;
  try {
    config = clientConfig(url);
  } catch (err) {
    console.error(`refusing to connect: ${err.message}`);
    process.exit(2);
  }
  // A test seam for the clock, and ONLY that: moving "now" forward is how the
  // tests see a month pass. It is refused together with --apply against
  // anything but a local database, so it cannot be used to delete young rows
  // from a real one.
  const nowArg = process.argv.find((a) => a.startsWith('--now='));
  const now = nowArg ? new Date(nowArg.slice(6)) : new Date();
  if (nowArg && apply && !/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    console.error('refusing --now together with --apply on a non-local database');
    process.exit(2);
  }
  const client = new Client(config);
  await client.connect();
  try {
    const result = apply ? await retention.purge(client, now) : await retention.preview(client, now);
    const verb = apply ? 'silindi' : 'silinecek (deneme, hiçbir şey silinmedi)';
    process.stdout.write(`${JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      eventsCutoff: result.cutoffs.events.toISOString(),
      reportsCutoff: result.cutoffs.reports.toISOString(),
      events: result.events,
      reports: result.reports,
    })}\n`);
    console.error(`ham olay: ${result.events} ${verb}; rapor: ${result.reports} ${verb}`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`telemetry-retention failed: ${err && err.message}`);
  process.exit(2);
});
