// =====================================================================
// init-db.js — run schema.sql once against $DATABASE_URL
// ---------------------------------------------------------------------
// Convenience helper so you don't have to open a SQL client. Run with:
//   node init-db.js
// or:
//   npm run init-db
// =====================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    console.log('[init-db] Running schema.sql...');
    await db.query(sql);
    console.log('[init-db] Done. Tables created (or already existed).');
    process.exit(0);
  } catch (err) {
    console.error('[init-db] Failed:', err.message);
    process.exit(1);
  }
})();
