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
    const started = Date.now();
    process.stdout.write(`  ${name} ... `);
    try {
      const run = require(path.join(DIR, file));
      const detail = await run();
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} test geçti`);
  if (failed.length) {
    console.log(`Kalanlar: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test koşucusu çöktü:', err);
  process.exit(1);
});
