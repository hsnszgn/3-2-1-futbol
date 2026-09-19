#!/usr/bin/env node
/**
 * The test runner: `npm test`.
 *
 * Deliberately dependency-free. Each *.test.js file exports one async function
 * that throws on failure and returns a short line describing what it actually
 * proved — so the output is evidence, not a row of green ticks.
 *
 * Pass a substring to run a subset:  npm test -- socket
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const filter = process.argv[2] || '';

// Database policy, same as the browser runner: nothing here reads DATABASE_URL.
// A test that needs a database says so, and it runs only when
// TEST_DATABASE_URL names a THROWAWAY one — these tests TRUNCATE tables. With
// no such variable those tests are skipped and reported as skipped, never as
// passed.
const TEST_DB = process.env.TEST_DATABASE_URL || '';

async function resetDatabase() {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: TEST_DB,
    ssl: /localhost|127\.0\.0\.1/.test(TEST_DB) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('TRUNCATE matches, sessions, players RESTART IDENTITY CASCADE');
  } catch (err) {
    // On a first run the tables do not exist yet, which is fine. Anything else
    // means the test is about to run against leftover rows, and swallowing it
    // would turn that into a confusing failure somewhere else.
    if (err.code !== '42P01') throw err;
  } finally {
    await client.end();
  }
}

async function main() {
  const files = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => f.includes(filter))
    .sort();

  if (!files.length) {
    console.error(`"${filter}" ile eşleşen test yok`);
    process.exit(1);
  }

  const results = [];
  for (const file of files) {
    const name = file.replace('.test.js', '');
    const run = require(path.join(DIR, file));

    if (run.needsDatabase && !TEST_DB) {
      console.log(`  ${name} ... ATLANDI (TEST_DATABASE_URL gerekli)`);
      results.push({ name, skipped: true });
      continue;
    }

    const started = Date.now();
    process.stdout.write(`  ${name} ... `);
    try {
      if (run.needsDatabase) await resetDatabase();
      const detail = await run({ databaseUrl: TEST_DB });
      const ms = Date.now() - started;
      console.log(`GEÇTİ (${ms}ms)`);
      if (detail) console.log(`      ${detail}`);
      results.push({ name, ok: true });
    } catch (err) {
      const ms = Date.now() - started;
      console.log(`KALDI (${ms}ms)`);
      console.log(`      ${err && err.message}`);
      if (err && err.stack && process.env.TEST_VERBOSE) console.log(err.stack);
      results.push({ name, ok: false, err });
    }
  }

  const ran = results.filter((r) => !r.skipped);
  const failed = ran.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n${TEST_DB ? 'İzole PostgreSQL' : 'Veritabanısız'} koşu:`
    + ` ${ran.length - failed.length}/${ran.length} test geçti`
    + (skipped.length ? ` · ${skipped.length} ATLANDI, doğrulanmadı (${skipped.map((r) => r.name).join(', ')})` : ''));
  if (skipped.length) {
    console.log('Tam sonuç için: TEST_DATABASE_URL=postgres://... npm test');
  }
  if (failed.length) {
    console.log(`Kalanlar: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test koşucusu çöktü:', err);
  process.exit(1);
});
