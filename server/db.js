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
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
}

const isEnabled = () => Boolean(pool);

async function query(text, params) {
  if (!pool) throw new Error('database not configured');
  return pool.query(text, params);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS players (
    id            SERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

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
`;

async function migrate() {
  if (!pool) {
    console.log('DATABASE_URL not set — accounts and leaderboard are disabled');
    return false;
  }
  try {
    await pool.query(SCHEMA);
    console.log('Database ready');
    return true;
  } catch (err) {
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

module.exports = { isEnabled, query, migrate, STATS_SELECT };
