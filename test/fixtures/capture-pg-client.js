/**
 * Preloaded with `node -r` by test/beta-report.test.js. Replaces pg's Client in
 * THIS process only: the constructor reports what the real driver would do with
 * the configuration it was given — host and ssl, from pg's own
 * ConnectionParameters — and exits before any connection is attempted.
 */
const pg = require('pg');
const ConnectionParameters = require('pg/lib/connection-parameters');

pg.Client = class CaptureClient {
  constructor(config) {
    const actual = new ConnectionParameters(config);
    process.stdout.write(`__PG_CLIENT__${JSON.stringify({ host: actual.host, ssl: actual.ssl })}\n`);
    process.exit(0);
  }
};
