-- =====================================================================
-- Coinflip Gold — PostgreSQL schema (v1.1, public-release)
-- ---------------------------------------------------------------------
-- This file is idempotent. Running it against a fresh database creates
-- everything the app needs; running it against an older v1.0 database
-- adds the new columns/tables/indexes safely (existing data is kept).
--
-- For the simplest path on Railway:
--   npm run init-db
-- which executes this whole file via init-db.js.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Users
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  balance       NUMERIC(20,0) NOT NULL DEFAULT 100 CHECK (balance >= 0 AND balance = FLOOR(balance)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- v1.1 columns added safely on existing deployments.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email             TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip_hash    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ua_hash    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip_hash      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at      TIMESTAMPTZ;
-- Bumping token_version invalidates every JWT issued before the bump.
-- Used by logout-all / password reset flows.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version     INTEGER NOT NULL DEFAULT 0;

-- Case-insensitive username uniqueness. The original VARCHAR(32) UNIQUE
-- constraint is case-sensitive, so "alice" and "Alice" could coexist.
-- The functional unique index below closes that gap and is also what the
-- registration race-handler depends on.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq ON users (LOWER(username));

-- Optional unique index on lower(email). NULLs are allowed and not unique
-- with each other, so users without an email are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq ON users (LOWER(email)) WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_balance        ON users(balance DESC);
CREATE INDEX IF NOT EXISTS idx_users_signup_ip_hash ON users(signup_ip_hash);
CREATE INDEX IF NOT EXISTS idx_users_created_at     ON users(created_at DESC);


-- ---------------------------------------------------------------------
-- 2. Games
-- ---------------------------------------------------------------------
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

-- v1.1 provably-fair columns. server_seed is hidden from the client until
-- the game completes; server_seed_hash is shown immediately so users can
-- verify the seed wasn't changed after the fact.
ALTER TABLE games ADD COLUMN IF NOT EXISTS server_seed       TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS server_seed_hash  TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS client_seed       TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS nonce             BIGINT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS pf_algo           TEXT;

-- Indexes the API queries lean on.
CREATE INDEX IF NOT EXISTS idx_games_status         ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_creator        ON games(creator_id);
CREATE INDEX IF NOT EXISTS idx_games_joiner         ON games(joiner_id);
CREATE INDEX IF NOT EXISTS idx_games_created_at     ON games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_completed_at   ON games(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_status_created ON games(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_status_wager   ON games(status, wager);


-- ---------------------------------------------------------------------
-- 3. Balance transaction ledger (v1.1)
-- ---------------------------------------------------------------------
-- Every change to users.balance is paired with one row here, written in
-- the same SQL transaction. This gives us:
--   - A full audit trail for every Gold movement.
--   - A way to detect bugs that silently change balances.
--   - An admin tool surface for suspicious-activity queries.
--
-- Allowed `type` values are validated by the application layer, not
-- the schema, so we don't have to migrate the CHECK constraint every
-- time a new movement type is added.
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 4. Signup-attempt log (v1.1) — DB-backed IP/UA throttle
-- ---------------------------------------------------------------------
-- We keep one row per signup attempt (success OR fail) so signup-rate
-- limits survive process restarts and (eventually) multi-replica
-- deployments. Old rows are reaped by the background job in server.js.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signup_attempts (
  id          BIGSERIAL PRIMARY KEY,
  ip_hash     TEXT NOT NULL,
  ua_hash     TEXT,
  success     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signup_attempts_ip_time ON signup_attempts(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_created ON signup_attempts(created_at DESC);


-- ---------------------------------------------------------------------
-- Optional cleanup: drop the original case-sensitive UNIQUE constraint
-- on users.username if it exists. The functional unique index above is
-- strictly stronger, so this is safe -- but we leave it as a manual step
-- because the constraint name varies across deployments.
--
-- Find the name with:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'u';
-- Then run, e.g.:
--   ALTER TABLE users DROP CONSTRAINT users_username_key;
--
-- Leaving it in place is harmless; signup logic uses LOWER() comparisons.
-- =====================================================================
