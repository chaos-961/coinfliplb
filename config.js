window.CONFIG = Object.freeze({
  API_BASE_URL: "https://coinfliplb-production.up.railway.app",

  APP_NAME: "Coinflip LB",

  // These are sensible client-side fallbacks. The frontend pulls the
  // authoritative values from /api/config at boot, so when the backend
  // changes its limits the UI updates without a redeploy.
  STARTING_BALANCE: 100,
  MIN_PASSWORD_LENGTH: 6,

  MIN_WAGER: 1,
  MAX_WAGER: 1000000,

  // Coin toss animation length (ms). Hard-clamped in the JS to keep
  // the result modal from feeling either jittery or sluggish.
  // 1.5s default with v0.13's vertical-flip motion — fast and readable.
  DEFAULT_FLIP_DURATION_MS: 2200,

  // The polling fallback used when WebSockets / SSE are unavailable.
  // The real "watcher" interval is shorter and lives in app.js.
  POLLING_INTERVAL_MS: 60000,

  // App version surfaced in the footer.
  APP_VERSION: "v1.3",
});
