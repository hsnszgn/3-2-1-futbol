// Persistent storage for accounts, match history and the leaderboard.
//
// Everything else in this server lives in memory, which is fine for a room
// that exists for five minutes. Stats are the opposite: a leaderboard that
// resets on every deploy is worse than no leaderboard, and Render's free tier
// has no persistent disk — hence an external Postgres (DATABASE_URL).
//
// Without DATABASE_URL the game still runs exactly as before, just with
// accounts and stats switched off, so local development needs no setup.

const { Pool } = require('pg');
const SCHEMA = require('./schema');
// The TLS policy lives in its own side-effect-free module so the report
// commands can use exactly this rule without opening a pool.
const { sslConfigFor, assertDriverAgrees } = require('./dbTls');

const CONNECTION_STRING = process.env.DATABASE_URL || '';

let pool = null;

// An unusable connection string disables accounts rather than taking the game
// down: this runs at require time, so throwing here would kill the process, and
// the game itself needs no database at all.
let tls = null;
if (CONNECTION_STRING) {
  try {
    tls = sslConfigFor(CONNECTION_STRING);
  } catch (err) {
    console.error(`DATABASE_URL refused, accounts are disabled: ${err.message}`);
  }
}

if (tls) {
  if (tls.ignoredParams.length) {
    // Names only — a connection string's values are secrets.
    console.warn('DATABASE_URL SSL parameters ignored (TLS is decided in code):'
      + ` ${tls.ignoredParams.join(', ')}`);
  }
  if (tls.hostOverridden) {
    // Not refused: a pooler or socket directory can legitimately be named this
    // way. Said out loud, because the address in the URL is no longer the
    // machine being talked to, and the TLS decision follows the parameter.
    console.warn(`DATABASE_URL host parameter overrides the address in the URL:`
      + ` connecting to "${tls.host}", not "${tls.urlHost}". TLS is decided from the former.`);
  }
  if (!tls.verified) {
    const why = tls.ssl ? 'DB_SSL=no-verify — any certificate is accepted'
      : (tls.local ? 'local host, TLS not used' : 'DB_SSL=off, TLS not used');
    console.warn(`Database TLS verification is OFF for host "${tls.host || '(unknown)'}" (${why})`);
  }
  pool = new Pool({
    connectionString: tls.connectionString,
    ssl: tls.ssl,
    max: 5,
    idleTimeoutMillis: 30000,
    // Bounded waits, so a database that has gone away fails the request instead
    // of holding it open. Without these, an outage does not produce errors — it
    // produces a page that never finishes loading, which is worse, because
    // nothing anywhere says what is wrong.
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 8000,
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS) || 10000,
    statement_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS) || 10000,
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
}

// CONFIGURED: a connection string was supplied and a pool exists.
const isEnabled = () => Boolean(pool);

// READY: configured, and the schema is actually in place.
//
// These were the same thing, and they are not. A failed migration left
// isEnabled() true, so /api/config still announced that accounts worked, the
// sign-up form still appeared, and every attempt to use it failed against
// tables that were not there. "We have a connection string" is not "this
// works".
let schemaReady = false;
const isReady = () => Boolean(pool) && schemaReady;

async function query(text, params) {
  if (!pool) throw new Error('database not configured');
  return pool.query(text, params);
}

/**
 * Runs `fn` inside a transaction on ONE connection, so the statements inside it
 * either all land or none do.
 *
 * db.query() takes an arbitrary connection from the pool, which means a
 * multi-statement operation written with it is not atomic: a crash between two
 * calls leaves the halfway state committed. Account deletion is the case that
 * matters — half a deletion is worse than none.
 */
async function transaction(fn) {
  if (!pool) throw new Error('database not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}


async function migrate() {
  if (!pool) {
    console.log('DATABASE_URL not set — accounts and leaderboard are disabled');
    return false;
  }
  try {
    await pool.query(SCHEMA);
    schemaReady = true;
    console.log('Database ready');
    return true;
  } catch (err) {
    schemaReady = false;
    console.error('Database migration failed:', err.message);
    return false;
  }
}

/**
 * Wins / draws / losses per player, counted from match history. Shared by the
 * leaderboard and by a single player's profile so the two can never disagree.
 */
const STATS_SELECT = `
  SELECT
    p.id,
    p.username,
    p.display_name,
    COUNT(m.id)                                                        AS games,
    COUNT(*) FILTER (WHERE m.winner_id = p.id)                         AS wins,
    COUNT(*) FILTER (WHERE m.id IS NOT NULL AND m.winner_id IS NULL)   AS draws,
    COUNT(*) FILTER (WHERE m.id IS NOT NULL AND m.winner_id IS NOT NULL
                       AND m.winner_id <> p.id)                        AS losses
  FROM players p
  LEFT JOIN matches m ON m.player_a = p.id OR m.player_b = p.id
`;

/** Lets the process exit cleanly instead of waiting on idle pool sockets. */
async function close() {
  if (pool) await pool.end().catch(() => {});
}

module.exports = {
  isEnabled, isReady, query, transaction, migrate, close, sslConfigFor, SCHEMA, STATS_SELECT,
  // Test seam only: the driver-agreement check on a config the tests build.
  _assertDriverAgrees: assertDriverAgrees,
};
