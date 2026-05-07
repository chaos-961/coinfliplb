// =====================================================================
// server.js — Coinflip Gold backend (v1.0)
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
//   POST /api/auth/logout       client-side token wipe (best-effort)
//   GET  /api/me                returns current user (requires auth)
//   POST /api/games             create an open game (requires auth)
//   GET  /api/games             list open games with optional filters
//   POST /api/games/:id/join    join a game, runs the flip atomically
//   POST /api/games/:id/cancel  cancel an open game (creator only)
//   GET  /api/games/:id         fetch one game's details
//   GET  /api/me/games          list current user's games
//   GET  /api/leaderboard       top users sorted by balance (public)
//   GET  /api/me/stats          current player computed stats
//   POST /api/presence/heartbeat online player heartbeat
//   GET  /api/config            client-side runtime config
//   GET  /health                liveness check (pings DB)
// =====================================================================

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const crypto       = require('crypto');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');

const db = require('./db');

// ---------------------------------------------------------------------
// Helpers (declared early so config can use them)
// ---------------------------------------------------------------------
function parseWagerInteger(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return NaN;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return NaN;
  return n;
}

function parsePage(value, fallback = 1) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseLimit(value, fallback = 20, max = 50) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// ---------------------------------------------------------------------
// Configuration (read from environment, with sensible fallbacks)
// ---------------------------------------------------------------------
const PORT             = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET       = process.env.JWT_SECRET || '';
const STARTING_BALANCE = parseWagerInteger(process.env.STARTING_BALANCE || '100');
const FRONTEND_ORIGIN  = process.env.FRONTEND_ORIGIN || '';
const NODE_ENV         = process.env.NODE_ENV || 'development';
const TRUST_PROXY      = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1;

// Auto-cancel open games older than this many hours (default 48h, 0 = disabled).
const OPEN_GAME_TTL_HOURS = parseInt(process.env.OPEN_GAME_TTL_HOURS || '48', 10);

// Lightweight abuse-control tuning. All are in-memory on purpose: no DB/schema changes.
const MAX_CONTENT_LENGTH_BYTES = 32 * 1024;
const MAX_IN_FLIGHT_PER_IP     = parseInt(process.env.MAX_IN_FLIGHT_PER_IP || '25', 10);
const CREATE_COOLDOWN_MS       = parseInt(process.env.CREATE_COOLDOWN_MS || '2500', 10);
const JOIN_COOLDOWN_MS         = parseInt(process.env.JOIN_COOLDOWN_MS || '1800', 10);
const CANCEL_COOLDOWN_MS       = parseInt(process.env.CANCEL_COOLDOWN_MS || '1600', 10);
const GAMES_CACHE_TTL_MS       = parseInt(process.env.GAMES_CACHE_TTL_MS || '1500', 10);
const LEADERBOARD_CACHE_TTL_MS = parseInt(process.env.LEADERBOARD_CACHE_TTL_MS || '5000', 10);
const MAX_CACHE_ENTRIES        = 100;

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 200;             // bcrypt DoS guard
const MAX_USERNAME_LENGTH = 32;
const MIN_USERNAME_LENGTH = 3;
const MIN_WAGER           = 1;
const MAX_WAGER           = 1_000_000;        // tightened from 10B to 1M
const MAX_BALANCE         = 1_000_000_000;    // hard cap so leaderboard can't run away
const MAX_OPEN_GAMES_PER_USER = 5;             // a single user can hold at most this many open games at once
const TOKEN_EXPIRES_IN    = '7d';
const BCRYPT_COST         = 12;
const REQUIRE_STRONG_PASSWORD = String(process.env.REQUIRE_STRONG_PASSWORD || '').toLowerCase() === 'true';

if (!Number.isSafeInteger(STARTING_BALANCE) || STARTING_BALANCE < 0) {
  console.error('[startup] STARTING_BALANCE must be a whole number >= 0.');
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error(
    '[startup] JWT_SECRET is missing or too short. Set a long random ' +
    'string in your environment (>=32 chars recommended).'
  );
  // We refuse to boot in production without a real secret.
  if (NODE_ENV === 'production') process.exit(1);
}

// ---------------------------------------------------------------------
// Real bcrypt dummy hash, generated once at startup. Used to keep
// login response times constant whether or not the username exists.
// (The previous hard-coded literal was not a valid bcrypt hash and
//  caused bcrypt.compare to throw, defeating the timing-safety goal.)
// ---------------------------------------------------------------------
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

// ---------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

// Trust proxy hops for correct client IPs behind Railway's load balancer.
app.set('trust proxy', TRUST_PROXY);

// ---------------------------------------------------------------------
// In-memory protection primitives (single-process, DB-free).
// ---------------------------------------------------------------------
const inFlightByIp = new Map();
const cooldowns = new Map();
const joinLocks = new Set();
const responseCache = new Map();
const onlineUsers = new Map();
const ONLINE_WINDOW_MS = parseInt(process.env.ONLINE_WINDOW_MS || '90000', 10);

function clientIp(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
}

function cacheKey(req, scope) {
  return `${scope}:${req.originalUrl}`;
}

function getCachedJson(key) {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedJson(key, value, ttlMs) {
  if (!ttlMs || ttlMs <= 0) return;
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const first = responseCache.keys().next().value;
    if (first) responseCache.delete(first);
  }
  responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clearResponseCache() {
  responseCache.clear();
}
function pruneOnlineUsers(now = Date.now()) {
  for (const [userId, seenAt] of onlineUsers.entries()) {
    if (now - seenAt > ONLINE_WINDOW_MS) onlineUsers.delete(userId);
  }
}

function touchOnlineUser(userId) {
  if (!userId) return 0;
  const now = Date.now();
  onlineUsers.set(Number(userId), now);
  pruneOnlineUsers(now);
  return onlineUsers.size;
}


function requireCooldown(label, ms) {
  return (req, res, next) => {
    if (!ms || ms <= 0) return next();
    const key = `${label}:${req.user?.id || clientIp(req)}`;
    const now = Date.now();
    const until = cooldowns.get(key) || 0;
    if (until > now) {
      const retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Slow down. Try again in ${retryAfter}s.` });
    }
    cooldowns.set(key, now + ms);
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, until] of cooldowns) {
    if (until <= now) cooldowns.delete(key);
  }
  for (const [key, hit] of responseCache) {
    if (hit.expiresAt <= now) responseCache.delete(key);
  }
}, 60_000).unref?.();

// Security headers via helmet. CSP is left off because the frontend
// is served from a separate origin (CDN/static host) and the API is
// JSON-only — there's no HTML for a CSP to apply to.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // The API is on a different subdomain than the frontend; same-site
  // resource policy would block it. CORS is the access gate.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Reject oversized requests before body parsing work starts.
app.use((req, res, next) => {
  const len = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(len) && len > MAX_CONTENT_LENGTH_BYTES) {
    return res.status(413).json({ error: 'Request is too large.' });
  }
  next();
});

// Cap concurrent API requests per IP to reduce cheap flood pressure.
app.use('/api/', (req, res, next) => {
  const ip = clientIp(req);
  const active = inFlightByIp.get(ip) || 0;
  if (active >= MAX_IN_FLIGHT_PER_IP) {
    return res.status(429).json({ error: 'Too many concurrent requests. Slow down.' });
  }
  inFlightByIp.set(ip, active + 1);
  res.on('finish', () => {
    const current = inFlightByIp.get(ip) || 1;
    if (current <= 1) inFlightByIp.delete(ip);
    else inFlightByIp.set(ip, current - 1);
  });
  next();
});

app.use(express.json({ limit: '32kb', strict: true }));

// API responses should not be cached by browsers or shared proxies.
app.use('/api/', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
});

// JSON-only write API. This blocks accidental form posts and some CSRF-style probes.
app.use('/api/', (req, res, next) => {
  const hasContentType = Boolean(req.headers['content-type']);
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && hasContentType && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json.' });
  }
  next();
});

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
if (FRONTEND_ORIGIN) {
  // Allow comma-separated list, e.g. "https://coinfliplb.com,https://www.coinfliplb.com"
  for (const o of FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)) {
    allowedOrigins.add(o);
  }
}

app.use(cors({
  origin(origin, cb) {
    // No-Origin requests (curl, server-to-server, same-origin) — allow,
    // but they cannot read responses in browsers anyway.
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------
// Per-IP auth limiter (existing behavior).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

// Per-username login limiter to defeat distributed brute-force.
const loginUsernameLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                  // 10 attempts per username per 15 min, across all IPs
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `login:${(req.body?.username || '').toLowerCase().trim()}`,
  message: { error: 'Too many attempts for this account. Please try again in a few minutes.' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 2 req/s sustained
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down a bit.' },
});

// Per-IP create-game limiter to prevent spam game creation.
const createGameLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                  // 20 game creations per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are creating games too quickly. Slow down.' },
});

const gameActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 45,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many game actions. Slow down and try again.' },
});

app.use('/api/', generalLimiter);

// ---------------------------------------------------------------------
// Lightweight request logger (no external dep). Skips /health.
// ---------------------------------------------------------------------
app.use((req, _res, next) => {
  if (req.path !== '/health' && NODE_ENV !== 'test') {
    const reqId = crypto.randomBytes(4).toString('hex');
    req._reqId = reqId;
    console.log(`[${reqId}] ${req.method} ${req.path}`);
  }
  next();
});

// ---------------------------------------------------------------------
// More helpers
// ---------------------------------------------------------------------
function signToken(user) {
  return jwt.sign(
    { uid: user.id },                      // username intentionally omitted; rehydrate from DB
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRES_IN }
  );
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    balance: Math.floor(Number(row.balance)),
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
    wager: Math.floor(Number(row.wager)),
    result: row.result,
    winner_id: row.winner_id,
    winner_username: row.winner_username || null,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function publicStats(row) {
  const wins = Number(row.wins || 0);
  const losses = Number(row.losses || 0);
  const gamesPlayed = Number(row.games_played || wins + losses || 0);
  return {
    games_played: gamesPlayed,
    wins,
    losses,
    win_rate: gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 1000) / 10 : 0,
    current_win_streak: Number(row.current_win_streak || 0),
    max_win_streak: Number(row.max_win_streak || 0),
  };
}

async function getPlayerStats(userId) {
  const userRes = await db.query(
    'SELECT id, username, balance, created_at FROM users WHERE id = $1',
    [userId]
  );
  if (userRes.rowCount === 0) return null;

  const aggregateRes = await db.query(
    `SELECT
        COUNT(*)::int AS games_played,
        COUNT(*) FILTER (WHERE winner_id = $1)::int AS wins,
        COUNT(*) FILTER (WHERE winner_id <> $1)::int AS losses
       FROM games
      WHERE status = 'completed' AND (creator_id = $1 OR joiner_id = $1)`,
    [userId]
  );

  const historyRes = await db.query(
    `SELECT winner_id
       FROM games
      WHERE status = 'completed' AND (creator_id = $1 OR joiner_id = $1)
      ORDER BY completed_at ASC, id ASC`,
    [userId]
  );

  let current = 0;
  let max = 0;
  for (const row of historyRes.rows) {
    if (Number(row.winner_id) === Number(userId)) {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }

  const stats = {
    ...aggregateRes.rows[0],
    current_win_streak: current,
    max_win_streak: max,
  };

  return { user: publicUser(userRes.rows[0]), stats: publicStats(stats) };
}

/**
 * Cryptographically secure 50/50 coin flip.
 * 256 is divisible by 2 so reading the lowest bit of one random byte
 * has zero modulo bias. Math.random is NOT used because its outputs
 * are predictable.
 */
function secureCoinFlip() {
  const byte = crypto.randomBytes(1)[0];
  return (byte & 1) === 0 ? 'heads' : 'tails';
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function isValidUsername(u) {
  return typeof u === 'string'
      && u.length >= MIN_USERNAME_LENGTH
      && u.length <= MAX_USERNAME_LENGTH
      && /^[a-zA-Z0-9_.-]+$/.test(u);
}

function isStrongEnoughPassword(password) {
  if (!REQUIRE_STRONG_PASSWORD) return true;
  return /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
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
    if (token.length > 2048) return res.status(401).json({ error: 'Invalid session token.' });
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const uid = Number(payload.uid);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      return res.status(401).json({ error: 'Invalid session token.' });
    }
    req.user = { id: uid };
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// =====================================================================
// Routes
// =====================================================================

// Health check that actually pings the DB. Returns 503 on DB failure.
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, service: 'coinflip-arena', time: new Date().toISOString() });
  } catch (err) {
    console.error('[health] DB ping failed:', err.message);
    res.status(503).json({ ok: false, error: 'Database unreachable.' });
  }
});

// Public client-side runtime config so the frontend can ship without
// a redeploy when constants change.
app.get('/api/config', (_req, res) => {
  res.json({
    minWager: MIN_WAGER,
    maxWager: MAX_WAGER,
    maxBalance: MAX_BALANCE,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    startingBalance: STARTING_BALANCE,
    maxOpenGamesPerUser: MAX_OPEN_GAMES_PER_USER,
    openGameTtlHours: OPEN_GAME_TTL_HOURS,
    requireStrongPassword: REQUIRE_STRONG_PASSWORD,
  });
});

// ----- POST /api/auth/signup -----------------------------------------
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password || '';

    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters and use only letters, numbers, underscore, dot, or dash.`
      });
    }
    if (typeof password !== 'string' ||
        password.length < MIN_PASSWORD_LENGTH ||
        password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`
      });
    }
    if (!isStrongEnoughPassword(password)) {
      return res.status(400).json({
        error: 'Password must include lowercase, uppercase, and a number.'
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

    const password_hash = await bcrypt.hash(password, BCRYPT_COST);

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
app.post('/api/auth/login', authLimiter, loginUsernameLimiter, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password || '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Password is too long.' });
    }

    const result = await db.query(
      'SELECT id, username, password_hash, balance, created_at FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    const row = result.rows[0];

    // Use a real bcrypt dummy hash so timing is constant whether the
    // username exists or not (and bcrypt.compare doesn't throw).
    const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);

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

// ----- POST /api/auth/logout -----------------------------------------
// Stateless JWT can't be revoked without a blocklist; we return ok and
// the client clears its token.
app.post('/api/auth/logout', (_req, res) => {
  res.json({ ok: true });
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

app.get('/api/me/stats', requireAuth, async (req, res) => {
  try {
    const payload = await getPlayerStats(req.user.id);
    if (!payload) return res.status(404).json({ error: 'Account no longer exists.' });
    return res.json(payload);
  } catch (err) {
    console.error('[me stats]', err);
    return res.status(500).json({ error: 'Could not load your stats.' });
  }
});

app.post('/api/presence/heartbeat', requireAuth, (req, res) => {
  const online = touchOnlineUser(req.user.id);
  res.json({ online });
});

// ----- POST /api/games (create) --------------------------------------
// Creates an open game and reserves the creator's wager immediately.
// This prevents a user with $60 from creating multiple $50 games.
app.post('/api/games', requireAuth, createGameLimiter, requireCooldown('create-game', CREATE_COOLDOWN_MS), async (req, res) => {
  const choice = req.body?.choice;
  const wager  = parseWagerInteger(req.body?.wager);

  if (choice !== 'heads' && choice !== 'tails') {
    return res.status(400).json({ error: 'Choice must be "heads" or "tails".' });
  }
  if (!Number.isSafeInteger(wager) || wager < MIN_WAGER || wager > MAX_WAGER) {
    return res.status(400).json({
      error: `Wager must be a whole number between ${MIN_WAGER} and ${MAX_WAGER}.`
    });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const me = await client.query(
      'SELECT id, username, balance, created_at FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (me.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account no longer exists.' });
    }
    if (Number(me.rows[0].balance) < wager) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You do not have enough gold for that wager.' });
    }

    // Hard cap on concurrent open games per user.
    const openCountRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM games WHERE creator_id = $1 AND status = 'open'`,
      [req.user.id]
    );
    if (Number(openCountRes.rows[0]?.c || 0) >= MAX_OPEN_GAMES_PER_USER) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `You already have ${MAX_OPEN_GAMES_PER_USER} open games. Cancel or finish one first.`
      });
    }

    const updatedUser = await client.query(
      `UPDATE users
          SET balance = balance - $1
        WHERE id = $2 AND balance >= $1
        RETURNING id, username, balance, created_at`,
      [wager, req.user.id]
    );
    if (updatedUser.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Your gold balance changed. Please try again.' });
    }

    const insert = await client.query(
      `INSERT INTO games (creator_id, creator_choice, wager, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING id, creator_id, creator_choice, wager, status, created_at`,
      [req.user.id, choice, wager]
    );

    await client.query('COMMIT');
    clearResponseCache();

    const row = insert.rows[0];
    return res.status(201).json({
      game: publicGame({
        ...row,
        creator_username: me.rows[0].username,
        joiner_id: null, joiner_username: null,
        result: null, winner_id: null, winner_username: null,
        completed_at: null,
      }),
      user: publicUser(updatedUser.rows[0]),
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[create game]', err);
    return res.status(500).json({ error: 'Could not create game. Please try again.' });
  } finally {
    client.release();
  }
});

// ----- GET /api/games (list with filters) ----------------------------
app.get('/api/games', requireAuth, async (req, res) => {
  try {
    const status    = (req.query.status || 'open').toString();
    const wager     = req.query.wager     !== undefined ? parseWagerInteger(req.query.wager)    : null;
    const minWager  = req.query.minWager  !== undefined ? parseWagerInteger(req.query.minWager) : null;
    const maxWager  = req.query.maxWager  !== undefined ? parseWagerInteger(req.query.maxWager) : null;
    const page      = parsePage(req.query.page, 1);
    const limit     = parseLimit(req.query.limit, 20, 50);
    const offset    = (page - 1) * limit;

    if (!['open', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter.' });
    }

    const conditions = ['g.status = $1'];
    const params     = [status];
    let p = 2;

    if (wager !== null && Number.isSafeInteger(wager)) {
      conditions.push(`g.wager = $${p++}`);
      params.push(wager);
    }
    if (minWager !== null && Number.isSafeInteger(minWager)) {
      conditions.push(`g.wager >= $${p++}`);
      params.push(minWager);
    }
    if (maxWager !== null && Number.isSafeInteger(maxWager)) {
      conditions.push(`g.wager <= $${p++}`);
      params.push(maxWager);
    }

    const where = conditions.join(' AND ');
    const key = cacheKey(req, 'games');
    const cached = getCachedJson(key);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM games g WHERE ${where}`, params);
    const total = Number(countRes.rows[0]?.total || 0);

    const sql = `
      SELECT g.id, g.creator_id, u.username AS creator_username,
             g.creator_choice, g.wager, g.status, g.created_at,
             g.joiner_id, g.result, g.winner_id, g.completed_at
      FROM games g
      JOIN users u ON u.id = g.creator_id
      WHERE ${where}
      ORDER BY g.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `;
    const result = await db.query(sql, [...params, limit, offset]);
    const payload = {
      games: result.rows.map(publicGame),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
    setCachedJson(key, payload, GAMES_CACHE_TTL_MS);
    res.set('X-Cache', 'MISS');
    return res.json(payload);

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

// ----- POST /api/games/:id/cancel ------------------------------------
// Cancels an open game created by the current user and refunds escrow.
app.post('/api/games/:id/cancel', requireAuth, gameActionLimiter, requireCooldown('cancel-game', CANCEL_COOLDOWN_MS), async (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({ error: 'Invalid game id.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const gameRes = await client.query('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
    if (gameRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Game not found.' });
    }
    const game = gameRes.rows[0];

    if (game.creator_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only cancel your own open games.' });
    }
    if (game.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This game is no longer open.' });
    }

    await client.query(
      `UPDATE games
          SET status = 'cancelled', completed_at = NOW()
        WHERE id = $1`,
      [game.id]
    );

    const userRes = await client.query(
      `UPDATE users
          SET balance = balance + $1
        WHERE id = $2
        RETURNING id, username, balance, created_at`,
      [game.wager, req.user.id]
    );

    await client.query('COMMIT');
    clearResponseCache();
    return res.json({ ok: true, user: publicUser(userRes.rows[0]) });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[cancel game]', err);
    return res.status(500).json({ error: 'Could not cancel the game. Please try again.' });
  } finally {
    client.release();
  }
});

// ----- POST /api/games/:id/join --------------------------------------
// The creator's wager is already in escrow. Joining deducts the joiner's
// wager, flips server-side, then pays the full pot (2x wager) to winner.
app.post('/api/games/:id/join', requireAuth, gameActionLimiter, requireCooldown('join-game', JOIN_COOLDOWN_MS), async (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({ error: 'Invalid game id.' });
  }

  const lockKey = `game:${gameId}`;
  if (joinLocks.has(lockKey)) {
    return res.status(409).json({ error: 'This game is already being joined. Refresh and try another game.' });
  }
  joinLocks.add(lockKey);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const gameRes = await client.query('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
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

    const wager = Number(game.wager);
    const joinerRes = await client.query(
      'SELECT id, username, balance FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (joinerRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account no longer exists.' });
    }
    const joiner = joinerRes.rows[0];
    if (Number(joiner.balance) < wager) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You do not have enough gold to join this game.' });
    }

    const creatorRes = await client.query(
      'SELECT id, username, balance FROM users WHERE id = $1 FOR UPDATE',
      [game.creator_id]
    );
    if (creatorRes.rowCount === 0) {
      await client.query(
        `UPDATE games SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
        [game.id]
      );
      await client.query('COMMIT');
      return res.status(409).json({ error: 'The game creator no longer exists. Game cancelled.' });
    }
    const creator = creatorRes.rows[0];

    const result = secureCoinFlip();
    const winnerId = (game.creator_choice === result) ? creator.id : joiner.id;
    const pot = wager * 2;

    const debitJoiner = await client.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1',
      [wager, joiner.id]
    );
    if (debitJoiner.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Your gold balance changed. Please try again.' });
    }

    // Award pot, capped at MAX_BALANCE for the winner.
    await client.query(
      `UPDATE users
          SET balance = LEAST(balance + $1, $3::numeric)
        WHERE id = $2`,
      [pot, winnerId, MAX_BALANCE]
    );

    await client.query(
      `UPDATE games
          SET joiner_id = $1, result = $2, winner_id = $3,
              status = 'completed', completed_at = NOW()
        WHERE id = $4`,
      [joiner.id, result, winnerId, game.id]
    );

    await client.query('COMMIT');
    clearResponseCache();

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

    const userRes = await db.query(
      'SELECT id, username, balance, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    return res.json({
      game: publicGame(finalRes.rows[0]),
      user: publicUser(userRes.rows[0]),
      balance: Math.floor(Number(userRes.rows[0].balance)),
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[join game]', err);
    return res.status(500).json({ error: 'Could not join the game. Please try again.' });
  } finally {
    joinLocks.delete(lockKey);
    client.release();
  }
});

// ----- GET /api/me/games ---------------------------------------------
app.get('/api/me/games', requireAuth, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const page   = parsePage(req.query.page, 1);
    const limit  = parseLimit(req.query.limit, 20, 50);
    const offset = (page - 1) * limit;

    if (status && !['open', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter.' });
    }

    const conditions = ['(g.creator_id = $1 OR g.joiner_id = $1)'];
    const params     = [req.user.id];
    if (status) {
      conditions.push(`g.status = $${params.length + 1}`);
      params.push(status);
    }
    const where = conditions.join(' AND ');
    const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM games g WHERE ${where}`, params);
    const total = Number(countRes.rows[0]?.total || 0);

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
       WHERE ${where}
       ORDER BY COALESCE(g.completed_at, g.created_at) DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const result = await db.query(sql, [...params, limit, offset]);
    return res.json({
      games: result.rows.map(publicGame),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('[my games]', err);
    return res.status(500).json({ error: 'Could not load your games.' });
  }
});

// ----- GET /api/leaderboard ------------------------------------------
// Public — no auth required. Top 100 users by balance.
app.get('/api/leaderboard', async (req, res) => {
  try {
    const key = cacheKey(req, 'leaderboard');
    const cached = getCachedJson(key);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    const page = parsePage(req.query.page, 1);
    const limit = parseLimit(req.query.limit, 20, 20);
    const cappedTotalRes = await db.query('SELECT LEAST(COUNT(*)::int, 100) AS total FROM users');
    const total = Number(cappedTotalRes.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;

    const result = await db.query(
      `WITH ranked AS (
         SELECT id, username, balance, created_at,
                ROW_NUMBER() OVER (ORDER BY balance DESC, created_at ASC) AS rank
           FROM users
          ORDER BY balance DESC, created_at ASC
          LIMIT 100
       ), paged AS (
         SELECT * FROM ranked
          WHERE rank > $1 AND rank <= $2
       )
       SELECT p.id, p.username, p.balance, p.created_at, p.rank,
              COUNT(g.id) FILTER (WHERE g.status = 'completed')::int AS games_played,
              COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.winner_id = p.id)::int AS wins,
              COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.winner_id <> p.id)::int AS losses
         FROM paged p
         LEFT JOIN games g
           ON g.status = 'completed'
          AND (g.creator_id = p.id OR g.joiner_id = p.id)
        GROUP BY p.id, p.username, p.balance, p.created_at, p.rank
        ORDER BY p.rank ASC`,
      [offset, offset + limit]
    );
    const payload = {
      users: result.rows.map((r) => ({
        rank: Number(r.rank),
        ...publicUser(r),
        stats: publicStats(r),
      })),
      page: safePage,
      limit,
      total,
      totalPages,
    };
    setCachedJson(key, payload, LEADERBOARD_CACHE_TTL_MS);
    res.set('X-Cache', 'MISS');
    return res.json(payload);
  } catch (err) {
    console.error('[leaderboard]', err);
    return res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

// =====================================================================
// Background jobs
// =====================================================================

/**
 * Auto-cancel stale open games (older than OPEN_GAME_TTL_HOURS) and
 * refund their creators. Runs every 30 minutes.
 */
async function reapStaleOpenGames() {
  if (OPEN_GAME_TTL_HOURS <= 0) return;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const stale = await client.query(
      `SELECT id, creator_id, wager FROM games
        WHERE status = 'open'
          AND created_at < NOW() - ($1::int * INTERVAL '1 hour')
        FOR UPDATE`,
      [OPEN_GAME_TTL_HOURS]
    );
    for (const g of stale.rows) {
      await client.query(
        `UPDATE games SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
        [g.id]
      );
      await client.query(
        `UPDATE users SET balance = LEAST(balance + $1, $3::numeric) WHERE id = $2`,
        [g.wager, g.creator_id, MAX_BALANCE]
      );
    }
    await client.query('COMMIT');
    if (stale.rowCount > 0) {
      clearResponseCache();
      console.log(`[reap] auto-cancelled ${stale.rowCount} stale open game(s).`);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[reap]', err);
  } finally {
    client.release();
  }
}

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
// Start server (only when run directly).
// ---------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`[startup] Coinflip Gold API listening on :${PORT} (${NODE_ENV})`);
    console.log(`[startup] STARTING_BALANCE = ${STARTING_BALANCE}`);
    console.log(`[startup] FRONTEND_ORIGIN  = ${FRONTEND_ORIGIN || '(none set — only localhost allowed)'}`);
    console.log(`[startup] OPEN_GAME_TTL_HOURS = ${OPEN_GAME_TTL_HOURS}`);
  });

  // Reap stale open games on boot, then every 30 minutes.
  reapStaleOpenGames().catch(() => {});
  const reapTimer = setInterval(() => {
    reapStaleOpenGames().catch(() => {});
  }, 30 * 60 * 1000);

  // Graceful shutdown so Railway redeploys don't drop in-flight transactions.
  function shutdown(sig) {
    console.log(`[shutdown] received ${sig}, draining…`);
    clearInterval(reapTimer);
    server.close(() => {
      db.pool.end().then(() => {
        console.log('[shutdown] complete.');
        process.exit(0);
      }).catch(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = app;
