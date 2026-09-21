// Persistent storage for accounts, match history and the leaderboard.
//
// Everything else in this server lives in memory, which is fine for a room
// that exists for five minutes. Stats are the opposite: a leaderboard that
// resets on every deploy is worse than no leaderboard, and Render's free tier
// has no persistent disk — hence an external Postgres (DATABASE_URL).
//
// Without DATABASE_URL the game still runs exactly as before, just with
// accounts and stats switched off, so local development needs no setup.

const fs = require('fs');
const net = require('net');
const { Pool } = require('pg');
const SCHEMA = require('./schema');

const CONNECTION_STRING = process.env.DATABASE_URL || '';

// Hosts that are this machine. Only these skip TLS, and only by PARSED
// hostname: the previous test was a regex over the whole connection string, so
// a password containing "localhost", or any parameter mentioning 127.0.0.1,
// silently turned encryption off for a remote database.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// SSL settings that `pg-connection-string` reads out of the URL. They do not
// merely coexist with the `ssl` option — they REPLACE it: measured with
// pg's own ConnectionParameters, `?sslmode=no-verify` turns an explicit
// { rejectUnauthorized: true } into { rejectUnauthorized: false }, and
// `?sslmode=disable` turns it into false. So a connection string handed to us
// can undo verification from the outside. They are removed from the URL and the
// decision is made here, in one place, instead.
const SSL_URL_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation'];

function readCa() {
  const inline = process.env.DB_CA_CERT;
  if (inline) return inline;
  const file = process.env.DB_CA_CERT_PATH;
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Loud, and not a silent downgrade: a CA that was meant to be used and
    // cannot be read must not turn into "verify against the system store".
    throw new Error(`DB_CA_CERT_PATH could not be read (${file}): ${err.message}`);
  }
}

/**
 * Works out how to connect, and how to verify the server while doing it.
 *
 * Exported for the tests: the interesting cases are a connection string that
 * tries to weaken TLS and a host that only LOOKS local, and neither can be
 * driven through a live database.
 *
 * @returns {{connectionString: string, ssl: object|false, host: string,
 *            local: boolean, ignoredParams: string[], verified: boolean}}
 */
function sslConfigFor(raw, env = process.env) {
  let url = null;
  try {
    url = new URL(raw);
  } catch (err) {
    url = null; // unparseable: treat it as remote, which is the safe direction
  }

  const urlHost = url ? url.hostname.toLowerCase() : '';

  // Where pg will ACTUALLY connect. A `host=` query parameter overrides the
  // authority in the URL — measured against the driver's own parser — so reading
  // URL.hostname alone let a connection string keep the local no-TLS exception
  // while pointing the driver at a remote server:
  //
  //   postgres://user:pw@localhost/app?host=db.example.com
  //     policy said host=localhost, local=true, ssl=false
  //     driver connected to db.example.com, unencrypted
  //
  // The decision follows the real target, which is the safe direction: a remote
  // target is verified even when the authority looks local.
  const queryHost = url ? (url.searchParams.get('host') || '').trim().toLowerCase() : '';
  const host = queryHost || urlHost;
  const local = Boolean(host) && LOCAL_HOSTS.has(host);

  const hostOverridden = Boolean(queryHost) && queryHost !== urlHost;
  const ignoredParams = [];
  let connectionString = raw;
  if (url) {
    for (const param of SSL_URL_PARAMS) {
      if (!url.searchParams.has(param)) continue;
      ignoredParams.push(param);
      url.searchParams.delete(param);
    }
    connectionString = url.toString();
  }

  // DB_SSL: 'off' disables TLS outright (a local socket, or a provider-side
  // tunnel that terminates it), 'on' forces verification even for a local host.
  // There is no "encrypt but do not check" setting: that is what the old
  // rejectUnauthorized: false was, and it accepts any certificate at all,
  // including one a man in the middle just generated.
  const mode = String(env.DB_SSL || '').toLowerCase();
  if (mode === 'off') {
    return { connectionString, ssl: false, host, urlHost, hostOverridden, local, ignoredParams, verified: false };
  }
  // The transition escape hatch, and the only way back to the old behaviour:
  // encrypted but accepting any certificate. It has to be set deliberately, it
  // is logged on every boot, and it exists because turning verification on for
  // a provider whose chain has not been confirmed would take accounts down —
  // not because "it is fine in production".
  if (mode === 'no-verify') {
    return {
      connectionString,
      ssl: { rejectUnauthorized: false },
      host,
      urlHost,
      hostOverridden,
      local,
      ignoredParams,
      verified: false,
    };
  }
  if (local && mode !== 'on') {
    return { connectionString, ssl: false, host, urlHost, hostOverridden, local, ignoredParams, verified: false };
  }

  const ca = readCa();
  return {
    connectionString,
    ssl: {
      rejectUnauthorized: true,
      // Checked against the name we are actually asking for, so a valid
      // certificate for some OTHER host is still refused. An IP address is not
      // a valid SNI name (RFC 6066) — Node verifies it against the address
      // instead, so it is left unset there.
      ...(host && net.isIP(host) === 0 ? { servername: host } : {}),
      ...(ca ? { ca } : {}),
    },
    host,
    urlHost,
    hostOverridden,
    local,
    ignoredParams,
    verified: true,
  };
}

let pool = null;

if (CONNECTION_STRING) {
  const tls = sslConfigFor(CONNECTION_STRING);
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

module.exports = { isEnabled, isReady, query, transaction, migrate, close, sslConfigFor, SCHEMA, STATS_SELECT };
