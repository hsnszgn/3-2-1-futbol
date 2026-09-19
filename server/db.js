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

const CONNECTION_STRING = process.env.DATABASE_URL || '';
let pool = null;

if (CONNECTION_STRING) {
  pool = new Pool({
    connectionString: CONNECTION_STRING,
    // Hosted Postgres (Neon and friends) terminates TLS with its own chain;
    // local test instances have none at all.
    ssl: /localhost|127\.0\.0\.1/.test(CONNECTION_STRING) ? false : { rejectUnauthorized: false },
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

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS players (
    id            SERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- A deleted account is tombstoned rather than dropped: its identifying
  -- fields are cleared, but the row stays so the OPPONENT's match history and
  -- head-to-head record survive. Deleting one player must not erase another
  -- player's wins.
  ALTER TABLE players ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

  -- Sessions expire. A token that never dies is a password that can never be
  -- changed, and signing out has to mean something on the server too.
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '60 days'
  );

  -- Tables created before sessions expired.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '60 days';

  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

  -- One row per finished game. Stats are derived from these rather than kept
  -- as counters, so they can never drift out of step with history.
  CREATE TABLE IF NOT EXISTS matches (
    id        SERIAL PRIMARY KEY,
    player_a  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    player_b  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    score_a   INTEGER NOT NULL,
    score_b   INTEGER NOT NULL,
    winner_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
    played_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS matches_player_a_idx ON matches(player_a);
  CREATE INDEX IF NOT EXISTS matches_player_b_idx ON matches(player_b);

  -- A game is between two different people. Enforced here as well as in the
  -- matchmaker, because the stats query counts a row once per player and a row
  -- with the same id on both sides is a free win that no amount of application
  -- logic can be trusted to have prevented.
  --
  -- NOT VALID on purpose: it applies to every new row but does not re-check
  -- rows already in the table. A deployment whose history contains such a row
  -- must not fail its migration and switch accounts off for everyone; the bad
  -- row is a separate, deliberate clean-up.
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_distinct_players') THEN
      ALTER TABLE matches
        ADD CONSTRAINT matches_distinct_players CHECK (player_a <> player_b) NOT VALID;
    END IF;
  END $$;

  -- One game, one row, however many times the server tries to save it. The id
  -- is minted when the game starts, so a retry or a double call to endGame
  -- carries the same one and the second insert does nothing.
  ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_uid TEXT;

  -- Rows written before this column existed have NULL, and Postgres allows any
  -- number of NULLs in a unique index, so no back-fill is needed.
  CREATE UNIQUE INDEX IF NOT EXISTS matches_match_uid_key ON matches(match_uid);
`;

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

module.exports = { isEnabled, isReady, query, transaction, migrate, close, STATS_SELECT };
