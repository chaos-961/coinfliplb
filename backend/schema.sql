-- =====================================================================
-- Coinflip LB - PostgreSQL schema
-- ---------------------------------------------------------------------
-- Run this once against your Railway PostgreSQL database to create the
-- tables. See backend/README.md for instructions.
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  balance       NUMERIC(20,0) NOT NULL DEFAULT 100 CHECK (balance >= 0 AND balance = FLOOR(balance)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
  id             SERIAL PRIMARY KEY,
  creator_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joiner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  creator_choice VARCHAR(8) NOT NULL CHECK (creator_choice IN ('heads', 'tails')),
  wager          NUMERIC(20,0) NOT NULL CHECK (wager > 0 AND wager = FLOOR(wager)),
  result         VARCHAR(8) CHECK (result IS NULL OR result IN ('heads', 'tails')),
  winner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'completed', 'cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

-- Helpful indexes for the queries we run most.
CREATE INDEX IF NOT EXISTS idx_games_status     ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_creator    ON games(creator_id);
CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_balance    ON users(balance DESC);

-- Migration for existing deployments created with older decimal columns:
-- ALTER TABLE users ALTER COLUMN balance TYPE NUMERIC(20,0) USING FLOOR(balance);
-- ALTER TABLE games ALTER COLUMN wager TYPE NUMERIC(20,0) USING FLOOR(wager);
-- ALTER TABLE users ADD CONSTRAINT users_balance_whole CHECK (balance >= 0 AND balance = FLOOR(balance));
-- ALTER TABLE games ADD CONSTRAINT games_wager_whole CHECK (wager > 0 AND wager = FLOOR(wager));
