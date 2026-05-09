// =====================================================================
// server.js — Coinflip Gold backend (v1.1, public-release)
// ---------------------------------------------------------------------
// This is the single source of truth for the game. The frontend is
// purely a UI: every important decision (who wins a flip, what your
// balance is, whether a username is taken) is made here and saved in
// PostgreSQL. The frontend never sees password hashes or computes
// game results.
//
// Endpoints:
//   POST /api/auth/signup          create account, returns token + user
//   POST /api/auth/login           log in, returns token + user
//   POST /api/auth/logout          client-side token wipe (best-effort)
//   POST /api/auth/logout-all      bumps token_version, kills every JWT
//   GET  /api/me                   returns current user (requires auth)
//   POST /api/games                create an open game (requires auth)
//   GET  /api/games                list open games with optional filters
//   POST /api/games/:id/join       join a game, runs the flip atomically
//   POST /api/games/:id/cancel     cancel an open game (creator only)
//   GET  /api/games/:id            fetch one game's details (incl. PF info)
//   POST /api/games/:id/verify     server-side verification helper
//   GET  /api/me/games             list current user's games
//   GET  /api/me/transactions      current user's ledger entries
//   GET  /api/leaderboard          top users sorted by balance (public)
//   GET  /api/me/stats             current player computed stats
//   POST /api/presence/heartbeat   online player heartbeat
//   GET  /api/config               client-side runtime config
//   GET  /api/admin/suspicious     admin-only: clusters of suspicious activity
//   GET  /health                   liveness check (pings DB)
//
// What's new in v1.1 (vs the original v1.0):
//   • Signup IP/UA throttling backed by `signup_attempts` (DB-backed,
//     survives restarts and works correctly behind Railway's proxy).
//   • Optional `email` field, schema-ready for future verification flow.
//   • Race-safe case-insensitive username uniqueness via
//     `users_username_lower_uniq` and 23505 unique-violation handling.
//   • Full `balance_transactions` ledger — every Gold movement audited.
//   • Provably-fair coinflip: server seed committed via SHA-256 hash
//     before the join, revealed after, combined with a client seed +
//     game id (nonce) to produce the result.
//   • JWT token versioning so password changes / logout-all invalidate
//     existing tokens.
//   • Fail-hard JWT_SECRET in production; cleaner config error messages.
//   • Admin endpoint for suspicious-activity heuristics (gated by
//     ADMIN_API_TOKEN).
//   • Fix: `clientIp` now uses `req.ip` consistently (not raw header).
//   • Fix: cancelled/completed games can never re-flip due to row locks.
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
const { LEDGER_TYPES, applyBalanceDelta, applyBalanceDeltaCapped } = db;

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

// SHA-256 of a string, returned as hex.
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

// HMAC-SHA-256 used by the provably-fair flip. Keyed-hashing means a
// malicious client can't precompute results without the server seed.
function hmacSha256Hex(key, message) {
  return crypto.createHmac('sha256', String(key)).update(String(message), 'utf8').digest('hex');
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

// Salt mixed into IP/UA hashes so the raw values are never stored. Falls
// back to the JWT secret in development; in production a dedicated salt
// is recommended via env (and rotating it invalidates old IP histories
// but that's acceptable for an abuse-control feature).
const IP_HASH_SALT = process.env.IP_HASH_SALT || JWT_SECRET || 'coinflip-dev-salt';

// Optional admin token used to gate /api/admin/* endpoints. If unset, the
// admin endpoints return 503 — fine for the default deployment, opt-in
// for operators who want it.
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

// Auto-cancel open games older than this many hours (default 48h, 0 = disabled).
const OPEN_GAME_TTL_HOURS = parseInt(process.env.OPEN_GAME_TTL_HOURS || '48', 10);

// Lightweight abuse-control tuning. All are in-memory on purpose: no DB/schema changes.
// NOTE: in-memory state is correct for a single Railway replica. With multiple
// replicas these caches become per-replica and ineffective; see README.
const MAX_CONTENT_LENGTH_BYTES = 32 * 1024;
const MAX_IN_FLIGHT_PER_IP     = parseInt(process.env.MAX_IN_FLIGHT_PER_IP || '25', 10);
const CREATE_COOLDOWN_MS       = parseInt(process.env.CREATE_COOLDOWN_MS || '2500', 10);
const JOIN_COOLDOWN_MS         = parseInt(process.env.JOIN_COOLDOWN_MS || '1800', 10);
const CANCEL_COOLDOWN_MS       = parseInt(process.env.CANCEL_COOLDOWN_MS || '1600', 10);
const GAMES_CACHE_TTL_MS       = parseInt(process.env.GAMES_CACHE_TTL_MS || '1500', 10);
const LEADERBOARD_CACHE_TTL_MS = parseInt(process.env.LEADERBOARD_CACHE_TTL_MS || '5000', 10);
const MAX_CACHE_ENTRIES        = 100;

// Signup throttle (DB-backed via signup_attempts).
//   - At most SIGNUP_MAX_PER_IP_DAY successful + failed attempts per IP per 24h.
//   - At most SIGNUP_MAX_ACCOUNTS_PER_IP_DAY accounts actually created per IP per 24h.
//   - Soft cooldown SIGNUP_COOLDOWN_MS between attempts from the same IP.
const SIGNUP_MAX_PER_IP_DAY            = parseInt(process.env.SIGNUP_MAX_PER_IP_DAY            || '20', 10);
const SIGNUP_MAX_ACCOUNTS_PER_IP_DAY   = parseInt(process.env.SIGNUP_MAX_ACCOUNTS_PER_IP_DAY   || '5',  10);
const SIGNUP_COOLDOWN_MS               = parseInt(process.env.SIGNUP_COOLDOWN_MS               || '4000', 10);

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 200;             // bcrypt DoS guard
const MAX_USERNAME_LENGTH = 32;
const MIN_USERNAME_LENGTH = 3;
const MAX_EMAIL_LENGTH    = 254;             // RFC 5321 practical limit
const MIN_WAGER           = 1;
const MAX_WAGER           = 1_000_000;        // tightened from 10B to 1M
const MAX_BALANCE         = 1_000_000_000;    // hard cap so leaderboard can't run away
const MAX_OPEN_GAMES_PER_USER = 5;             // a single user can hold at most this many open games at once
const TOKEN_EXPIRES_IN    = '7d';
const BCRYPT_COST         = 12;
const REQUIRE_STRONG_PASSWORD = String(process.env.REQUIRE_STRONG_PASSWORD || '').toLowerCase() === 'true';

// Centralised config bag exposed via /api/config (kept consistent with constants above).
const SIGNUP_BONUS = STARTING_BALANCE; // explicit alias used by ledger metadata

if (!Number.isSafeInteger(STARTING_BALANCE) || STARTING_BALANCE < 0) {
  console.error('[startup] STARTING_BALANCE must be a whole number >= 0.');
  process.exit(1);
}

// JWT secret is now FAIL-HARD in production. A weak/dev secret in prod
// is the most common single thing that turns a hobby project into a
// liability — refuse to boot rather than silently warn.
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  if (NODE_ENV === 'production') {
    console.error(
      '[startup] FATAL: JWT_SECRET is missing or too short for production. ' +
      'Generate a long random string (>=32 chars) and set it as a Railway ' +
      'service variable before redeploying.'
    );
    process.exit(1);
  } else {
    console.warn(
      '[startup] WARNING: JWT_SECRET is missing or short — using a development ' +
      'fallback. This is OK locally but will refuse to boot in production.'
    );
  }
}

// In production, also insist on FRONTEND_ORIGIN being set so we don't
// accidentally ship a backend that allows any origin.
if (NODE_ENV === 'production' && !FRONTEND_ORIGIN) {
  console.error('[startup] FATAL: FRONTEND_ORIGIN must be set in production (e.g. https://coinfliplb.com).');
  process.exit(1);
}

// ---------------------------------------------------------------------
// Real bcrypt dummy hash, generated once at startup. Used to keep
// login response times constant whether or not the username exists.
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
  // Express resolves req.ip using `trust proxy` already; using it
  // directly is correct on Railway, behind nginx, and locally.
  return req.ip || 'unknown';
}

function ipHash(req) {
  return sha256Hex(`${IP_HASH_SALT}|ip|${clientIp(req)}`);
}

function uaHash(req) {
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 512);
  return sha256Hex(`${IP_HASH_SALT}|ua|${ua}`);
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

// Stricter signup-specific IP limiter — sits in front of the DB-backed throttle.
const signupIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.SIGNUP_MAX_PER_IP_HOUR || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created recently. Try again later.' },
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
  // Carries the user id and the user's current `token_version` so a
  // password change / logout-all can invalidate every existing token.
  return jwt.sign(
    { uid: user.id, v: Number(user.token_version || 0) },
    JWT_SECRET || 'dev-fallback-secret-change-me',
    { expiresIn: TOKEN_EXPIRES_IN, algorithm: 'HS256' }
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

function publicGame(row, { includeServerSeed = false } = {}) {
  // We expose the server seed only after a game has resolved.
  const completed = row.status === 'completed' || row.status === 'cancelled';
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
    // Provably-fair fields. Hash is always safe to show; seed only after.
    server_seed_hash: row.server_seed_hash || null,
    server_seed: includeServerSeed && completed ? (row.server_seed || null) : null,
    client_seed: row.client_seed || null,
    nonce: row.nonce !== null && row.nonce !== undefined ? Number(row.nonce) : null,
    pf_algo: row.pf_algo || null,
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

// ---------------------------------------------------------------------
// Provably-fair coinflip
// ---------------------------------------------------------------------
// Algorithm:
//   1. When a game is created, the server generates a random 32-byte seed
//      (`server_seed`) and stores it. It also stores a SHA-256 hash of
//      that seed (`server_seed_hash`) which is shown to anyone who looks
//      at the game.
//   2. When a player joins, they may pass an optional `client_seed`. If
//      they don't, the server fills one in for them with random bytes.
//   3. The result is HMAC-SHA-256(server_seed, "<client_seed>:<game_id>").
//      The lowest bit of the first byte selects heads (0) or tails (1).
//      256 is divisible by 2 so there's no modulo bias.
//   4. After the flip, the server stores the result and reveals the
//      server_seed to the public via GET /api/games/:id.
//
// Anyone can independently check: given the revealed server_seed, the
// client_seed, and the game id, the result must come out the same.
// And because the seed's hash was committed *before* the join, the
// server cannot have chosen the seed after the fact.
// ---------------------------------------------------------------------
const PF_ALGO_NAME = 'hmac-sha256(server_seed, client_seed:game_id)/v1';

function newServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function newClientSeedFallback() {
  return crypto.randomBytes(16).toString('hex');
}

function provablyFairFlip(serverSeed, clientSeed, gameId) {
  const message = `${clientSeed}:${gameId}`;
  const digest = hmacSha256Hex(serverSeed, message);
  // Use the first byte's lowest bit. Hex chars 0-1 = first byte.
  const firstByte = parseInt(digest.slice(0, 2), 16);
  return (firstByte & 1) === 0 ? 'heads' : 'tails';
}

function isReasonableClientSeed(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > 128) return false;
  // Printable ASCII only. Keeps verification copy/pasteable across systems.
  return /^[\x20-\x7E]+$/.test(value);
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function isValidUsername(u) {
  // Stricter than v1.0: usernames cannot start or end with '.', '_' or
  // '-', and cannot contain runs of those symbols. Helps avoid look-alike
  // / impersonation handles like "..admin..".
  if (typeof u !== 'string') return false;
  if (u.length < MIN_USERNAME_LENGTH || u.length > MAX_USERNAME_LENGTH) return false;
  if (!/^[a-zA-Z0-9_.-]+$/.test(u)) return false;
  if (/^[._-]/.test(u) || /[._-]$/.test(u)) return false;
  if (/[._-]{2,}/.test(u)) return false;
  return true;
}

function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (v.length > MAX_EMAIL_LENGTH) return false;
  // Keep validation lenient — true validation comes from sending mail later.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isStrongEnoughPassword(password) {
  if (!REQUIRE_STRONG_PASSWORD) return true;
  return /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
}

// ---------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }
  try {
    if (token.length > 2048) return res.status(401).json({ error: 'Invalid session token.' });
    const payload = jwt.verify(
      token,
      JWT_SECRET || 'dev-fallback-secret-change-me',
      { algorithms: ['HS256'] }
    );
    const uid = Number(payload.uid);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      return res.status(401).json({ error: 'Invalid session token.' });
    }
    // Verify the token's `v` claim matches the user's current
    // token_version. A bumped version makes every previously-issued
    // token unauthenticated immediately.
    const userRow = await db.query('SELECT id, token_version FROM users WHERE id = $1', [uid]);
    if (userRow.rowCount === 0) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    const currentV = Number(userRow.rows[0].token_version || 0);
    const tokenV = Number(payload.v || 0);
    if (currentV !== tokenV) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    req.user = { id: uid };
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// Admin-only middleware. Compares a single shared token using a constant-
// time comparator. If ADMIN_API_TOKEN isn't set, the route 503s — admin
// tooling is opt-in.
function requireAdmin(req, res, next) {
  if (!ADMIN_API_TOKEN) {
    return res.status(503).json({ error: 'Admin endpoints are disabled. Set ADMIN_API_TOKEN to enable them.' });
  }
  const header = req.headers['x-admin-token'] || '';
  const provided = Buffer.from(String(header));
  const expected = Buffer.from(ADMIN_API_TOKEN);
  if (provided.length !== expected.length) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  next();
}

// =====================================================================
// Routes
// =====================================================================

// Health check that actually pings the DB. Returns 503 on DB failure.
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, service: 'coinflip-arena', version: '1.1', time: new Date().toISOString() });
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
    provablyFair: {
      enabled: true,
      algorithm: PF_ALGO_NAME,
    },
  });
});

// ----- POST /api/auth/signup -----------------------------------------
app.post('/api/auth/signup', signupIpLimiter, authLimiter, async (req, res) => {
  const ip_hash = ipHash(req);
  const ua_hash = uaHash(req);

  try {
    const username   = normalizeUsername(req.body?.username);
    const password   = req.body?.password || '';
    const emailInput = (req.body?.email || '').toString().trim();

    // Synchronous validation first — cheap and tells the user fast.
    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters using letters, numbers, _, ., or -. It can't start/end with those symbols or include runs of them.`
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

    // Email is optional. If present, validate; if absent, leave as null.
    let email = null;
    if (emailInput) {
      if (!isValidEmail(emailInput)) {
        return res.status(400).json({ error: 'That email address looks invalid.' });
      }
      email = emailInput.toLowerCase();
    }

    // ----- DB-backed signup throttling -------------------------------
    // Soft cooldown between attempts from the same IP.
    const recent = await db.query(
      `SELECT created_at FROM signup_attempts
        WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '1 minute'
        ORDER BY created_at DESC LIMIT 1`,
      [ip_hash]
    );
    if (recent.rowCount > 0) {
      const last = new Date(recent.rows[0].created_at).getTime();
      const elapsed = Date.now() - last;
      if (elapsed < SIGNUP_COOLDOWN_MS) {
        const wait = Math.ceil((SIGNUP_COOLDOWN_MS - elapsed) / 1000);
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: `Too many accounts created recently. Try again in ${wait}s.` });
      }
    }

    // Per-IP daily caps. Both attempts and accounts are counted.
    const attemptCountRes = await db.query(
      `SELECT COUNT(*)::int AS attempts,
              COUNT(*) FILTER (WHERE success)::int AS successes
         FROM signup_attempts
        WHERE ip_hash = $1
          AND created_at > NOW() - INTERVAL '24 hours'`,
      [ip_hash]
    );
    const attempts = Number(attemptCountRes.rows[0]?.attempts || 0);
    const successes = Number(attemptCountRes.rows[0]?.successes || 0);
    if (attempts >= SIGNUP_MAX_PER_IP_DAY || successes >= SIGNUP_MAX_ACCOUNTS_PER_IP_DAY) {
      // Log the failed attempt before returning so this attempt counts toward the cap.
      await db.query(
        `INSERT INTO signup_attempts (ip_hash, ua_hash, success) VALUES ($1, $2, false)`,
        [ip_hash, ua_hash]
      );
      return res.status(429).json({
        error: 'Too many accounts created recently. Try again later.',
      });
    }

    // ----- Username pre-check (fast path) -----------------------------
    // The unique index on LOWER(username) makes the actual race-safe check
    // happen at INSERT time. This pre-check just keeps the bcrypt work off
    // the critical path when we already know the name is taken.
    const existing = await db.query(
      'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (existing.rowCount > 0) {
      await db.query(
        `INSERT INTO signup_attempts (ip_hash, ua_hash, success) VALUES ($1, $2, false)`,
        [ip_hash, ua_hash]
      );
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_COST);

    // ----- Atomic insert + signup-bonus ledger ------------------------
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Insert the user with a 0 starting balance so we can write the
      // signup bonus through the ledger helper. This guarantees a single
      // source of truth for "where did the first 100 Gold come from".
      let insertedUser;
      try {
        const insert = await client.query(
          `INSERT INTO users (username, password_hash, balance, email, signup_ip_hash, signup_ua_hash, last_ip_hash, last_seen_at)
           VALUES ($1, $2, 0, $3, $4, $5, $4, NOW())
           RETURNING id, username, balance, created_at, token_version, email`,
          [username, password_hash, email, ip_hash, ua_hash]
        );
        insertedUser = insert.rows[0];
      } catch (insertErr) {
        // Postgres unique-violation = 23505. With the LOWER(username)
        // unique index, two concurrent signups for "alice"/"Alice" each
        // make it past the pre-check, but only one survives this INSERT.
        await client.query('ROLLBACK');
        if (insertErr && insertErr.code === '23505') {
          // Could be username or email, depending on which constraint fired.
          const detail = String(insertErr.constraint || insertErr.detail || '');
          await db.query(
            `INSERT INTO signup_attempts (ip_hash, ua_hash, success) VALUES ($1, $2, false)`,
            [ip_hash, ua_hash]
          );
          if (detail.includes('email')) {
            return res.status(409).json({ error: 'That email is already in use.' });
          }
          return res.status(409).json({ error: 'That username is already taken.' });
        }
        throw insertErr;
      }

      if (SIGNUP_BONUS > 0) {
        const bonused = await applyBalanceDelta(
          client,
          insertedUser.id,
          SIGNUP_BONUS,
          LEDGER_TYPES.SIGNUP_BONUS,
          null,
          { reason: 'new account starting balance' }
        );
        if (!bonused) {
          // Should never happen for a fresh account, but bail safely.
          await client.query('ROLLBACK');
          throw new Error('Could not apply signup bonus.');
        }
        insertedUser = bonused;
      }

      await client.query(
        `INSERT INTO signup_attempts (ip_hash, ua_hash, success) VALUES ($1, $2, true)`,
        [ip_hash, ua_hash]
      );

      await client.query('COMMIT');

      const token = signToken({ id: insertedUser.id, token_version: 0 });
      return res.status(201).json({ token, user: publicUser(insertedUser) });
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch {}
      throw txErr;
    } finally {
      client.release();
    }
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
      'SELECT id, username, password_hash, balance, created_at, token_version FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    const row = result.rows[0];

    // Use a real bcrypt dummy hash so timing is constant whether the
    // username exists or not (and bcrypt.compare doesn't throw).
    const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);

    if (!row || !ok) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Update last-seen / last-IP on a successful login. Best-effort.
    db.query('UPDATE users SET last_ip_hash = $1, last_seen_at = NOW() WHERE id = $2', [ipHash(req), row.id])
      .catch(() => {});

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

// ----- POST /api/auth/logout-all -------------------------------------
// Bumps the user's token_version, which invalidates every JWT issued
// before this call. Useful if the user thinks their token was leaked.
app.post('/api/auth/logout-all', requireAuth, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET token_version = token_version + 1 WHERE id = $1',
      [req.user.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[logout-all]', err);
    return res.status(500).json({ error: 'Could not sign you out everywhere.' });
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

// ----- GET /api/me/transactions --------------------------------------
// User-facing ledger viewer. Lets a player audit their own balance.
app.get('/api/me/transactions', requireAuth, async (req, res) => {
  try {
    const page = parsePage(req.query.page, 1);
    const limit = parseLimit(req.query.limit, 20, 50);
    const offset = (page - 1) * limit;
    const total = Number((await db.query(
      'SELECT COUNT(*)::int AS c FROM balance_transactions WHERE user_id = $1',
      [req.user.id]
    )).rows[0]?.c || 0);
    const result = await db.query(
      `SELECT id, type, amount, balance_before, balance_after, related_game_id, metadata, created_at
         FROM balance_transactions
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    return res.json({
      transactions: result.rows.map(r => ({
        id: Number(r.id),
        type: r.type,
        amount: Number(r.amount),
        balance_before: Number(r.balance_before),
        balance_after: Number(r.balance_after),
        related_game_id: r.related_game_id,
        metadata: r.metadata || null,
        created_at: r.created_at,
      })),
      page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('[transactions]', err);
    return res.status(500).json({ error: 'Could not load transactions.' });
  }
});

app.post('/api/presence/heartbeat', requireAuth, (req, res) => {
  const online = touchOnlineUser(req.user.id);
  res.json({ online });
});

// ----- POST /api/games (create) --------------------------------------
// Creates an open game and reserves the creator's wager immediately.
// This prevents a user with $60 from creating multiple $50 games.
// Also generates the provably-fair server seed up front and commits its
// hash to the database before the game is visible to anyone.
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

  // Generate the PF seed BEFORE we open the transaction. We never want
  // the random bytes to depend on transactional state.
  const serverSeed = newServerSeed();
  const serverSeedHash = sha256Hex(serverSeed);

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

    // Insert the game first so the ledger row can reference it.
    const insert = await client.query(
      `INSERT INTO games (creator_id, creator_choice, wager, status, server_seed, server_seed_hash, pf_algo)
       VALUES ($1, $2, $3, 'open', $4, $5, $6)
       RETURNING id, creator_id, creator_choice, wager, status, created_at, server_seed_hash, pf_algo`,
      [req.user.id, choice, wager, serverSeed, serverSeedHash, PF_ALGO_NAME]
    );
    const gameRow = insert.rows[0];

    // Debit the creator's wager via the ledger helper.
    const updatedUser = await applyBalanceDelta(
      client,
      req.user.id,
      -wager,
      LEDGER_TYPES.GAME_CREATE_DEBIT,
      gameRow.id,
      { wager }
    );
    if (!updatedUser) {
      // Concurrent change ate the balance — bail.
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Your gold balance changed. Please try again.' });
    }

    await client.query('COMMIT');
    clearResponseCache();

    return res.status(201).json({
      game: publicGame({
        ...gameRow,
        creator_username: me.rows[0].username,
        joiner_id: null, joiner_username: null,
        result: null, winner_id: null, winner_username: null,
        completed_at: null,
        // server_seed is intentionally NOT exposed yet.
        client_seed: null, nonce: null,
      }),
      user: publicUser(updatedUser),
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
             g.joiner_id, g.result, g.winner_id, g.completed_at,
             g.server_seed_hash, g.client_seed, g.nonce, g.pf_algo
      FROM games g
      JOIN users u ON u.id = g.creator_id
      WHERE ${where}
      ORDER BY g.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `;
    const result = await db.query(sql, [...params, limit, offset]);
    const payload = {
      games: result.rows.map(r => publicGame(r)),
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
// Returns the full game including provably-fair fields. The server seed
// is only revealed for completed/cancelled games.
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
    return res.json({ game: publicGame(result.rows[0], { includeServerSeed: true }) });

  } catch (err) {
    console.error('[get game]', err);
    return res.status(500).json({ error: 'Could not load that game.' });
  }
});

// ----- POST /api/games/:id/verify ------------------------------------
// Server-side helper that re-runs the provably-fair flip for a completed
// game and returns the inputs + computed result. Anyone can also do this
// in the browser; we expose the helper for users who'd rather not.
app.post('/api/games/:id/verify', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid game id.' });
    }
    const result = await db.query(
      `SELECT id, status, server_seed, server_seed_hash, client_seed, nonce, result, pf_algo
         FROM games WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Game not found.' });
    const g = result.rows[0];
    if (g.status !== 'completed') {
      return res.status(409).json({ error: 'Game has not been resolved yet — nothing to verify.' });
    }

    const recomputed = provablyFairFlip(g.server_seed, g.client_seed, g.nonce);
    const hashMatches = sha256Hex(g.server_seed) === g.server_seed_hash;
    return res.json({
      gameId: id,
      algorithm: g.pf_algo,
      server_seed: g.server_seed,
      server_seed_hash: g.server_seed_hash,
      client_seed: g.client_seed,
      nonce: Number(g.nonce),
      stored_result: g.result,
      recomputed_result: recomputed,
      hash_matches: hashMatches,
      verified: hashMatches && recomputed === g.result,
    });
  } catch (err) {
    console.error('[verify game]', err);
    return res.status(500).json({ error: 'Could not verify the game.' });
  }
});

// ----- POST /api/games/:id/cancel ------------------------------------
// Cancels an open game created by the current user and refunds escrow.
// IMPORTANT: this is one of the only money-moving endpoints a user with
// 0 Gold can use (refunding their own escrow). The frontend MUST allow
// cancelling at 0 balance.
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
        WHERE id = $1 AND status = 'open'`,
      [game.id]
    );

    const refunded = await applyBalanceDelta(
      client,
      req.user.id,
      Number(game.wager),
      LEDGER_TYPES.GAME_CANCEL_REFUND,
      game.id,
      { wager: Number(game.wager) }
    );
    if (!refunded) {
      // applyBalanceDelta returns null only on a guard failure. A refund
      // can never push a balance negative, so this is genuinely impossible.
      await client.query('ROLLBACK');
      throw new Error('Refund failed unexpectedly.');
    }

    await client.query('COMMIT');
    clearResponseCache();
    return res.json({ ok: true, user: publicUser(refunded) });

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
// wager, runs the provably-fair flip, then pays the full pot (2x wager)
// to the winner via the ledger.
app.post('/api/games/:id/join', requireAuth, gameActionLimiter, requireCooldown('join-game', JOIN_COOLDOWN_MS), async (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({ error: 'Invalid game id.' });
  }

  // Optional joiner-supplied client seed for provably-fair verification.
  let clientSeed = req.body?.client_seed;
  if (clientSeed != null) {
    if (!isReasonableClientSeed(clientSeed)) {
      return res.status(400).json({ error: 'Client seed must be 1–128 printable ASCII characters.' });
    }
  } else {
    clientSeed = newClientSeedFallback();
  }

  // In-memory fast-fail to reject obvious double-clicks before the DB
  // even gets a request. The actual money guarantees are enforced by
  // SELECT…FOR UPDATE inside the transaction.
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

    // Lock both users in a deterministic order (lowest id first) to
    // avoid two simultaneous joins by different players deadlocking.
    const ids = [Number(req.user.id), Number(game.creator_id)].sort((a, b) => a - b);
    const lockedUsers = await client.query(
      'SELECT id, username, balance FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
      [ids]
    );
    const byId = new Map(lockedUsers.rows.map(r => [Number(r.id), r]));
    const joiner  = byId.get(Number(req.user.id));
    const creator = byId.get(Number(game.creator_id));

    if (!joiner) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account no longer exists.' });
    }
    if (!creator) {
      // Creator deleted between game creation and join — cancel the game
      // (no refund possible because there's nobody to refund to).
      await client.query(
        `UPDATE games SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status = 'open'`,
        [game.id]
      );
      await client.query('COMMIT');
      return res.status(409).json({ error: 'The game creator no longer exists. Game cancelled.' });
    }
    if (Number(joiner.balance) < wager) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You do not have enough gold to join this game.' });
    }

    // ----- Provably-fair flip -------------------------------------
    const flipResult = provablyFairFlip(game.server_seed, clientSeed, game.id);
    const winnerId = (game.creator_choice === flipResult) ? creator.id : joiner.id;
    const pot = wager * 2;

    // Debit the joiner via the ledger.
    const debited = await applyBalanceDelta(
      client,
      joiner.id,
      -wager,
      LEDGER_TYPES.GAME_JOIN_DEBIT,
      game.id,
      { wager }
    );
    if (!debited) {
      // Insufficient funds at the moment of debit (race with another join).
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Your gold balance changed. Please try again.' });
    }

    // Pay the pot to the winner, capped at MAX_BALANCE.
    const paid = await applyBalanceDeltaCapped(
      client,
      winnerId,
      pot,
      MAX_BALANCE,
      LEDGER_TYPES.GAME_WIN_PAYOUT,
      game.id,
      { wager, pot, result: flipResult }
    );
    if (!paid) {
      await client.query('ROLLBACK');
      throw new Error('Could not pay the winner.');
    }

    await client.query(
      `UPDATE games
          SET joiner_id = $1, result = $2, winner_id = $3,
              status = 'completed', completed_at = NOW(),
              client_seed = $4, nonce = $5
        WHERE id = $6 AND status = 'open'`,
      [joiner.id, flipResult, winnerId, clientSeed, game.id, game.id]
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
      game: publicGame(finalRes.rows[0], { includeServerSeed: true }),
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
             g.server_seed_hash, g.client_seed, g.nonce, g.pf_algo,
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
      games: result.rows.map(r => publicGame(r)),
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
// Admin endpoints (gated by ADMIN_API_TOKEN)
// =====================================================================

// ----- GET /api/admin/suspicious -------------------------------------
// Returns several "smell" reports useful when investigating abuse:
//   - clusters: same signup_ip_hash → many accounts in the last N days
//   - rivals:   pairs of users who repeatedly play each other
//   - drains:   brand-new accounts that lost most of their starting bonus
//               in <few games (signs of value-transfer collusion)
//   - hot:      win rate > 70% over >= 30 completed games (flag only)
//
// All numbers are heuristics. None of these endpoints take action; they
// just surface candidates for a human to review.
app.get('/api/admin/suspicious', requireAdmin, async (_req, res) => {
  try {
    const clusters = await db.query(
      `SELECT signup_ip_hash, COUNT(*)::int AS account_count,
              MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
              ARRAY_AGG(username ORDER BY created_at) AS usernames
         FROM users
        WHERE signup_ip_hash IS NOT NULL
          AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY signup_ip_hash
       HAVING COUNT(*) >= 3
        ORDER BY account_count DESC
        LIMIT 50`
    );

    const rivals = await db.query(
      `WITH pairs AS (
          SELECT LEAST(creator_id, joiner_id) AS a,
                 GREATEST(creator_id, joiner_id) AS b,
                 COUNT(*)::int AS games_together
            FROM games
           WHERE status = 'completed' AND joiner_id IS NOT NULL
             AND completed_at > NOW() - INTERVAL '14 days'
           GROUP BY 1, 2
       )
       SELECT p.a AS user_a_id, ua.username AS user_a,
              p.b AS user_b_id, ub.username AS user_b,
              p.games_together
         FROM pairs p
         JOIN users ua ON ua.id = p.a
         JOIN users ub ON ub.id = p.b
        WHERE p.games_together >= 5
        ORDER BY p.games_together DESC
        LIMIT 50`
    );

    const drains = await db.query(
      `SELECT u.id, u.username, u.balance, u.created_at,
              (SELECT COUNT(*) FROM games g
                WHERE (g.creator_id = u.id OR g.joiner_id = u.id)
                  AND g.status = 'completed') AS games
         FROM users u
        WHERE u.created_at > NOW() - INTERVAL '7 days'
          AND u.balance <= 5
        ORDER BY u.created_at DESC
        LIMIT 50`
    );

    const hot = await db.query(
      `WITH stats AS (
          SELECT u.id, u.username,
                 COUNT(g.id)::int AS games_played,
                 COUNT(g.id) FILTER (WHERE g.winner_id = u.id)::int AS wins
            FROM users u
            JOIN games g
              ON g.status = 'completed'
             AND (g.creator_id = u.id OR g.joiner_id = u.id)
           GROUP BY u.id, u.username
       )
       SELECT id, username, games_played, wins,
              ROUND((wins::numeric / NULLIF(games_played, 0)) * 1000) / 10 AS win_rate
         FROM stats
        WHERE games_played >= 30
          AND (wins::numeric / NULLIF(games_played, 0)) >= 0.70
        ORDER BY win_rate DESC, games_played DESC
        LIMIT 50`
    );

    return res.json({
      generated_at: new Date().toISOString(),
      ip_clusters: clusters.rows,
      frequent_rivals: rivals.rows,
      suspicious_drains: drains.rows.map(r => ({
        ...r,
        games: Number(r.games),
      })),
      hot_streaks: hot.rows.map(r => ({
        ...r,
        win_rate: Number(r.win_rate),
      })),
    });
  } catch (err) {
    console.error('[admin/suspicious]', err);
    return res.status(500).json({ error: 'Could not generate the report.' });
  }
});

// =====================================================================
// Background jobs
// =====================================================================

/**
 * Auto-cancel stale open games (older than OPEN_GAME_TTL_HOURS) and
 * refund their creators via the ledger. Runs every 30 minutes.
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
        `UPDATE games SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status = 'open'`,
        [g.id]
      );
      const refunded = await applyBalanceDelta(
        client,
        g.creator_id,
        Number(g.wager),
        LEDGER_TYPES.STALE_REFUND,
        g.id,
        { wager: Number(g.wager), reason: 'open game expired' }
      );
      if (!refunded) {
        // Should be impossible (refund), but bail this game out cleanly.
        console.warn(`[reap] could not refund creator ${g.creator_id} for game ${g.id}`);
      }
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

/**
 * Trim signup_attempts so the table stays small. Anything older than
 * 7 days has no use for the daily-cap calculations.
 */
async function pruneSignupAttempts() {
  try {
    await db.query(`DELETE FROM signup_attempts WHERE created_at < NOW() - INTERVAL '7 days'`);
  } catch (err) {
    console.error('[prune signup_attempts]', err);
  }
}

// ---------------------------------------------------------------------
// 404 + error handler
// ---------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  // Don't leak stack traces in production.
  console.error('[unhandled]', err);
  if (NODE_ENV === 'production') {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } else {
    res.status(500).json({ error: 'Something went wrong. Please try again.', stack: err && err.stack });
  }
});

// ---------------------------------------------------------------------
// Start server (only when run directly).
// ---------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`[startup] Coinflip Gold API v1.1 listening on :${PORT} (${NODE_ENV})`);
    console.log(`[startup] STARTING_BALANCE = ${STARTING_BALANCE}`);
    console.log(`[startup] FRONTEND_ORIGIN  = ${FRONTEND_ORIGIN || '(none set — only localhost allowed)'}`);
    console.log(`[startup] OPEN_GAME_TTL_HOURS = ${OPEN_GAME_TTL_HOURS}`);
    console.log(`[startup] SIGNUP_MAX_PER_IP_DAY = ${SIGNUP_MAX_PER_IP_DAY}, SIGNUP_MAX_ACCOUNTS_PER_IP_DAY = ${SIGNUP_MAX_ACCOUNTS_PER_IP_DAY}`);
    console.log(`[startup] ADMIN_API_TOKEN ${ADMIN_API_TOKEN ? 'set — admin endpoints active' : 'unset — admin endpoints disabled'}`);
  });

  // Reap stale open games + prune signup attempts on boot, then on a timer.
  reapStaleOpenGames().catch(() => {});
  pruneSignupAttempts().catch(() => {});
  const reapTimer = setInterval(() => {
    reapStaleOpenGames().catch(() => {});
  }, 30 * 60 * 1000);
  const pruneTimer = setInterval(() => {
    pruneSignupAttempts().catch(() => {});
  }, 6 * 60 * 60 * 1000);

  // Graceful shutdown so Railway redeploys don't drop in-flight transactions.
  function shutdown(sig) {
    console.log(`[shutdown] received ${sig}, draining…`);
    clearInterval(reapTimer);
    clearInterval(pruneTimer);
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
