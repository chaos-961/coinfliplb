/* =====================================================================
   CoinFlip LB — config.js
   ---------------------------------------------------------------------
   Non-secret display / behavioural constants. Loaded BEFORE app.js.
   Exposed as window.CONFIG.

   IMPORTANT: After deploying the backend, edit API_BASE_URL below.
   ===================================================================== */
window.CONFIG = Object.freeze({
  // ----- Where the API lives -----------------------------------------
  // For local dev:        http://localhost:3000
  // For Railway:          https://YOUR-SERVICE.up.railway.app   (no slash)
  API_BASE_URL: "https://coinfliplb-production.up.railway.app",

  // ----- Branding ----------------------------------------------------
  APP_NAME: "CoinFlip LB",

  // ----- Account defaults --------------------------------------------
  // Display value only. The backend env var STARTING_BALANCE is the
  // source of truth — keep these two in sync if you change one.
  STARTING_BALANCE: 100,
  MIN_PASSWORD_LENGTH: 6,

  // ----- Wager limits (UI clamping; backend enforces > 0 & ≤ balance)
  MIN_WAGER: 1,
  MAX_WAGER: 1000000,

  // ----- Flip animation ----------------------------------------------
  // Total time the flip modal animates before revealing the result.
  // Lower = snappier, higher = more suspense.
  DEFAULT_FLIP_DURATION_MS: 4200,

  // ----- Polling -----------------------------------------------------
  // How often the dashboard refreshes data (open games + your games).
  // Pauses while the tab is hidden or while a flip is animating.
  POLLING_INTERVAL_MS: 60000,
});