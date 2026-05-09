# Coinflip LB backend

Run:

```bash
npm install
npm run init-db
npm start
```

Required env vars: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_ORIGIN`.

`npm run init-db` applies `schema.sql`, including the v1.3 cleanup that removes email and old seed-check columns and adds stored stats from existing databases.
