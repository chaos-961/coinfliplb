# Coinflip Gold (v1.1 — public release)

A clean, full-stack **gold** coinflip game. Players sign up, get 100 Gold, create heads/tails wagers, and watch a fair, server-decided coin flip animation. Pure-fun MVP — **no real money**, no crypto, no gambling integrations.

## What's new in v1.1 (public-release hardening)

- **Anti-farming.** Signup is now throttled per-IP via the new `signup_attempts` table (DB-backed, replica-safe): hard caps `SIGNUP_MAX_PER_IP_DAY=20` and `SIGNUP_MAX_ACCOUNTS_PER_IP_DAY=5`, plus a 4-second cooldown. IP and user-agent are stored as salted SHA-256 hashes — never the raw values.
- **Optional email field.** Schema-ready for future verification flows. Unique on `LOWER(email)`, NULL-friendly so existing users are unaffected.
- **Username uniqueness, case-insensitive.** New `users_username_lower_uniq` functional unique index makes "Hamoudi", "hamoudi", and "HAMOUDI" actually mutually exclusive at the database level. Race-safe — concurrent signups for the same name now return a clean 409 instead of crashing.
- **Balance ledger.** New `balance_transactions` table records every Gold movement (signup bonus, escrow debit, refund, payout, stale refund, admin adjustment). Balance updates and ledger writes happen in the same transaction via `applyBalanceDelta` / `applyBalanceDeltaCapped` helpers in `db.js` — no code path can move Gold without an audit row.
- **Provably-fair flip.** When a game is created, the server generates a 256-bit `server_seed`, commits its SHA-256 hash, and shows that hash to anyone viewing the game. On join, the result is `HMAC-SHA-256(server_seed, "<client_seed>:<game_id>")` — the first byte's lowest bit picks heads/tails. After completion, the seed is revealed and `POST /api/games/:id/verify` (or the in-app modal) lets anyone independently confirm.
- **JWT hardening.** `JWT_SECRET < 16` chars or missing `FRONTEND_ORIGIN` now **fail-hard in production** (the server refuses to boot). New `token_version` claim + `POST /api/auth/logout-all` invalidates every issued token.
- **Admin endpoint.** `GET /api/admin/suspicious` (gated by `ADMIN_API_TOKEN`, constant-time comparison) returns IP clusters, frequent rivals, "drained-then-quiet" new accounts, and high-win-rate streaks. Heuristics only — no actions taken.
- **0-balance UX bug fixed.** Cancel now works for users at 0 Gold (it's how they get their escrow back). Only create / join are gated on balance.
- **Locked-Gold pill.** Topbar now shows how much Gold is reserved in your open games so a 0-spendable player understands why creation is locked.
- **Misc.** `clientIp` uses `req.ip` consistently (correct behind Railway's proxy); production stack traces hidden; cancelled/completed games can never be re-flipped (re-checked status in every UPDATE); `signup_attempts` pruned every 6 hours; constant-time admin token compare.

> **Action required for existing v1.0 deployments:**
> 1. Run `npm run init-db` (or paste `backend/schema.sql` into Railway's Postgres console). It's fully idempotent.
> 2. Set `FRONTEND_ORIGIN` if you haven't already — production refuses to boot without it.
> 3. Set a strong `JWT_SECRET` (≥ 32 chars) — production refuses to boot without it.
> 4. Optional: set `ADMIN_API_TOKEN` to enable admin endpoints.

---

## Production release checklist

Before flipping coinfliplb.com to public, verify all of the following.

**Backend (Railway service variables):**
- [ ] `DATABASE_URL` references the Postgres plugin (use Railway's `${{Postgres.DATABASE_URL}}` syntax).
- [ ] `JWT_SECRET` ≥ 32 random chars (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
- [ ] `FRONTEND_ORIGIN` is `https://coinfliplb.com,https://www.coinfliplb.com` (exactly the prod origins, no trailing slash).
- [ ] `NODE_ENV=production`.
- [ ] `IP_HASH_SALT` is set to a random ≥ 32-char string (different from `JWT_SECRET`). If unset, JWT_SECRET is reused — fine but not ideal.
- [ ] `ADMIN_API_TOKEN` is set if you want `/api/admin/*` to work; leave unset to keep them disabled.
- [ ] `STARTING_BALANCE` matches `config.js`'s `STARTING_BALANCE` (default 100).
- [ ] Confirm only ONE Railway replica is running. Multi-replica is unsafe until rate-limit / online-user state moves to Redis (see scaling notes below).

**Frontend (`config.js`):**
- [ ] `API_BASE_URL` points to the production Railway URL (no trailing slash).
- [ ] `APP_VERSION` reflects the deploy.

**Database:**
- [ ] `npm run init-db` ran cleanly against the production database. The output should show all four counts (users / games / ledger_rows / signup_attempts).
- [ ] Optional: drop the legacy case-sensitive `users_username_key` constraint after confirming `users_username_lower_uniq` exists. See the bottom of `schema.sql` for the exact `ALTER` command.

**End-to-end smoke test (run from your phone on cellular, NOT your desktop's WiFi):**
- [ ] Sign up with a new username. Confirm starting balance = 100.
- [ ] Sign out, sign back in.
- [ ] Try signing up with the SAME username but different casing — should be rejected ("That username is already taken.").
- [ ] Create a game — confirm balance debits immediately and a Locked-Gold pill appears in the topbar.
- [ ] On a second device or browser, sign up another account, join the game — confirm flip animation runs and one balance moves.
- [ ] Open the Provably Fair modal (shield icon in the topbar), paste the game ID, click Verify — confirm "Verified" with green border.
- [ ] On the loser, confirm they can still browse and CAN cancel any of their other open games (this was bug #6 from the release plan).
- [ ] Try creating ~6 accounts back-to-back from the same IP — the 6th must hit the throttle with a clear message.

**Operational:**
- [ ] `/health` returns 200 with `{"ok":true,"version":"1.1"}`.
- [ ] CORS rejects unknown origins (try a curl from a non-allowed origin and confirm the request is blocked).
- [ ] Railway logs show no `[unhandled]` errors after the first hour of normal traffic.
- [ ] Railway memory + CPU usage look stable. The free / starter plan suffices for an MVP — the README's note about Railway costs scaling with usage is real; budget alerts are a good idea.

**Remaining risks (cannot be fully solved in this release):**
- Email verification is wired schema-side only. A determined attacker with rotating residential IPs can still grind accounts past the throttle. Adding actual verification + a captcha on signup is the next step.
- All in-memory rate-limit and cooldown state is per-replica. **Keep Railway at 1 replica.** Scaling out requires a Redis-backed implementation.
- No password reset flow yet. `POST /api/auth/logout-all` exists; a reset-by-email flow can be built on top of the new email field once delivery is wired.
- Admin endpoint returns JSON only — there's no admin UI. Use `curl` for now.

---

## 1. What this project is

Coinflip Gold is a tiny social game:

1. You make an account → you start with 100 Gold starting balance.
2. You create a game by picking heads or tails and a wager amount.
3. Another player browses the open games and joins yours.
4. The **server** flips the coin (cryptographically random — not the browser).
5. The winner takes the wager from the loser. Both balances update atomically.
6. Players climb (or tumble down) the leaderboard.

The whole thing is designed to be deployable for free with a static frontend on **GitHub Pages** and a Node/Postgres backend on **Railway**.

## 2. Tech stack

- **Frontend:** Plain HTML, CSS, and vanilla JavaScript. No frameworks, no build step. Drop-in deployable to GitHub Pages.
- **Backend:** Node.js + Express. JWT for auth, bcryptjs for password hashing, `express-rate-limit` on auth endpoints.
- **Database:** PostgreSQL (Railway plugin in production; works locally too).
- **Hosting:** GitHub Pages (frontend) + Railway (backend + database).

> **Note on bcryptjs vs bcrypt:** This project uses `bcryptjs` (pure-JS) instead of the native `bcrypt` package. The API is identical, but `bcryptjs` has no native build step, so it deploys cleanly to any Node host without compiler dependencies.

## 3. Folder structure

```
coinflip-arena/
├── README.md                  ← you are here
├── .gitignore
├── frontend/                  ← deploy this folder to GitHub Pages
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── config.js              ← edit API_BASE_URL after backend deploy
└── backend/                   ← deploy this folder to Railway
    ├── server.js              ← Express app + all routes
    ├── db.js                  ← Postgres pool
    ├── schema.sql             ← tables + indexes
    ├── init-db.js             ← runs schema.sql via `npm run init-db`
    ├── package.json
    ├── .env.example           ← copy to .env locally
    └── README.md              ← backend-only quickstart
```

## 4. How the frontend and backend work together

The frontend is a single-page app made of three files: `index.html`, `styles.css`, and `app.js`. All views (landing, signup, login, dashboard, flip animation, results, leaderboard) live in one HTML file and are toggled with CSS classes.

`config.js` holds non-secret display values like `API_BASE_URL`. It's loaded *before* `app.js` and exposed on `window.CONFIG`.

`app.js` talks to the backend over JSON+REST. After login, it stores the JWT in `localStorage` and sends it as `Authorization: Bearer <token>` on every authenticated request. The backend validates the token, performs any DB work, and returns JSON.

The backend has no UI of its own — it only serves JSON. The frontend renders everything.

## 5. Why the coin flip must happen on the backend

If the browser flipped the coin, anyone with DevTools could rewrite the JavaScript and decide their own outcome. The frontend would become "trust me." So:

- **Coin result** is generated server-side using `crypto.randomBytes` (a CSPRNG), not `Math.random`.
- **Balances** live in PostgreSQL. The frontend never sends a balance — it only displays what the server returns.
- **Joining a game** runs in a SQL transaction with `SELECT … FOR UPDATE` row locks so two people can't double-join, and balances can't go negative due to a race condition.
- **Auth** uses bcryptjs hashes (cost factor 12) and signed JWTs.

The frontend is therefore "dumb" — it shows what the server says, animates a coin for 5 seconds, and reveals the server's result.

## 6. How to create a Railway project

1. Go to <https://railway.app> and sign in (GitHub login is easiest).
2. Click **New Project** → **Empty Project** (or **Deploy from GitHub repo** if you've already pushed your code).
3. Name it something like `coinflip-arena`.

## 7. How to add PostgreSQL on Railway

1. Inside your Railway project, click **+ New** → **Database** → **Add PostgreSQL**.
2. Wait ~30 seconds for it to provision.
3. Click the new Postgres service. Railway exposes a `DATABASE_URL` connection string — you'll reference it from your backend service in step 10.

## 8. How to deploy the backend to Railway

The cleanest path is GitHub-based:

1. Push this repo to GitHub (see step 13 — same git repo, just push the whole project, not only `/frontend`).
2. In your Railway project, click **+ New** → **GitHub Repo** → pick your repo.
3. Railway will create a service. Open its **Settings** tab.
4. Under **Service** → **Root Directory**, set: `backend`
5. Under **Build**, Railway auto-detects Node and runs `npm install`.
6. Under **Deploy** → **Start Command**, set: `npm start` (this runs `node server.js`).
7. Under **Networking**, click **Generate Domain**. You'll get a URL like `https://coinflip-arena-production.up.railway.app`. Save this — you'll need it in step 12.

## 9. How to run schema.sql on Railway PostgreSQL

You have two options.

**Option A — One-shot init script (easiest):**

After your backend service is deployed and `DATABASE_URL` is wired up (step 10), open the backend service's **Deploy** logs, then go to its shell (Railway provides a web terminal under the service's `…` menu → **Shell**) and run:

```bash
npm run init-db
```

This executes `backend/init-db.js`, which reads `schema.sql` and runs every statement against your live database.

**Option B — Run SQL directly in Railway's Postgres console:**

1. Click the Postgres service → **Data** tab → **Query**.
2. Paste the contents of `backend/schema.sql` into the editor.
3. Click **Run**.

Either option is fine. The schema is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running it is safe.

## 10. How to set Railway environment variables

Click the **backend** service (not the Postgres service) → **Variables** tab. Add these:

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Use Railway's variable reference syntax — click "Add Reference" and pick the Postgres service's DATABASE_URL. This auto-updates if Postgres rotates credentials. |
| `JWT_SECRET` | a long random string | Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Must be at least 16 characters. |
| `STARTING_BALANCE` | `100` | Must match `frontend/config.js` `STARTING_BALANCE` for accurate display. |
| `FRONTEND_ORIGIN` | your GitHub Pages URL | E.g. `https://yourusername.github.io/coinflip-arena`. Set this *after* step 14. |
| `PORT` | (leave unset) | Railway injects its own `PORT`. The server falls back to 3000 locally. |

After saving, Railway redeploys automatically.

## 11. How to get the Railway backend URL

In your backend service → **Settings** → **Networking** → the **Public Networking** section shows your generated domain, e.g.:

```
https://coinflip-arena-production.up.railway.app
```

Open `https://YOUR-URL/health` in a browser. You should see `{"status":"ok"}`. If you do, the backend is live.

## 12. How to put the backend URL into frontend/config.js

Open `frontend/config.js` and change:

```js
API_BASE_URL: "http://localhost:3000",
```

to your Railway URL (no trailing slash):

```js
API_BASE_URL: "https://coinflip-arena-production.up.railway.app",
```

Commit and push. GitHub Pages will redeploy within ~1 minute.

## 13. How to push the frontend folder to GitHub

If you haven't already, push the entire repo:

```bash
cd coinflip-arena
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/coinflip-arena.git
git push -u origin main
```

You're pushing the whole project — Railway uses the `backend/` folder, GitHub Pages uses `frontend/`.

## 14. How to enable GitHub Pages for the static frontend

GitHub Pages can serve from a subfolder of your repo:

1. Go to your repo on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Set **Branch** to `main` and the folder to `/frontend` (then **Save**).
4. Wait ~1 minute. GitHub will give you a URL like `https://yourusername.github.io/coinflip-arena/`.
5. Visit it. You should see the Coinflip Gold landing page.

## 15. How to set FRONTEND_ORIGIN in Railway

Now go back to Railway → backend service → **Variables**, and set:

```
FRONTEND_ORIGIN = https://yourusername.github.io/coinflip-arena
```

(No trailing slash. Use the exact URL GitHub gave you in step 14.)

The backend uses this for CORS — only requests from this origin are accepted in production. Save the variable; Railway redeploys.

## 16. How to test the full flow

1. Open your GitHub Pages URL.
2. Click **Sign Up**, create user `alice` with any password (≥6 chars).
3. Open a private/incognito window. Sign up `bob`.
4. As alice → click **Create Game**, choose **Heads**, wager **10**, click **Create**.
5. Switch to bob's window → refresh the open games list → you should see alice's game. Click **Join**.
6. Watch the 5-second coin flip in bob's window. Result panel reveals the winner and updated balance.
7. Switch back to alice → refresh → her balance has changed too.
8. Open the **Leaderboard** card → both users appear, sorted by balance.

## 17. Common errors and fixes

**"CORS error" / "blocked by CORS policy" in browser console**
Your `FRONTEND_ORIGIN` env var on Railway doesn't match the URL the browser is on. Make sure it's the exact GitHub Pages URL with no trailing slash. Then redeploy.

**"DATABASE_URL is not defined" or backend crashes on boot**
You forgot to add `DATABASE_URL` as a Railway variable, or it's not referencing the Postgres service. Re-do step 10.

**Frontend loads but every API call fails / "Network error"**
You probably forgot step 12 — `API_BASE_URL` in `frontend/config.js` is still `http://localhost:3000`. Update it, push, wait for GitHub Pages to redeploy.

**Backend was idle and now responds slowly on first request**
Railway's free tier may pause idle services. The first request "wakes" the container and can take 5–15 seconds. Subsequent requests are fast. Upgrade to a paid plan or add a tiny external uptime pinger (e.g. UptimeRobot) if this matters.

**"relation 'users' does not exist"**
You skipped step 9. Run `npm run init-db` in the Railway shell, or paste `schema.sql` into the Postgres Query tab.

**GitHub Pages shows 404 / blank page**
GitHub Pages can take 1–2 minutes to publish after the first push. Also check **Settings → Pages** is set to `main` + `/frontend`, not `/` (root) or `/docs`. Hard refresh with Ctrl+Shift+R.

**`/health` returns 404 or HTML**
You hit GitHub Pages instead of Railway. Use your Railway domain, not your Pages domain.

**Login works but `/api/me` returns 401 right after**
Almost always a CORS or `Authorization` header issue. Open DevTools → Network → check the request is going to the right `API_BASE_URL` and that `Authorization: Bearer …` is being sent.

## 18. How to change settings

**Starting balance**
This must be changed in **two places**:

1. Backend (authoritative): Railway → backend → Variables → set `STARTING_BALANCE` to your new value (e.g. `500`).
2. Frontend (display only): edit `frontend/config.js` → `STARTING_BALANCE: 500`.

The backend value is what's actually given to new users. The frontend value is just for the "you start with $X" copy.

**Flip animation duration**
`frontend/config.js` → `DEFAULT_FLIP_DURATION_MS: 5000` (5 seconds). Lower = snappier, higher = more suspense.

**Flip animation visual speed**
`frontend/config.js` → `COIN_FLIP_SPEED_MS: 120` — controls how fast the coin's faces alternate during the spin (one half-rotation per tick). Lower = blur-fast, higher = chunky.

**Wager limits**
`frontend/config.js` → `MIN_WAGER` and `MAX_WAGER`. The backend currently only enforces "wager > 0 and ≤ your balance" — these client-side limits are for UX. If you want the backend to enforce a max too, edit the validation in `backend/server.js` inside the `POST /api/games` handler.

**App name**
`frontend/config.js` → `APP_NAME: "Coinflip Gold"`. Shown in the topbar and landing hero.

**Polling interval**
`frontend/config.js` → `POLLING_INTERVAL_MS: 3000` — how often the dashboard refreshes the open games list. Polling pauses when the tab isn't visible.

## 19. Security notes

- **Passwords:** hashed with bcryptjs at cost factor 12. Plaintext is never stored or logged.
- **Tokens:** signed JWTs with a 7-day expiry. The server refuses to start in production unless `JWT_SECRET` is set and ≥16 characters.
- **SQL:** every query is parameterized — no string concatenation, no SQL injection surface.
- **Race conditions:** the `POST /api/games/:id/join` handler runs inside a transaction. It locks the game row and both user rows in a deterministic order (`ORDER BY id ASC FOR UPDATE`) to prevent deadlocks and double-joins.
- **Coin flip:** uses `crypto.randomBytes`, not `Math.random`. The result is decided server-side and only revealed to the client after the animation.
- **CORS:** locked to `FRONTEND_ORIGIN` in production. Localhost dev origins are allowed automatically for convenience.
- **Rate limiting:** auth endpoints are limited to 30 requests / 15 minutes per IP. General API is 120/min.
- **Token storage:** `localStorage` is used for the JWT — fine for an MVP, but vulnerable to XSS. For production, consider httpOnly cookies + CSRF tokens.
- **No real money:** this is a play-money toy. Do not modify it to handle real currency without a serious security review and the appropriate licenses in your jurisdiction.

## 20. Future improvements

- WebSockets for instant game updates instead of polling.
- Email-based password reset.
- Per-user game history page.
- Friend / private-game system.
- Daily login bonus to bring broke players back.
- Optional avatar uploads.
- Move JWT from `localStorage` to httpOnly cookies + CSRF.
- More thorough integration test suite + CI.
- Internationalization (currently en-US currency formatting only).
- Anti-abuse: detect collusion between two accounts trading wins back and forth.

---

## Local development quickstart

```bash
# Backend
cd backend
cp .env.example .env
# edit .env: set DATABASE_URL to a local Postgres, JWT_SECRET to anything ≥16 chars
npm install
npm run init-db   # creates tables
npm run dev       # http://localhost:3000

# Frontend (in a second terminal)
cd frontend
# config.js already points to http://localhost:3000 by default
python3 -m http.server 5500
# open http://localhost:5500
```

Have fun, and don't bet your house on a coin flip.
