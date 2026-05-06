// =====================================================================
// config.js — frontend settings
// ---------------------------------------------------------------------
// Anything in this file is visible to anyone who opens the browser
// devtools. It controls UI behaviour ONLY. Game rules (starting
// balance, who wins, etc.) are enforced by the backend; changing
// values here cannot give a user free money or rig a flip.
// =====================================================================

const CONFIG = {
  // CHANGE ME after deploying the backend to Railway. No trailing slash.
  // Example: "https://coinflip-arena-production.up.railway.app"
  API_BASE_URL: "http://coinfliplb-production.up.railway.app",

  // Display value only. The real starting balance is set in the
  // backend env var STARTING_BALANCE — keep these two in sync.
  STARTING_BALANCE: 100,

  // Validation in the signup form. The backend enforces its own minimum
  // (currently 6) — make sure these match.
  MIN_PASSWORD_LENGTH: 6,

  // How long the coin-flip animation runs before the result is shown.
  DEFAULT_FLIP_DURATION_MS: 5000,

  // How fast the coin "ticks" through heads/tails during the spin.
  // Lower = faster spin.
  COIN_FLIP_SPEED_MS: 120,

  // UI wager bounds. Backend has its own (much higher) hard cap.
  MIN_WAGER: 1,
  MAX_WAGER: 100,

  // Auto-refresh the open games list this often (set to 0 to disable).
  POLLING_INTERVAL_MS: 5000,

  // Branding.
  APP_NAME: "CoinFlip LB",
};

// Make CONFIG available to other scripts that load after this one.
window.CONFIG = CONFIG;
