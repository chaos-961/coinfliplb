// =====================================================================
// init-db.js — run schema.sql once against $DATABASE_URL
// ---------------------------------------------------------------------
// Convenience helper so you don't have to open a SQL client. Run with:
//   node init-db.js
// or:
//   npm run init-db
//
// schema.sql is fully idempotent — every CREATE / ALTER uses IF NOT
// EXISTS — so this is safe to re-run after every deploy.
// =====================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    console.log('[init-db] Running schema.sql against the configured database…');
    await db.query(sql);

    // Surface a quick health snapshot so it's obvious the migration worked.
    const counts = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int                  AS users,
        (SELECT COUNT(*) FROM games)::int                  AS games,
        (SELECT COUNT(*) FROM balance_transactions)::int   AS ledger_rows,
        (SELECT COUNT(*) FROM signup_attempts)::int        AS signup_attempts
    `);
    const row = counts.rows[0] || {};
    console.log(`[init-db] Done. Tables ready. Snapshot: users=${row.users}, games=${row.games}, ledger=${row.ledger_rows}, signup_attempts=${row.signup_attempts}`);
    process.exit(0);
  } catch (err) {
    console.error('[init-db] Failed:', err.message);
    process.exit(1);
  }
})();
