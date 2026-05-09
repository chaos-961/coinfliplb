// =====================================================================
// db.js — PostgreSQL connection pool + ledger-aware balance helpers
// ---------------------------------------------------------------------
// We use the standard `pg` library with a single connection pool that is
// shared across the whole process. Every request that needs a DB call
// borrows a client from the pool, then returns it.
//
// For game-joining we need a transaction, so we expose `getClient()` to
// let the caller manage BEGIN / COMMIT / ROLLBACK explicitly.
//
// v1.1 adds two helpers — `applyBalanceDelta` and `applyBalanceDeltaCapped`
// — which atomically update a user's balance AND insert a matching row
// into `balance_transactions`. Every code path that changes a balance
// MUST go through these so we never end up with an unaudited movement.
// =====================================================================

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error(
    '[db] DATABASE_URL is not set. Configure it in your .env file or in ' +
    'your Railway service variables before starting the server.'
  );
}

// Railway-managed Postgres requires SSL but with a self-signed cert. We
// turn on SSL whenever DATABASE_URL is present and disable strict CA
// verification so it works both on Railway and locally with a normal
// connection string.
const useSSL = !!process.env.DATABASE_URL &&
               process.env.PGSSLMODE !== 'disable' &&
               !process.env.DATABASE_URL.includes('localhost') &&
               !process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // The pool may emit errors for idle clients. Log them so they don't
  // crash the process silently.
  console.error('[db] Unexpected pool error:', err);
});

// ---------------------------------------------------------------------
// Allowed ledger transaction types. Centralised so callers can't typo a
// type and create rows the admin queries don't recognise.
// ---------------------------------------------------------------------
const LEDGER_TYPES = Object.freeze({
  SIGNUP_BONUS:       'signup_bonus',
  GAME_CREATE_DEBIT:  'game_create_debit',
  GAME_CANCEL_REFUND: 'game_cancel_refund',
  GAME_JOIN_DEBIT:    'game_join_debit',
  GAME_WIN_PAYOUT:    'game_win_payout',
  STALE_REFUND:       'stale_refund',
  ADMIN_ADJUSTMENT:   'admin_adjustment',
});
const LEDGER_TYPE_SET = new Set(Object.values(LEDGER_TYPES));

/**
 * Update a user's balance by `delta` (positive = credit, negative = debit)
 * and insert a matching ledger row. Caller MUST be inside an open
 * transaction (`client.query('BEGIN')` already issued).
 *
 *   client          — pg client owning the open transaction
 *   userId          — target user
 *   delta           — signed integer-valued amount (positive credits, negative debits)
 *   type            — one of LEDGER_TYPES.*
 *   relatedGameId   — game.id for game-related entries, else null
 *   metadata        — optional plain object stored as JSONB
 *
 * Returns the updated user row { id, username, balance, created_at } on
 * success, or null if the update could not be applied (insufficient funds
 * for a debit). Caller is expected to ROLLBACK in the null case.
 *
 * The UPDATE uses a guard (`balance + delta >= 0`) so a debit that would
 * push the balance negative simply does nothing — never trust the caller
 * to have checked the balance.
 */
async function applyBalanceDelta(client, userId, delta, type, relatedGameId = null, metadata = null) {
  if (!client) throw new Error('applyBalanceDelta requires a transactional client');
  if (!Number.isFinite(delta)) throw new Error('applyBalanceDelta: delta must be a finite number');
  if (!LEDGER_TYPE_SET.has(type)) throw new Error(`applyBalanceDelta: unknown type ${type}`);

  // Atomic UPDATE…RETURNING with non-negative guard. If the guard fails,
  // rowCount === 0 and we tell the caller to roll back.
  const upd = await client.query(
    `UPDATE users
        SET balance = balance + $1
      WHERE id = $2
        AND balance + $1 >= 0
      RETURNING id, username, balance, created_at, balance - $1 AS balance_before`,
    [delta, userId]
  );
  if (upd.rowCount === 0) return null;

  const row = upd.rows[0];
  await client.query(
    `INSERT INTO balance_transactions
       (user_id, type, amount, balance_before, balance_after, related_game_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      type,
      delta,
      row.balance_before,
      row.balance,
      relatedGameId,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );

  return {
    id: row.id,
    username: row.username,
    balance: row.balance,
    created_at: row.created_at,
  };
}

/**
 * Like applyBalanceDelta but caps the resulting balance at `cap`. Used
 * for winnings so a winner can't push the leaderboard past MAX_BALANCE.
 * If the credit would exceed the cap, the actual credited amount is
 * reduced and the ledger row reflects that smaller amount.
 */
async function applyBalanceDeltaCapped(client, userId, delta, cap, type, relatedGameId = null, metadata = null) {
  if (delta < 0) {
    // Cap only applies to credits; for debits this is the same as the uncapped helper.
    return applyBalanceDelta(client, userId, delta, type, relatedGameId, metadata);
  }
  if (!client) throw new Error('applyBalanceDeltaCapped requires a transactional client');
  if (!LEDGER_TYPE_SET.has(type)) throw new Error(`applyBalanceDeltaCapped: unknown type ${type}`);

  const cur = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (cur.rowCount === 0) return null;
  const before = Number(cur.rows[0].balance);
  const wanted = before + Number(delta);
  const capped = Math.min(wanted, Number(cap));
  const realDelta = capped - before; // could be 0 if balance is already at cap

  const upd = await client.query(
    `UPDATE users
        SET balance = $1
      WHERE id = $2
      RETURNING id, username, balance, created_at`,
    [capped, userId]
  );
  if (upd.rowCount === 0) return null;

  // Always write the ledger row — even a 0-delta payout records that the
  // payout was awarded but capped, which is useful for support.
  await client.query(
    `INSERT INTO balance_transactions
       (user_id, type, amount, balance_before, balance_after, related_game_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      type,
      realDelta,
      before,
      capped,
      relatedGameId,
      JSON.stringify({ requested: Number(delta), cap: Number(cap), ...(metadata || {}) }),
    ]
  );

  return upd.rows[0];
}

module.exports = {
  /**
   * Run a single parameterized query. Use this for everything that
   * does not need a transaction.
   */
  query: (text, params) => pool.query(text, params),

  /**
   * Acquire a dedicated client from the pool. The caller MUST call
   * client.release() when done (typically in a `finally` block).
   */
  getClient: () => pool.connect(),

  pool,

  // Ledger helpers — see comments above.
  LEDGER_TYPES,
  applyBalanceDelta,
  applyBalanceDeltaCapped,
};
