-- =====================================================================
-- Coinflip LB schema (v1.4)
-- ---------------------------------------------------------------------
-- Fully idempotent. Safe to re-run after every deploy.
--
-- IMPORTANT: The previous schema (v1.3) was broken — it referenced
-- columns like `signup_ip_hash` in indexes WITHOUT first creating them,
-- so `npm run init-db` failed on any fresh database. This file fixes
-- that by creating every column that server.js reads or writes,
-- BEFORE creating any index that touches them.
-- =====================================================================

-- ---------- users ---------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  balance       NUMERIC(20,0) NOT NULL DEFAULT 100 CHECK (balance >= 0 AND balance = FLOOR(balance)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column additions for stats and signup-fingerprinting.
-- All of these are referenced by server.js and the leaderboard query;
-- without them the app crashes at runtime.
ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wins               INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS losses             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_win_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_win_streak     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip_hash     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ua_hash     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip_hash       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at       TIMESTAMPTZ;

-- v1.3 cleanup: remove old email and seed-check columns if they exist.
-- These were dropped from the product but could linger on upgraded DBs.
ALTER TABLE users  DROP COLUMN IF EXISTS email;
ALTER TABLE users  DROP COLUMN IF EXISTS email_verified;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_balance         ON users(balance DESC);
CREATE INDEX IF NOT EXISTS idx_users_signup_ip_hash  ON users(signup_ip_hash);
CREATE INDEX IF NOT EXISTS idx_users_created_at      ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_leaderboard     ON users(balance DESC, created_at ASC);

-- ---------- games ---------------------------------------------------
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

-- v1.3 cleanup: drop old provably-fair / seed-check columns if present.
ALTER TABLE games DROP COLUMN IF EXISTS server_seed;
ALTER TABLE games DROP COLUMN IF EXISTS server_seed_hash;
ALTER TABLE games DROP COLUMN IF EXISTS client_seed;
ALTER TABLE games DROP COLUMN IF EXISTS nonce;
ALTER TABLE games DROP COLUMN IF EXISTS pf_algo;

CREATE INDEX IF NOT EXISTS idx_games_status         ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_creator        ON games(creator_id);
CREATE INDEX IF NOT EXISTS idx_games_joiner         ON games(joiner_id);
CREATE INDEX IF NOT EXISTS idx_games_created_at     ON games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_completed_at   ON games(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_status_created ON games(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_status_wager   ON games(status, wager);

-- ---------- balance_transactions (audit ledger) --------------------
CREATE TABLE IF NOT EXISTS balance_transactions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(32) NOT NULL,
  amount          NUMERIC(20,0) NOT NULL,
  balance_before  NUMERIC(20,0) NOT NULL,
  balance_after   NUMERIC(20,0) NOT NULL,
  related_game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_tx_user        ON balance_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_tx_game        ON balance_transactions(related_game_id);
CREATE INDEX IF NOT EXISTS idx_balance_tx_type        ON balance_transactions(type);
CREATE INDEX IF NOT EXISTS idx_balance_tx_created_at  ON balance_transactions(created_at DESC);

-- ---------- signup_attempts (abuse tracking) -----------------------
CREATE TABLE IF NOT EXISTS signup_attempts (
  id          BIGSERIAL PRIMARY KEY,
  ip_hash     TEXT NOT NULL,
  ua_hash     TEXT,
  success     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signup_attempts_ip_time ON signup_attempts(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_created ON signup_attempts(created_at DESC);
