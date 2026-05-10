# Coinflip LB backend (v1.4)

## Quick start

```bash
npm install
cp .env.example .env       # then fill in DATABASE_URL, JWT_SECRET, FRONTEND_ORIGIN
npm run init-db            # idempotent — safe to re-run
npm start
```

Required env vars: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_ORIGIN`.

## What changed in v1.4

The previous schema referenced `signup_ip_hash` in an index without ever
creating the column, so `npm run init-db` failed on a fresh database.
The schema now creates every column the server reads or writes
**before** any index that touches them. The migration is fully
idempotent — `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` is used
throughout, so running `npm run init-db` against an existing v1.3
database does the right thing without errors.

## Notes

Run a single backend replica unless you add Redis pub/sub. SSE
notifications, online count, cooldowns, and the join fast-fail lock
are kept in process memory; the database transaction is what
guarantees money correctness, but the in-memory bits would diverge
across replicas.
