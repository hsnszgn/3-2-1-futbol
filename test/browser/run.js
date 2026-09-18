#!/usr/bin/env node
/**
 * Browser-level tests: `npm run test:browser`.
 *
 * These drive the real client in two Chromium contexts — two actual players —
 * against the real server. They are separate from `npm test` because they need
 * Playwright, and the account tests additionally need a database.
 *
 * Database policy (deliberate, after an audit found tests could inherit a
 * production DATABASE_URL): nothing here reads DATABASE_URL. A database is
 * used only when TEST_DATABASE_URL is set, and it must point at a throwaway
 * database — these tests TRUNCATE tables. Without it the account specs are
 * skipped and clearly reported as skipped, not as passed.
 *
 *   npm run test:browser
 *   TEST_DATABASE_URL=postgres://... npm run test:browser
 *   npm run test:browser -- invite          # tek test
 */
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('../helpers');

const DIR = __dirname;
const filter = process.argv[2] || '';
const TEST_DB = process.env.TEST_DATABASE_URL || '';

function loadPlaywright() {
  try {
    // eslint-disable-next-line global-require
    return require('playwright');
  } catch (err) {
    return null;
  }
}

async function resetDatabase() {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: TEST_DB,
    ssl: /localhost|127\.0\.0\.1/.test(TEST_DB) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query('TRUNCATE matches, sessions, players RESTART IDENTITY CASCADE')
    .catch(() => {}); // tables may not exist on the very first run
  await client.end();
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.error('Playwright kurulu değil. Kurulum: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }

  const specs = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.spec.js'))
    .filter((f) => f.includes(filter))
    .sort()
    .map((f) => ({ file: f, name: f.replace('.spec.js', ''), mod: require(path.join(DIR, f)) }));

  if (!specs.length) {
    console.error(`"${filter}" ile eşleşen tarayıcı testi yok`);
    process.exit(1);
  }

  const needsDb = specs.some((s) => s.mod.needsDatabase);
  if (needsDb && !TEST_DATABASE_URL_present()) {
    console.log('TEST_DATABASE_URL tanımlı değil — hesap testleri ATLANACAK (başarılı sayılmayacak).\n');
  }

  // The setup has to be reproducible, so the run states which versions it
  // actually used rather than leaving it to whatever prose accompanies it.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});
  console.log(`  Playwright ${require('playwright/package.json').version}`
    + ` · Chromium ${browser.version()}`
    + ` · veritabanı: ${TEST_DB ? 'izole PostgreSQL (TEST_DATABASE_URL)' : 'yok'}\n`);
  const results = [];

  for (const spec of specs) {
    if (spec.mod.needsDatabase && !TEST_DB) {
      console.log(`  ${spec.name} ... ATLANDI (TEST_DATABASE_URL gerekli)`);
      results.push({ name: spec.name, skipped: true });
      continue;
    }

    const started = Date.now();
    process.stdout.write(`  ${spec.name} ... `);
    let server;
    try {
      if (spec.mod.needsDatabase) await resetDatabase();
      // A spec may ask for different server settings — a one-round game, say,
      // so it can reach the end state without playing five.
      server = await startTestServer({
        ...(spec.mod.env || {}),
        ...(spec.mod.needsDatabase ? { DATABASE_URL: TEST_DB } : {}),
      });
      const detail = await spec.mod.run({ browser, baseUrl: server.url });
      console.log(`GEÇTİ (${Date.now() - started}ms)`);
      if (detail) console.log(`      ${detail}`);
      results.push({ name: spec.name, ok: true });
    } catch (err) {
      console.log(`KALDI (${Date.now() - started}ms)`);
      console.log(`      ${err && err.message}`);
      if (process.env.TEST_VERBOSE && err && err.stack) console.log(err.stack);
      results.push({ name: spec.name, ok: false });
    } finally {
      if (server) await server.stop();
    }
  }

  await browser.close();

  const ran = results.filter((r) => !r.skipped);
  const failed = ran.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  // DB-less and isolated-PostgreSQL runs are reported as separate results, not
  // merged into one number: a suite that skipped the account specs has not
  // verified them, and saying so is the whole point.
  console.log(`\n${TEST_DB ? 'İzole PostgreSQL' : "Veritabanısız"} koşu:`
    + ` ${ran.length - failed.length}/${ran.length} tarayıcı testi geçti`
    + (skipped.length ? ` · ${skipped.length} ATLANDI, doğrulanmadı (${skipped.map((s) => s.name).join(', ')})` : ''));
  if (!TEST_DB) {
    console.log('Hesap/oturum senaryoları bu koşuda doğrulanmadı.'
      + ' Tam sonuç için: TEST_DATABASE_URL=postgres://... npm run test:browser');
  }
  if (failed.length) {
    console.log(`Kalanlar: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

function TEST_DATABASE_URL_present() {
  return Boolean(TEST_DB);
}

main().catch((err) => {
  console.error('Tarayıcı koşucusu çöktü:', err);
  process.exit(1);
});
