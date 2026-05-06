// =====================================================================
// db.js — PostgreSQL connection pool
// ---------------------------------------------------------------------
// We use the standard `pg` library with a single connection pool that is
// shared across the whole process. Every request that needs a DB call
// borrows a client from the pool, then returns it.
//
// For game-joining we need a transaction, so we expose `getClient()` to
// let the caller manage BEGIN / COMMIT / ROLLBACK explicitly.
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
};
