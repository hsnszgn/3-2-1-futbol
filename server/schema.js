/**
 * The database schema, as one idempotent statement.
 *
 * Kept apart from db.js on purpose: db.js opens a connection pool the moment it
 * is required, so anything that only needs the SQL — the test runners, which
 * create the schema before truncating — would either open a pool it does not
 * want or, worse, load db.js before DATABASE_URL is set and leave a poolless
 * module in the require cache for everything after it. That is exactly what
 * happened. This file has no side effects at all.
 */

module.exports = `
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
