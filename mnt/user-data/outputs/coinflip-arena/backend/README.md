# CoinFlip Arena — Backend

Node.js + Express + PostgreSQL API. This is the source of truth for accounts,
balances, and game results. The frontend is a thin client; nothing important
runs only in the browser.

## Run locally

```bash
cd backend
cp .env.example .env
# edit .env and set DATABASE_URL + JWT_SECRET (at minimum)
npm install
npm run init-db    # creates the tables
npm start          # http://localhost:3000
```

You'll need a Postgres database. Easiest options:

- Use the `DATABASE_URL` from your Railway PostgreSQL plugin while developing.
- Or run a local Postgres (e.g. `brew install postgresql` / Docker) and point
  `DATABASE_URL` at it. SSL is auto-disabled when the URL contains `localhost`.

## Endpoints

| Method | Path                    | Auth | Purpose                              |
|--------|-------------------------|------|--------------------------------------|
| POST   | `/api/auth/signup`      | no   | Create account, returns `{token,user}` |
| POST   | `/api/auth/login`       | no   | Log in, returns `{token,user}`         |
| GET    | `/api/me`               | yes  | Current user (incl. balance)           |
| POST   | `/api/games`            | yes  | Create open game (`{choice,wager}`)    |
| GET    | `/api/games`            | yes  | List open games (filter by wager)      |
| POST   | `/api/games/:id/join`   | yes  | Join + flip + settle, atomic           |
| GET    | `/api/games/:id`        | yes  | Game details                           |
| GET    | `/api/leaderboard`      | yes  | Top 50 users by balance                |
| GET    | `/health`               | no   | Liveness check                         |

Auth is a Bearer token in `Authorization: Bearer <jwt>`.

## Why server-side flips?

If the browser decided who won a flip, anyone who opened DevTools could
intercept the response and rewrite it. The server uses `crypto.randomBytes`
inside a database transaction so the result is fair, unguessable, and the
balance update can never be partial.

## Files

- `server.js` — all routes & middleware
- `db.js` — `pg` connection pool
- `schema.sql` — table definitions
- `init-db.js` — runs `schema.sql` once
- `.env.example` — required env vars

See the project root `README.md` for deployment instructions.
