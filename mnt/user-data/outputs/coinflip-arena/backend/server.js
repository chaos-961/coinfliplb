// =====================================================================
// server.js — CoinFlip Arena backend
// ---------------------------------------------------------------------
// This is the single source of truth for the game. The frontend is
// purely a UI: every important decision (who wins a flip, what your
// balance is, whether a username is taken) is made here and saved in
// PostgreSQL. The frontend never sees password hashes or computes
// game results.
//
// Endpoints:
//   POST /api/auth/signup       create account, returns token + user
//   POST /api/auth/login        log in, returns token + user
//   GET  /api/me                returns current user (requires auth)
//   POST /api/games             create an open game (requires auth)
//   GET  /api/games             list open games with optional filters
//   POST /api/games/:id/join    join a game, runs the flip atomically
//   GET  /api/games/:id         fetch one game's details
//   GET  /api/leaderboard       top users sorted by balance
//   GET  /health                liveness check (no auth)
// =====================================================================

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const crypto       = require('crypto');
const rateLimit    = require('express-rate-limit');

const db = require('./db');

// ---------------------------------------------------------------------
// Configuration (read from environment, with sensible fallbacks)
// ---------------------------------------------------------------------
const PORT             = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET       = process.env.JWT_SECRET || '';
const STARTING_BALANCE = parseFloat(process.env.STARTING_BALANCE || '100');
const FRONTEND_ORIGIN  = process.env.FRONTEND_ORIGIN || '';
const NODE_ENV         = process.env.NODE_ENV || 'development';

const MIN_PASSWORD_LENGTH = 6;
const MAX_USERNAME_LENGTH = 32;
const MIN_USERNAME_LENGTH = 3;
const MIN_WAGER           = 1;
const MAX_WAGER           = 10_000_000_000; // sanity cap; UI also caps to current balance
const TOKEN_EXPIRES_IN    = '7d';

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error(
    '[startup] JWT_SECRET is missing or too short. Set a long random ' +
    'string in your environment (>=32 chars recommended).'
  );
  // We refuse to boot in production without a real secret.
  if (NODE_ENV === 'production') process.exit(1);
}

// ---------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------
const app = express();

// Trust the first proxy hop so rate limiting sees the real client IP
// when running behind Railway's load balancer.
app.set('trust proxy', 1);

app.use(express.json({ limit: '32kb' }));

// CORS: allow only our known frontend origins. We always allow common
// localhost origins so you can develop the frontend locally.
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
  'http://localhost:5500',          // VS Code Live Server default
  'http://127.0.0.1:5500',
]);
if (FRONTEND_ORIGIN) allowedOrigins.add(FRONTEND_ORIGIN);

app.use(cors({
  origin(origin, cb) {
    // Allow same-origin/no-origin requests (curl, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ---------------------------------------------------------------------
// Rate limiting (auth endpoints are the main brute-force surface)
// ---------------------------------------------------------------------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 30,                  // 30 auth attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 2 req/s sustained
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down a bit.' },
});

app.use('/api/', generalLimiter);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRES_IN }
  );
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    balance: Number(row.balance),
    created_at: row.created_at,
  };
}

function publicGame(row) {
  return {
    id: row.id,
    creator_id: row.creator_id,
    creator_username: row.creator_username,
    creator_choice: row.creator_choice,
    joiner_id: row.joiner_id,
    joiner_username: row.joiner_username || null,
    wager: Number(row.wager),
    result: row.result,
    winner_id: row.winner_id,
    winner_username: row.winner_username || null,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

/**
 * Cryptographically secure 50/50 coin flip.
 * Math.random is NOT used so a flip cannot be predicted.
 */
function secureCoinFlip() {
  // Read one byte and check the lowest bit. crypto.randomInt would also
  // work; we use a single byte to keep it explicit.
  const byte = crypto.randomBytes(1)[0];
  return (byte & 1) === 0 ? 'heads' : 'tails';
}

function isValidUsername(u) {
  return typeof u === 'string'
      && u.length >= MIN_USERNAME_LENGTH
      && u.length <= MAX_USERNAME_LENGTH
      && /^[a-zA-Z0-9_.-]+$/.test(u);
}

// ---------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.uid, username: payload.username };
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// =====================================================================
// Routes
// =====================================================================

// Health check (used by Railway and by the frontend's status indicator).
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'coinflip-arena', time: new Date().toISOString() });
});

// ----- POST /api/auth/signup -----------------------------------------
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const username = (req.body?.username || '').trim();
    const password = req.body?.password || '';

    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters and use only letters, numbers, underscore, dot, or dash.`
      });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
      });
    }

    // Make uniqueness case-insensitive so "Alice" and "alice" can't both exist.
    const existing = await db.query(
      'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const insert = await db.query(
      `INSERT INTO users (username, password_hash, balance)
       VALUES ($1, $2, $3)
       RETURNING id, username, balance, created_at`,
      [username, password_hash, STARTING_BALANCE]
    );

    const user = insert.rows[0];
    const token = signToken(user);
    return res.status(201).json({ token, user: publicUser(user) });

  } catch (err) {
    console.error('[signup]', err);
    return res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});

// ----- POST /api/auth/login ------------------------------------------
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const username = (req.body?.username || '').trim();
    const password = req.body?.password || '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const result = await db.query(
      'SELECT id, username, password_hash, balance, created_at FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    const row = result.rows[0];

    // Use a constant-style flow to avoid leaking whether the username exists.
    const dummyHash = '$2b$12$abcdefghijklmnopqrstuv0123456789abcdefghijklmnopqrstuvw';
    const ok = await bcrypt.compare(password, row ? row.password_hash : dummyHash);

    if (!row || !ok) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = signToken(row);
    return res.json({ token, user: publicUser(row) });

  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ error: 'Could not log you in. Please try again.' });
  }
});

// ----- GET /api/me ---------------------------------------------------
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, balance, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Account no longer exists.' });
    }
    return res.json({ user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error('[me]', err);
    return res.status(500).json({ error: 'Could not load your profile.' });
  }
});

// ----- POST /api/games (create) --------------------------------------
app.post('/api/games', requireAuth, async (req, res) => {
  try {
    const choice = req.body?.choice;
    const wager  = Number(req.body?.wager);

    if (choice !== 'heads' && choice !== 'tails') {
      return res.status(400).json({ error: 'Choice must be "heads" or "tails".' });
    }
    if (!Number.isFinite(wager) || wager < MIN_WAGER || wager > MAX_WAGER) {
      return res.status(400).json({
        error: `Wager must be a number between ${MIN_WAGER} and ${MAX_WAGER}.`
      });
    }

    // We round to 2 decimals so the UI can't sneak in fractional cents.
    const safeWager = Math.round(wager * 100) / 100;

    // Check the latest balance directly from the DB; never trust the client.
    const me = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    if (me.rowCount === 0) {
      return res.status(404).json({ error: 'Account no longer exists.' });
    }
    if (Number(me.rows[0].balance) < safeWager) {
      return res.status(400).json({ error: 'You do not have enough balance for that wager.' });
    }

    const insert = await db.query(
      `INSERT INTO games (creator_id, creator_choice, wager, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING id, creator_id, creator_choice, wager, status, created_at`,
      [req.user.id, choice, safeWager]
    );

    // Hydrate creator_username for the response.
    const row = insert.rows[0];
    return res.status(201).json({
      game: publicGame({
        ...row,
        creator_username: req.user.username,
        joiner_id: null, joiner_username: null,
        result: null, winner_id: null, winner_username: null,
        completed_at: null,
      })
    });

  } catch (err) {
    console.error('[create game]', err);
    return res.status(500).json({ error: 'Could not create game. Please try again.' });
  }
});

// ----- GET /api/games (list with filters) ----------------------------
app.get('/api/games', requireAuth, async (req, res) => {
  try {
    const status    = (req.query.status || 'open').toString();
    const wager     = req.query.wager     !== undefined ? Number(req.query.wager)    : null;
    const minWager  = req.query.minWager  !== undefined ? Number(req.query.minWager) : null;
    const maxWager  = req.query.maxWager  !== undefined ? Number(req.query.maxWager) : null;

    if (!['open', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter.' });
    }

    const conditions = ['g.status = $1'];
    const params     = [status];
    let p = 2;

    if (wager !== null && Number.isFinite(wager)) {
      conditions.push(`g.wager = $${p++}`);
      params.push(wager);
    }
    if (minWager !== null && Number.isFinite(minWager)) {
      conditions.push(`g.wager >= $${p++}`);
      params.push(minWager);
    }
    if (maxWager !== null && Number.isFinite(maxWager)) {
      conditions.push(`g.wager <= $${p++}`);
      params.push(maxWager);
    }

    const sql = `
      SELECT g.id, g.creator_id, u.username AS creator_username,
             g.creator_choice, g.wager, g.status, g.created_at,
             g.joiner_id, g.result, g.winner_id, g.completed_at
      FROM games g
      JOIN users u ON u.id = g.creator_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY g.created_at DESC
      LIMIT 200
    `;
    const result = await db.query(sql, params);
    return res.json({ games: result.rows.map(publicGame) });

  } catch (err) {
    console.error('[list games]', err);
    return res.status(500).json({ error: 'Could not load games.' });
  }
});

// ----- GET /api/games/:id (single) -----------------------------------
app.get('/api/games/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid game id.' });
    }

    const result = await db.query(
      `SELECT g.*,
              uc.username AS creator_username,
              uj.username AS joiner_username,
              uw.username AS winner_username
         FROM games g
         JOIN users uc ON uc.id = g.creator_id
    LEFT JOIN users uj ON uj.id = g.joiner_id
    LEFT JOIN users uw ON uw.id = g.winner_id
        WHERE g.id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Game not found.' });
    }
    return res.json({ game: publicGame(result.rows[0]) });

  } catch (err) {
    console.error('[get game]', err);
    return res.status(500).json({ error: 'Could not load that game.' });
  }
});

// ----- POST /api/games/:id/join --------------------------------------
//
// This is the most security-sensitive endpoint. It must:
//   1. Lock the game row so two players can't join the same game.
//   2. Lock both player rows so balances can't be raced.
//   3. Re-check both balances inside the transaction.
//   4. Generate the flip result server-side with a CSPRNG.
//   5. Update both balances and mark the game completed atomically.
//
// We do everything inside a single transaction; if any step fails we
// roll back so no partial state is ever written.
// ---------------------------------------------------------------------
app.post('/api/games/:id/join', requireAuth, async (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({ error: 'Invalid game id.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1) Lock the game row (FOR UPDATE) so a second concurrent joiner
    //    blocks here until we are done. This is what prevents two
    //    players from both joining the same open game.
    const gameRes = await client.query(
      'SELECT * FROM games WHERE id = $1 FOR UPDATE',
      [gameId]
    );
    if (gameRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Game not found.' });
    }
    const game = gameRes.rows[0];

    if (game.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This game is no longer open.' });
    }
    if (game.creator_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot join your own game.' });
    }

    // 2) Lock both user rows. We acquire them in a deterministic order
    //    (smallest id first) so two simultaneous joins on different
    //    games involving the same user can never deadlock.
    const lowId  = Math.min(game.creator_id, req.user.id);
    const highId = Math.max(game.creator_id, req.user.id);
    const usersRes = await client.query(
      `SELECT id, username, balance
         FROM users
        WHERE id IN ($1, $2)
        ORDER BY id ASC
        FOR UPDATE`,
      [lowId, highId]
    );
    const usersById = Object.fromEntries(usersRes.rows.map(r => [r.id, r]));
    const creator = usersById[game.creator_id];
    const joiner  = usersById[req.user.id];

    if (!creator || !joiner) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'A player no longer exists.' });
    }

    const wager = Number(game.wager);
    if (Number(joiner.balance) < wager) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You do not have enough balance to join this game.' });
    }
    if (Number(creator.balance) < wager) {
      // Creator went broke between creating and now. Cancel the game.
      await client.query(
        `UPDATE games SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
        [game.id]
      );
      await client.query('COMMIT');
      return res.status(409).json({ error: 'The game creator no longer has enough balance. Game cancelled.' });
    }

    // 3) Server-side flip. The frontend NEVER decides this.
    const result = secureCoinFlip();
    const winnerId = (game.creator_choice === result) ? creator.id : joiner.id;
    const loserId  = (winnerId === creator.id) ? joiner.id : creator.id;

    // 4) Move the wager from loser to winner. Two updates so a stray
    //    race could never let the loser go negative.
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1',
      [wager, loserId]
    );
    await client.query(
      'UPDATE users SET balance = balance + $1 WHERE id = $2',
      [wager, winnerId]
    );

    // 5) Finalize the game.
    await client.query(
      `UPDATE games
          SET joiner_id = $1, result = $2, winner_id = $3,
              status = 'completed', completed_at = NOW()
        WHERE id = $4`,
      [joiner.id, result, winnerId, game.id]
    );

    await client.query('COMMIT');

    // Re-read the joined game with usernames so the client can render
    // the result without another round-trip.
    const finalRes = await db.query(
      `SELECT g.*,
              uc.username AS creator_username,
              uj.username AS joiner_username,
              uw.username AS winner_username
         FROM games g
         JOIN users uc ON uc.id = g.creator_id
    LEFT JOIN users uj ON uj.id = g.joiner_id
    LEFT JOIN users uw ON uw.id = g.winner_id
        WHERE g.id = $1`,
      [game.id]
    );

    // Also return the joiner's fresh user record so the UI can update.
    const userRes = await db.query(
      'SELECT id, username, balance, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    return res.json({
      game: publicGame(finalRes.rows[0]),
      user: publicUser(userRes.rows[0]),
      // Kept for compatibility with older frontend builds.
      balance: Number(userRes.rows[0].balance),
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[join game]', err);
    return res.status(500).json({ error: 'Could not join the game. Please try again.' });
  } finally {
    client.release();
  }
});

// ----- GET /api/me/games ---------------------------------------------
// Returns the current user's games (as creator OR joiner), most recent
// first. Used by the My Games tab and by the polling logic that detects
// when one of the user's open games has been joined and completed.
app.get('/api/me/games', requireAuth, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    if (status && !['open', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter.' });
    }

    const conditions = ['(g.creator_id = $1 OR g.joiner_id = $1)'];
    const params     = [req.user.id];
    if (status) {
      conditions.push(`g.status = $${params.length + 1}`);
      params.push(status);
    }

    const sql = `
      SELECT g.id, g.creator_id, g.creator_choice, g.wager, g.status,
             g.created_at, g.joiner_id, g.result, g.winner_id, g.completed_at,
             cu.username AS creator_username,
             ju.username AS joiner_username,
             wu.username AS winner_username
        FROM games g
        JOIN users cu ON cu.id = g.creator_id
        LEFT JOIN users ju ON ju.id = g.joiner_id
        LEFT JOIN users wu ON wu.id = g.winner_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(g.completed_at, g.created_at) DESC
       LIMIT ${limit}
    `;
    const result = await db.query(sql, params);
    return res.json({ games: result.rows.map(publicGame) });
  } catch (err) {
    console.error('[my games]', err);
    return res.status(500).json({ error: 'Could not load your games.' });
  }
});

// ----- GET /api/leaderboard ------------------------------------------
app.get('/api/leaderboard', requireAuth, async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT id, username, balance, created_at
         FROM users
        ORDER BY balance DESC, created_at ASC
        LIMIT 50`
    );
    return res.json({
      users: result.rows.map((r, i) => ({
        rank: i + 1,
        ...publicUser(r),
      })),
    });
  } catch (err) {
    console.error('[leaderboard]', err);
    return res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

// ---------------------------------------------------------------------
// 404 + error handler
// ---------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---------------------------------------------------------------------
// Start server (only when run directly; if this file is required by a
// test, the test will start the server itself or use supertest).
// ---------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[startup] CoinFlip Arena API listening on :${PORT} (${NODE_ENV})`);
    console.log(`[startup] STARTING_BALANCE = ${STARTING_BALANCE}`);
    console.log(`[startup] FRONTEND_ORIGIN  = ${FRONTEND_ORIGIN || '(none set — only localhost allowed)'}`);
  });
}

module.exports = app;