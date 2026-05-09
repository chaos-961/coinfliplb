# Coinflip LB v1.3

Publish-ready virtual Gold coinflip game.

## Included fixes

- Visible branding is Coinflip LB.
- Signup/login no longer collect email.
- Public seed-check/verification UI and seed storage were removed.
- Coin results use server-side `crypto.randomInt(2)` at join time.
- Creator receives a live SSE notification when someone joins their open game.
- Missing `/api/presence/heartbeat` endpoint was added.
- Frontend GET cache was removed; duplicate GETs are only de-duped while in flight.
- Own-game cancel works even at 0 Gold.
- Creator result modal receives the updated balance.
- Leaderboard and personal stats now read stored user stats instead of scanning all games every request.

## Database changes

Running `npm run init-db` applies `backend/schema.sql`. It removes old email columns and old seed-check columns if they exist:

```sql
ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE games DROP COLUMN IF EXISTS server_seed;
ALTER TABLE games DROP COLUMN IF EXISTS server_seed_hash;
ALTER TABLE games DROP COLUMN IF EXISTS client_seed;
ALTER TABLE games DROP COLUMN IF EXISTS nonce;
ALTER TABLE games DROP COLUMN IF EXISTS pf_algo;
```

It also adds stored stats to `users`:

```sql
games_played, wins, losses, current_win_streak, max_win_streak
```

Keep `balance_transactions`; it is the audit trail for every Gold movement.

## Launch note

Run one backend replica unless you add Redis/pub-sub. SSE notifications, online count, cooldowns, and join fast-fail locks are in-memory. The database transaction still protects money/game correctness.
