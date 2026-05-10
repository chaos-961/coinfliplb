window.CONFIG = Object.freeze({
  // Replace this with your deployed backend URL.
  API_BASE_URL: "https://coinfliplb-production.up.railway.app",

  APP_NAME: "Coinflip LB",

  // Sensible client-side defaults. The frontend pulls authoritative
  // values from /api/config at boot so backend changes propagate
  // without a redeploy.
  STARTING_BALANCE: 100,
  MIN_PASSWORD_LENGTH: 6,

  MIN_WAGER: 1,
  MAX_WAGER: 1000000,

  // Coin toss animation length (ms). The JS clamps this between 1.2s and
  // 2.4s so it stays readable.
  DEFAULT_FLIP_DURATION_MS: 1500,

  // Polling fallback when WebSockets / SSE are unavailable.
  POLLING_INTERVAL_MS: 4000,

  // Add 0.0.1 when updating
  APP_VERSION: "v1.5.0",
});
