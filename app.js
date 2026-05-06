/* =====================================================================
   Coinflip LB — app.js
   ---------------------------------------------------------------------
   Single-file SPA logic. No frameworks.
   - Inline feedback (no toast popups)
   - Auth view default, with confirm-password on signup
   - Dashboard with tabs: Open games / My games / Leaderboard
   - Result banner when one of the user's open games is joined+completed
   - Multi-stage 3D coin flip animation
   ===================================================================== */
(function () {
  'use strict';

  // -------------------------------------------------------------------
  // Constants & state
  // -------------------------------------------------------------------
  const CONFIG = window.CONFIG;
  if (!CONFIG || !CONFIG.API_BASE_URL) {
    console.error('CONFIG missing or invalid. Check config.js loads before app.js.');
    return;
  }
  const API = String(CONFIG.API_BASE_URL).replace(/\/+$/, '');
  const TOKEN_KEY = 'cfa_token';
  const THEME_KEY = 'cfa_theme';

  const state = {
    token:          localStorage.getItem(TOKEN_KEY) || null,
    user:           null,
    activeAuthTab:  'login',
    activeMainTab:  'lobby',
    filters:        {},                // { minWager, maxWager }
    pages:          { lobby: 1, my: 1, leaderboard: 1 },
    totals:         { lobby: 0, my: 0, leaderboard: 0 },
    pageSize:       { lobby: 20, my: 20, leaderboard: 20 },
    isFlipping:     false,
    pollTimer:      null,
    pollTick:       0,
    bannerTimer:    null,
    seenCompletedIds: null,             // Set or null (null = not initialized)
    lastBannerGameId: null,
    // null = we have not checked yet. This prevents showing the lost lockout
    // while the user's whole balance is escrowed in an open game.
    ownOpenGamesCount: null,
    theme:          localStorage.getItem(THEME_KEY) || 'dark',
  };

  // -------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------
  const $  = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  // We grab elements lazily inside an "els" object that gets populated
  // once the DOM is parsed. Keeps the boot flow tidy.
  const els = {};

  function on(el, eventName, handler, options) {
    if (!el) {
      console.warn(`[wireEvents] Missing element for ${eventName}; listener was skipped.`);
      return;
    }
    el.addEventListener(eventName, handler, options);
  }

  function assertRequiredElements() {
    const required = [
      'topbar', 'balancePill', 'balanceValue', 'userName', 'logoutBtn',
      'viewAuth', 'viewDashboard',
      'formLogin', 'formSignup', 'loginUsername', 'loginPassword',
      'signupUsername', 'signupPassword', 'signupConfirm', 'loginBtn', 'signupBtn',
      'loginFeedback', 'signupFeedback',
      'resultBanner', 'resultBannerTitle', 'resultBannerSub', 'resultBannerClose',
      'formCreateGame', 'wagerInput', 'wagerHint', 'createBtn', 'createFeedback',
      'gamesRows', 'gamesEmpty', 'gamesLoading', 'filterMin', 'filterMax',
      'applyFilters', 'clearFilters', 'refreshGames',
      'gamesPager', 'gamesPrev', 'gamesNext', 'gamesPageInfo',
      'myRows', 'myEmpty', 'myLoading', 'refreshMy',
      'myPager', 'myPrev', 'myNext', 'myPageInfo',
      'lbRows', 'lbEmpty', 'lbLoading', 'refreshLb',
      'lbPager', 'lbPrev', 'lbNext', 'lbPageInfo',
      'flipModal', 'flipCoin', 'flipCoinInner', 'flipSub', 'flipResult',
      'resultSide', 'resultPick', 'resultOutcome', 'resultAmount', 'resultBalance',
      'flipCloseBtn', 'tplGameRow', 'tplMyRow', 'tplLbRow',
    ];
    const missing = required.filter(name => !els[name]);
    if (missing.length) {
      console.error(`[boot] Missing required DOM element(s): ${missing.join(', ')}. Check index.html IDs/classes.`);
      return false;
    }
    return true;
  }

  function captureElements() {
    Object.assign(els, {
      // Topbar
      topbar:       $('#topbar'),
      brandName:    $('#brand-name'),
      balancePill:  $('#balance-pill'),
      balanceValue: $('#balance-value'),
      userName:     $('#user-name'),
      logoutBtn:    $('#logout-btn'),
      themeToggle:  $('#theme-toggle'),
      lostCard:     $('#lost-card'),
      lostSignout:  $('#lost-signout'),

      // Views
      viewAuth:      $('#view-auth'),
      viewDashboard: $('#view-dashboard'),

      // Auth forms
      formLogin:        $('#form-login'),
      formSignup:       $('#form-signup'),
      loginUsername:    $('#login-username'),
      loginPassword:    $('#login-password'),
      signupUsername:   $('#signup-username'),
      signupPassword:   $('#signup-password'),
      signupConfirm:    $('#signup-confirm'),
      loginBtn:         $('#login-btn'),
      signupBtn:        $('#signup-btn'),
      loginFeedback:    $('#login-feedback'),
      signupFeedback:   $('#signup-feedback'),

      // Result banner
      resultBanner:      $('#result-banner'),
      resultBannerCoin:  $('#result-banner-coin'),
      resultBannerTitle: $('#result-banner-title'),
      resultBannerSub:   $('#result-banner-sub'),
      resultBannerClose: $('#result-banner-close'),

      // Create form
      formCreateGame: $('#form-create-game'),
      wagerInput:     $('#wager-input'),
      wagerHint:      $('#wager-hint'),
      createBtn:      $('#create-btn'),
      createFeedback: $('#create-feedback'),

      // Tabs
      mainTabs:    $$('.main-tabs .tab'),
      authTabs:    $$('.auth-tabs .tab'),
      myGamesBadge: $('#my-games-badge'),

      // Panels
      panelLobby:       $('#panel-lobby'),
      panelMy:          $('#panel-my'),
      panelLeaderboard: $('#panel-leaderboard'),

      // Lobby panel
      gamesRows:    $('#games-rows'),
      gamesEmpty:   $('#games-empty'),
      gamesLoading: $('#games-loading'),
      filterMin:    $('#filter-min'),
      filterMax:    $('#filter-max'),
      applyFilters: $('#apply-filters'),
      clearFilters: $('#clear-filters'),
      refreshGames: $('#refresh-games'),
      gamesPager:  $('#games-pager'),
      gamesPrev:   $('#games-prev'),
      gamesNext:   $('#games-next'),
      gamesPageInfo: $('#games-page-info'),

      // My panel
      myRows:    $('#my-rows'),
      myEmpty:   $('#my-empty'),
      myLoading: $('#my-loading'),
      refreshMy: $('#refresh-my'),
      myPager:  $('#my-pager'),
      myPrev:   $('#my-prev'),
      myNext:   $('#my-next'),
      myPageInfo: $('#my-page-info'),

      // Leaderboard panel
      lbRows:    $('#lb-rows'),
      lbEmpty:   $('#lb-empty'),
      lbLoading: $('#lb-loading'),
      refreshLb: $('#refresh-lb'),
      lbPager:  $('#lb-pager'),
      lbPrev:   $('#lb-prev'),
      lbNext:   $('#lb-next'),
      lbPageInfo: $('#lb-page-info'),

      // Flip modal
      flipModal:     $('#flip-modal'),
      flipCoin:      $('#flip-coin'),
      flipCoinInner: $('#flip-coin-inner'),
      flipSub:       $('#flip-sub'),
      flipResult:    $('#flip-result'),
      resultSide:    $('#result-side'),
      resultPick:    $('#result-pick'),
      resultOutcome: $('#result-outcome'),
      resultAmount:  $('#result-amount'),
      resultBalance: $('#result-balance'),
      flipCloseBtn:  $('#flip-close-btn'),

      // Templates
      tplGameRow: $('#tpl-game-row'),
      tplMyRow:   $('#tpl-my-row'),
      tplLbRow:   $('#tpl-lb-row'),
    });

    if (els.brandName) els.brandName.textContent = CONFIG.APP_NAME;
  }

  // -------------------------------------------------------------------
  // API helper
  // -------------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.data = data;
    }
  }

  async function api(path, opts = {}) {
    const headers = Object.assign(
      { 'Accept': 'application/json' },
      opts.headers || {}
    );
    if (opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    let res;
    try {
      res = await fetch(API + path, {
        method:  opts.method || 'GET',
        headers,
        body:    opts.body,
        cache:   'no-store',
      });
    } catch (err) {
      throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0, null);
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await res.json(); } catch { data = null; }
    }

    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `Request failed (${res.status})`;
      // Auto-logout on 401 (token expired or invalid)
      if (res.status === 401 && state.token) {
        clearSession();
        showAuthView();
        showFeedback(els.loginFeedback, 'Your session expired. Please sign in again.', 'info');
      }
      throw new ApiError(msg, res.status, data);
    }
    return data;
  }

  // -------------------------------------------------------------------
  // Inline feedback (replaces toast popups)
  // -------------------------------------------------------------------
  function showFeedback(el, message, type = 'info') {
    if (!el) return;
    el.textContent = message;
    el.classList.remove('is-error', 'is-success', 'is-info');
    el.classList.add(`is-${type}`);
    el.hidden = false;
  }
  function clearFeedback(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-error', 'is-success', 'is-info');
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      if (!btn.dataset._origText) btn.dataset._origText = btn.textContent;
      btn.textContent = 'Working…';
    } else {
      btn.disabled = false;
      if (btn.dataset._origText) {
        btn.textContent = btn.dataset._origText;
        delete btn.dataset._origText;
      }
    }
  }

  function setListLoading(kind, loading, label = 'Loading…', isError = false) {
    const map = {
      games: { loading: els.gamesLoading, rows: els.gamesRows, empty: els.gamesEmpty },
      my:    { loading: els.myLoading,    rows: els.myRows,    empty: els.myEmpty },
      lb:    { loading: els.lbLoading,    rows: els.lbRows,    empty: els.lbEmpty },
    };
    const target = map[kind];
    if (!target || !target.loading) return;

    target.loading.hidden = !loading;
    target.loading.classList.toggle('is-error', Boolean(isError));
    target.loading.dataset.label = label;

    if (loading) {
      target.loading.innerHTML = isError
        ? '<div class="loading-error-note">Tap refresh and try again.</div>'
        : Array.from({ length: kind === 'lb' ? 5 : 4 }, () => (
          '<div class="skeleton-row"><span class="skeleton-dot"></span><span class="skeleton-line"></span><span class="skeleton-pill"></span></div>'
        )).join('');
      if (!isError && target.empty) target.empty.hidden = true;
      if (target.rows) {
        target.rows.setAttribute('aria-busy', 'true');
        target.rows.classList.toggle('is-refreshing', target.rows.children.length > 0);
      }
    } else {
      target.loading.innerHTML = '';
      if (target.rows) {
        target.rows.setAttribute('aria-busy', 'false');
        target.rows.classList.remove('is-refreshing');
      }
    }
  }

  // -------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------
  function formatMoney(value) {
    const n = Math.floor(Number(value || 0));
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function formatRelative(dateInput) {
    if (!dateInput) return '';
    const date = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
    if (Number.isNaN(date.getTime())) return '';
    const sec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr  = Math.floor(min / 60);
    if (hr  < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    if (d < 30) return `${d}d ago`;
    return date.toLocaleDateString();
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function compactMoney(value) {
    const n = Number(value || 0);
    return Math.floor(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function parseWholeDollars(value) {
    const raw = String(value ?? '').replace(/,/g, '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }

  function sanitizeIntegerInput(input, { clampMax = false } = {}) {
    if (!input) return;
    const cleaned = String(input.value || '').replace(/[^0-9]/g, '');
    if (input.value !== cleaned) input.value = cleaned;
    if (clampMax && cleaned) {
      const max = Math.floor(getMaxAllowedWager());
      const current = Number(cleaned);
      if (Number.isSafeInteger(current) && max > 0 && current > max) {
        input.value = String(max);
      }
    }
  }

  function normalizeMeta(data, list, page, limit) {
    const total = Number.isFinite(Number(data.total)) ? Number(data.total) : list.length;
    const totalPages = Number.isFinite(Number(data.totalPages)) ? Number(data.totalPages) : Math.max(1, Math.ceil(total / limit));
    return { total, totalPages: Math.max(1, totalPages), page: Number(data.page) || page, limit };
  }

  function updatePager(prefix, meta) {
    const pager = els[`${prefix}Pager`];
    const prev = els[`${prefix}Prev`];
    const next = els[`${prefix}Next`];
    const info = els[`${prefix}PageInfo`];
    if (!pager || !prev || !next || !info) return;
    const totalPages = Math.max(1, Number(meta.totalPages) || 1);
    const page = Math.min(Math.max(1, Number(meta.page) || 1), totalPages);
    pager.hidden = totalPages <= 1;
    prev.disabled = page <= 1;
    next.disabled = page >= totalPages;
    info.textContent = `Page ${page} of ${totalPages}`;
  }

  // -------------------------------------------------------------------
  // Theme + wager limits
  // -------------------------------------------------------------------
  function hasOwnOpenGames() {
    return Number(state.ownOpenGamesCount) > 0;
  }

  function isEliminated() {
    if (!state.user) return false;
    const balance = Number(state.user.balance);

    // Important: a $0 available balance does not always mean the player lost.
    // The balance can be $0 because their money is reserved in an open game.
    // Only lock them out after we know they have no open games left.
    if (!Number.isFinite(balance) || balance > 0) return false;
    if (state.ownOpenGamesCount === null) return false;
    return !hasOwnOpenGames();
  }

  function applyEliminatedState() {
    const lost = isEliminated();
    document.body.classList.toggle('is-eliminated', lost);
    if (els.lostCard) els.lostCard.hidden = !lost;

    // updateWagerLimitUI owns the create-form disabled state because a user can
    // have $0 available while still having an open game in escrow.

    if (els.createFeedback && lost) {
      showFeedback(els.createFeedback, 'You Lost! You can still view games and the leaderboard, but you cannot create, join, or cancel games.', 'error');
    } else if (els.createFeedback && !lost && els.createFeedback.textContent.includes('You Lost!')) {
      clearFeedback(els.createFeedback);
    }
  }

  function applyTheme(theme) {
    const next = (theme === 'light') ? 'light' : 'dark';
    state.theme = next;
    document.body.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    if (els.themeToggle) {
      els.themeToggle.textContent = next === 'light' ? '☾' : '☀';
      els.themeToggle.title = next === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
      els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
    }
  }

  function toggleTheme() {
    applyTheme(state.theme === 'light' ? 'dark' : 'light');
  }

  function getMaxAllowedWager() {
    const configMax = Number(CONFIG.MAX_WAGER) || Number.MAX_SAFE_INTEGER;
    const balance = state.user ? Number(state.user.balance) : configMax;
    const safeBalance = Number.isFinite(balance) ? Math.max(0, balance) : 0;
    return Math.max(0, Math.min(configMax, safeBalance));
  }

  function updateWagerLimitUI() {
    if (!els.wagerInput) return;
    const min = Number(CONFIG.MIN_WAGER) || 1;
    const max = getMaxAllowedWager();
    const lost = isEliminated();
    const unavailable = max < min;

    els.wagerInput.min = String(min);
    els.wagerInput.max = max >= min ? String(max) : String(min);

    if (max >= min) {
      els.wagerInput.placeholder = `${compactMoney(min)} - ${compactMoney(max)}`;
      if (els.wagerHint) els.wagerHint.textContent = `Allowed: ${compactMoney(min)} - ${compactMoney(max)}`;
    } else if (lost) {
      els.wagerInput.placeholder = 'You Lost!';
      if (els.wagerHint) els.wagerHint.textContent = 'You Lost!';
    } else if (hasOwnOpenGames()) {
      els.wagerInput.placeholder = 'Balance reserved';
      if (els.wagerHint) els.wagerHint.textContent = 'Your balance is reserved in an open game. Cancel it or wait for an opponent.';
    } else {
      els.wagerInput.placeholder = 'No balance available';
      if (els.wagerHint) els.wagerHint.textContent = 'No balance available.';
    }

    // Do not allow creating a new game with $0 available balance, but do not
    // show the full "You Lost" lockout while an open game still exists.
    const createDisabled = lost || unavailable;
    els.wagerInput.disabled = createDisabled;
    if (els.createBtn) els.createBtn.disabled = createDisabled;
    if (els.formCreateGame) {
      els.formCreateGame.querySelectorAll('input[name="choice"]').forEach(input => {
        input.disabled = createDisabled;
      });
    }
  }


  // -------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------
  function setSession(token, user) {
    state.token = token;
    state.user  = user;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    updateTopbar();
  }
  function clearSession() {
    state.token = null;
    state.user  = null;
    state.seenCompletedIds = null;
    state.lastBannerGameId = null;
    state.ownOpenGamesCount = null;
    localStorage.removeItem(TOKEN_KEY);
    stopPolling();
    updateTopbar();
  }
  function updateTopbar() {
    const signedIn = !!state.user;
    if (!signedIn) {
      if (els.topbar) els.topbar.hidden = true;
      if (els.balancePill) els.balancePill.hidden = true;
      if (els.userName) els.userName.hidden = true;
      if (els.logoutBtn) els.logoutBtn.hidden = true;
      updateWagerLimitUI();
      applyEliminatedState();
      return;
    }
    els.topbar.hidden = false;
    els.balancePill.hidden = false;
    els.balanceValue.textContent = formatMoney(state.user.balance);
    els.userName.hidden = false;
    els.userName.textContent = state.user.username;
    els.logoutBtn.hidden = false;
    updateWagerLimitUI();
    applyEliminatedState();
  }

  // -------------------------------------------------------------------
  // View switching
  // -------------------------------------------------------------------
  function showAuthView() {
    document.body.dataset.view = 'auth';
    els.viewAuth.hidden = false;
    els.viewDashboard.hidden = true;
    els.topbar.hidden = !state.user;
  }
  function showDashboardView() {
    document.body.dataset.view = 'dashboard';
    els.viewAuth.hidden = true;
    els.viewDashboard.hidden = false;
    els.topbar.hidden = false;
  }

  function switchAuthTab(name) {
    state.activeAuthTab = name;
    els.authTabs.forEach(t => {
      const active = t.dataset.authTab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    els.formLogin.hidden  = (name !== 'login');
    els.formSignup.hidden = (name !== 'signup');
    clearFeedback(els.loginFeedback);
    clearFeedback(els.signupFeedback);
  }

  function switchMainTab(name) {
    state.activeMainTab = name;
    els.mainTabs.forEach(t => {
      const active = t.dataset.mainTab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    els.panelLobby.hidden       = (name !== 'lobby');
    els.panelMy.hidden          = (name !== 'my');
    els.panelLeaderboard.hidden = (name !== 'leaderboard');

    // Clearing the badge when user opens My Games
    if (name === 'my') hideMyGamesBadge();

    // Refresh the panel they just opened
    if (name === 'lobby')       refreshOpenGames().catch(() => {});
    if (name === 'my')          refreshMyGames().catch(() => {});
    if (name === 'leaderboard') refreshLeaderboard().catch(() => {});
  }

  // -------------------------------------------------------------------
  // Auth handlers
  // -------------------------------------------------------------------
  async function handleSignup(e) {
    e.preventDefault();
    clearFeedback(els.signupFeedback);

    const username = (els.signupUsername.value || '').trim();
    const password = els.signupPassword.value || '';
    const confirm  = els.signupConfirm.value  || '';

    if (!/^[a-zA-Z0-9_.\-]{3,32}$/.test(username)) {
      showFeedback(els.signupFeedback, 'Username must be 3–32 characters: letters, numbers, dot, underscore, or hyphen.', 'error');
      return;
    }
    const minPasswordLength = Number(CONFIG.MIN_PASSWORD_LENGTH) || 6;
    if (password.length < minPasswordLength) {
      showFeedback(els.signupFeedback, `Password must be at least ${minPasswordLength} characters.`, 'error');
      return;
    }
    if (password !== confirm) {
      showFeedback(els.signupFeedback, "Passwords don't match.", 'error');
      els.signupConfirm.focus();
      return;
    }

    setLoading(els.signupBtn, true);
    try {
      const data = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setSession(data.token, data.user);
      enterDashboard();
    } catch (err) {
      showFeedback(els.signupFeedback, err.message, 'error');
    } finally {
      setLoading(els.signupBtn, false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    clearFeedback(els.loginFeedback);

    const username = (els.loginUsername.value || '').trim();
    const password = els.loginPassword.value || '';

    if (!username || !password) {
      showFeedback(els.loginFeedback, 'Enter your username and password.', 'error');
      return;
    }

    setLoading(els.loginBtn, true);
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setSession(data.token, data.user);
      enterDashboard();
    } catch (err) {
      showFeedback(els.loginFeedback, err.message, 'error');
    } finally {
      setLoading(els.loginBtn, false);
    }
  }

  function handleLogout() {
    clearSession();
    showAuthView();
    switchAuthTab('login');
    els.formLogin.reset();
    els.formSignup.reset();
    hideResultBanner();
  }

  // -------------------------------------------------------------------
  // Dashboard entry & polling
  // -------------------------------------------------------------------
  async function enterDashboard() {
    showDashboardView();
    switchMainTab('lobby');

    // Reset completion tracking for this session
    state.seenCompletedIds = null;

    // Initial fetches: lobby is already refreshed by switchMainTab.
    // Keep this light so mobile devices do not feel laggy on sign-in.
    await Promise.allSettled([
      refreshMe(),
      refreshMyGames(),
    ]);
    startPolling();
  }

  async function refreshMe() {
    try {
      const data = await api('/api/me');
      state.user = data.user;

      // If the server reports $0, check open games before showing the lost state.
      // Without this, a full-balance open wager looks like a loss even though it
      // can still be cancelled or won.
      const balance = Number(state.user?.balance);
      if (Number.isFinite(balance) && balance <= 0) {
        await refreshOwnOpenGamesCount();
      }

      updateTopbar();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        console.warn('[refreshMe]', err);
      }
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (document.hidden || state.isFlipping || !state.user) return;
      state.pollTick += 1;

      // My games is the lightweight notification feed, so keep it fresh.
      refreshMyGames({ silent: true, forNotification: true }).catch(() => {});

      // Only refresh the visible heavy list. This keeps phones smoother and
      // avoids unnecessary requests as the app grows.
      if (state.activeMainTab === 'lobby') refreshOpenGames({ silent: true }).catch(() => {});
      if (state.activeMainTab === 'leaderboard' && state.pollTick % 6 === 0) refreshLeaderboard({ silent: true }).catch(() => {});

      // Balance changes only after actions/completions; this is just a backup.
      if (state.pollTick % 3 === 0) refreshMe().catch(() => {});
    }, Math.max(4000, Number(CONFIG.POLLING_INTERVAL_MS) || 5000));
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function refreshOwnOpenGamesCount() {
    if (!state.user) {
      state.ownOpenGamesCount = null;
      return 0;
    }

    try {
      const data = await api('/api/me/games?status=open&page=1&limit=1');
      const count = Number(data.total);
      state.ownOpenGamesCount = Number.isFinite(count) ? count : ((data.games || []).length);
      return state.ownOpenGamesCount;
    } catch (err) {
      console.warn('[refreshOwnOpenGamesCount]', err);
      // Keep the previous value if the check fails. If there is no previous
      // value, stay unlocked instead of incorrectly declaring a loss.
      if (state.ownOpenGamesCount === null) return 0;
      return state.ownOpenGamesCount;
    }
  }

  // -------------------------------------------------------------------
  // Open games panel
  // -------------------------------------------------------------------
  async function refreshOpenGames(options = {}) {
    const page = state.pages.lobby;
    const limit = state.pageSize.lobby;
    const params = new URLSearchParams();
    params.set('status', 'open');
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (state.filters.minWager != null) params.set('minWager', state.filters.minWager);
    if (state.filters.maxWager != null) params.set('maxWager', state.filters.maxWager);

    try {
      if (!options.silent) setListLoading('games', true, 'Loading open games…');
      const data = await api(`/api/games?${params.toString()}`);
      const games = data.games || [];
      const meta = normalizeMeta(data, games, page, limit);
      state.totals.lobby = meta.total;
      if (page > meta.totalPages && meta.totalPages > 0) {
        state.pages.lobby = meta.totalPages;
        return refreshOpenGames(options);
      }
      state.pages.lobby = Math.min(page, meta.totalPages);
      setListLoading('games', false);
      renderOpenGames(games);
      updatePager('games', meta);
    } catch (err) {
      if (els.gamesLoading) {
        setListLoading('games', true, 'Could not load open games.', true);
      }
    }
  }

  function renderOpenGames(games) {
    els.gamesRows.innerHTML = '';
    els.gamesRows.setAttribute('aria-busy', 'false');
    if (games.length === 0) {
      els.gamesEmpty.hidden = false;
      return;
    }
    els.gamesEmpty.hidden = true;

    const myId = state.user ? state.user.id : null;
    const myBalance = state.user ? Number(state.user.balance) : 0;
    const frag = document.createDocumentFragment();

    games.forEach(g => {
      const node = els.tplGameRow.content.firstElementChild.cloneNode(true);
      node.dataset.gameId = g.id;

      $('.game-row-name', node).textContent = g.creator_username;
      $('.game-row-time', node).textContent = formatRelative(g.created_at);

      // Coin face for the creator's pick
      const coin = $('.coin', node);
      if (g.creator_choice === 'tails') {
        // Set base inner rotation so the right face is visible
        const inner = $('.coin-inner', coin);
        if (inner) inner.style.transform = 'rotateY(180deg)';
      }
      $('.pick-label', node).textContent = capitalize(g.creator_choice);
      $('.game-row-wager', node).textContent = formatMoney(g.wager);

      const joinBtn = $('.game-row-join', node);
      const isOwn = (g.creator_id === myId);
      const lost = isEliminated();
      const insufficient = (Number(g.wager) > myBalance);
      if (joinBtn) {
        if (lost) {
          joinBtn.disabled = true;
          joinBtn.textContent = 'You Lost';
          joinBtn.title = 'You can view games, but you cannot play after reaching $0.';
        } else if (isOwn) {
          joinBtn.textContent = 'Cancel';
          joinBtn.classList.remove('btn-primary');
          joinBtn.classList.add('btn-danger');
          joinBtn.setAttribute('aria-label', 'Cancel your open game');
          on(joinBtn, 'click', () => handleCancelGame(g.id, joinBtn));
        } else if (insufficient) {
          joinBtn.disabled = true;
          joinBtn.textContent = 'Insufficient';
        } else {
          on(joinBtn, 'click', () => handleJoinGame(g.id, joinBtn));
        }
      }
      frag.appendChild(node);
    });
    els.gamesRows.appendChild(frag);
  }

  function applyFilters() {
    sanitizeIntegerInput(els.filterMin);
    sanitizeIntegerInput(els.filterMax);
    const min = els.filterMin.value ? parseWholeDollars(els.filterMin.value) : null;
    const max = els.filterMax.value ? parseWholeDollars(els.filterMax.value) : null;
    state.filters = {};
    if (min !== null && min >= 0) state.filters.minWager = min;
    if (max !== null && max >= 0) state.filters.maxWager = max;
    state.pages.lobby = 1;
    refreshOpenGames();
  }
  function clearFilters() {
    els.filterMin.value = '';
    els.filterMax.value = '';
    state.filters = {};
    state.pages.lobby = 1;
    refreshOpenGames();
  }

  // -------------------------------------------------------------------
  // My games panel
  // -------------------------------------------------------------------
  async function refreshMyGames(options = {}) {
    try {
      const page = options.forNotification ? 1 : state.pages.my;
      const limit = options.forNotification ? 20 : state.pageSize.my;
      if (!options.silent) setListLoading('my', true, 'Loading your games…');
      const data = await api(`/api/me/games?page=${page}&limit=${limit}`);
      const games = data.games || [];
      const meta = normalizeMeta(data, games, page, limit);
      if (options.forOpenCount || page === 1) {
        const openOnPage = games.filter(g => g.status === 'open').length;
        // When this request is explicitly status=open, total is the open-game count.
        state.ownOpenGamesCount = options.forOpenCount ? meta.total : openOnPage;
        updateWagerLimitUI();
        applyEliminatedState();
      }
      if (!options.forNotification && !options.forOpenCount) {
        state.totals.my = meta.total;
        if (page > meta.totalPages && meta.totalPages > 0) {
          state.pages.my = meta.totalPages;
          return refreshMyGames(options);
        }
        state.pages.my = Math.min(page, meta.totalPages);
        setListLoading('my', false);
        renderMyGames(games);
        updatePager('my', meta);
      } else if (state.activeMainTab === 'my' && page === state.pages.my && !options.forOpenCount) {
        renderMyGames(games);
      }
      if (!options.forOpenCount) processCompletionDetection(games);
    } catch (err) {
      console.warn('[refreshMyGames]', err);
      if (!options.silent && !options.forNotification) setListLoading('my', true, 'Could not load your games.', true);
    }
  }

  function renderMyGames(games) {
    els.myRows.innerHTML = '';
    if (games.length === 0) {
      els.myEmpty.hidden = false;
      return;
    }
    els.myEmpty.hidden = true;

    const myId = state.user ? state.user.id : null;
    const frag = document.createDocumentFragment();

    games.forEach(g => {
      const node = els.tplMyRow.content.firstElementChild.cloneNode(true);
      const status = $('.my-row-status', node);
      const detail = $('.my-row-detail', node);
      const amount = $('.my-row-amount', node);
      const time   = $('.my-row-time', node);
      const cancelBtn = $('.my-row-cancel', node);

      const wager = Number(g.wager);
      const isCreator = (g.creator_id === myId);
      const opponent  = isCreator ? g.joiner_username : g.creator_username;
      const myPick    = isCreator
        ? g.creator_choice
        : (g.creator_choice === 'heads' ? 'tails' : 'heads');

      if (g.status === 'open') {
        status.textContent = 'Waiting';
        status.classList.add('s-open');
        detail.innerHTML = '';
        const txt = document.createElement('span');
        txt.textContent = `You picked `;
        const strong = document.createElement('strong');
        strong.textContent = capitalize(g.creator_choice);
        txt.appendChild(strong);
        detail.appendChild(txt);
        amount.textContent = formatMoney(wager);
        amount.classList.add('is-pending');
        if (isCreator && cancelBtn) {
          cancelBtn.hidden = false;
          if (isEliminated()) {
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Locked';
            cancelBtn.title = 'You cannot cancel games after reaching $0.';
          } else {
            on(cancelBtn, 'click', () => handleCancelGame(g.id, cancelBtn));
          }
        }
      } else if (g.status === 'completed') {
        const won = (g.winner_id === myId);
        status.textContent = won ? 'Won' : 'Lost';
        status.classList.add(won ? 's-win' : 's-loss');

        // Build detail text safely (no innerHTML with user data)
        detail.innerHTML = '';
        const part1 = document.createElement('span');
        part1.textContent = 'vs ';
        const oppName = document.createElement('strong');
        oppName.textContent = opponent || 'opponent';
        const part2 = document.createElement('span');
        part2.textContent = ` · landed on ${capitalize(g.result)} · you picked ${capitalize(myPick)}`;
        detail.appendChild(part1);
        detail.appendChild(oppName);
        detail.appendChild(part2);

        amount.textContent = won ? `+${formatMoney(wager * 2)}` : `−${formatMoney(wager)}`;
        amount.classList.add(won ? 'is-win' : 'is-loss');
      } else {
        status.textContent = 'Cancelled';
        status.classList.add('s-cancelled');
        detail.textContent = 'No opponent joined.';
        amount.textContent = formatMoney(wager);
      }
      time.textContent = formatRelative(g.completed_at || g.created_at);
      frag.appendChild(node);
    });
    els.myRows.appendChild(frag);
  }

  function processCompletionDetection(games) {
    if (!state.user) return;

    const completedIds = new Set(
      games.filter(g => g.status === 'completed').map(g => g.id)
    );

    // First load: just record what we already see; don't surface anything.
    if (state.seenCompletedIds === null) {
      state.seenCompletedIds = completedIds;
      return;
    }

    // Find newly completed games (not in previous set)
    const newOnes = games.filter(g =>
      g.status === 'completed' && !state.seenCompletedIds.has(g.id)
    );

    newOnes.forEach(g => state.seenCompletedIds.add(g.id));

    if (newOnes.length === 0) return;

    // Show the most recent unseen completion in the banner.
    // If the user just clicked "join" themselves, the flip modal already
    // shows them the result — skip the banner for that game id.
    const fresh = newOnes
      .filter(g => g.id !== state.lastBannerGameId && !justSawInModal(g))
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))[0];
    if (fresh) {
      showResultBanner(fresh);
      refreshMe().catch(() => {});
      refreshLeaderboard().catch(() => {});
    }

    // If they're not currently looking at My Games, bump the badge
    if (state.activeMainTab !== 'my') {
      bumpMyGamesBadge(newOnes.length);
    }
  }

  // The user just saw the modal for a game they joined — don't double-show
  let lastModalGameId = null;
  function justSawInModal(g) {
    return lastModalGameId === g.id;
  }

  function bumpMyGamesBadge(count) {
    const badge = els.myGamesBadge;
    if (!badge) return;
    const current = parseInt(badge.textContent, 10) || 0;
    badge.textContent = String(current + count);
    badge.hidden = false;
  }
  function hideMyGamesBadge() {
    if (!els.myGamesBadge) return;
    els.myGamesBadge.textContent = '';
    els.myGamesBadge.hidden = true;
  }

  // -------------------------------------------------------------------
  // Result banner
  // -------------------------------------------------------------------
  function showResultBanner(g) {
    if (!state.user) return;
    const myId = state.user.id;
    const won  = (g.winner_id === myId);
    const opponent = (g.creator_id === myId) ? g.joiner_username : g.creator_username;
    const wager = Number(g.wager);

    state.lastBannerGameId = g.id;

    els.resultBanner.classList.remove('is-win', 'is-loss');
    els.resultBanner.classList.add(won ? 'is-win' : 'is-loss');

    els.resultBannerTitle.textContent = won
      ? `You won ${formatMoney(wager * 2)}!`
      : `You lost ${formatMoney(wager)}.`;

    // Build subtitle safely (no innerHTML with user data)
    els.resultBannerSub.innerHTML = '';
    const a = document.createElement('span');
    a.textContent = `Game vs `;
    const b = document.createElement('strong');
    b.textContent = opponent || 'opponent';
    const c = document.createElement('span');
    c.textContent = ` · landed on ${capitalize(g.result)}`;
    els.resultBannerSub.appendChild(a);
    els.resultBannerSub.appendChild(b);
    els.resultBannerSub.appendChild(c);

    els.resultBanner.hidden = false;
    els.resultBanner.setAttribute('role', 'alert');
    if (state.bannerTimer) clearTimeout(state.bannerTimer);
    state.bannerTimer = setTimeout(hideResultBanner, 20000);
    if (navigator.vibrate) {
      try { navigator.vibrate(won ? [35, 40, 35] : [60]); } catch {}
    }
  }
  function hideResultBanner() {
    if (state.bannerTimer) {
      clearTimeout(state.bannerTimer);
      state.bannerTimer = null;
    }
    els.resultBanner.hidden = true;
    els.resultBanner.classList.remove('is-win', 'is-loss');
  }

  // -------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------
  async function refreshLeaderboard(options = {}) {
    try {
      const page = state.pages.leaderboard;
      const limit = state.pageSize.leaderboard;
      if (!options.silent) setListLoading('lb', true, 'Loading leaderboard…');
      const data = await api(`/api/leaderboard?page=${page}&limit=${limit}`);
      const users = data.users || [];
      const meta = normalizeMeta(data, users, page, limit);
      state.totals.leaderboard = meta.total;
      if (page > meta.totalPages && meta.totalPages > 0) {
        state.pages.leaderboard = meta.totalPages;
        return refreshLeaderboard(options);
      }
      state.pages.leaderboard = Math.min(page, meta.totalPages);
      setListLoading('lb', false);
      renderLeaderboard(users);
      updatePager('lb', meta);
    } catch (err) {
      if (els.lbLoading) {
        setListLoading('lb', true, 'Could not load leaderboard.', true);
      }
    }
  }
  function renderLeaderboard(users) {
    els.lbRows.innerHTML = '';
    if (users.length === 0) {
      els.lbEmpty.hidden = false;
      return;
    }
    els.lbEmpty.hidden = true;
    const myId = state.user ? state.user.id : null;
    const frag = document.createDocumentFragment();
    users.forEach(u => {
      const node = els.tplLbRow.content.firstElementChild.cloneNode(true);
      $('.lb-rank', node).textContent    = u.rank;
      $('.lb-name', node).textContent    = u.username;
      $('.lb-balance', node).textContent = formatMoney(u.balance);
      if (u.rank === 1) node.classList.add('is-top1');
      else if (u.rank === 2) node.classList.add('is-top2');
      else if (u.rank === 3) node.classList.add('is-top3');
      if (u.id === myId) node.classList.add('is-me');
      frag.appendChild(node);
    });
    els.lbRows.appendChild(frag);
  }

  // -------------------------------------------------------------------
  // Create game
  // -------------------------------------------------------------------
  async function handleCreateGame(e) {
    e.preventDefault();
    clearFeedback(els.createFeedback);

    if (isEliminated()) {
      showFeedback(els.createFeedback, 'You Lost! You cannot create another game.', 'error');
      return;
    }

    sanitizeIntegerInput(els.wagerInput, { clampMax: true });
    const choice = (els.formCreateGame.querySelector('input[name="choice"]:checked') || {}).value;
    const wager  = parseWholeDollars(els.wagerInput.value);

    if (!choice) {
      showFeedback(els.createFeedback, 'Pick heads or tails.', 'error');
      return;
    }
    const minWager = Number(CONFIG.MIN_WAGER) || 1;
    const maxWager = getMaxAllowedWager();
    if (wager === null || wager < minWager || wager > maxWager) {
      showFeedback(els.createFeedback, `Wager must be between ${compactMoney(minWager)} and ${compactMoney(maxWager)}.`, 'error');
      return;
    }

    setLoading(els.createBtn, true);
    try {
      const data = await api('/api/games', {
        method: 'POST',
        body: JSON.stringify({ choice, wager }),
      });
      if (data.user) {
        state.user = data.user;
        // This newly-created game holds the wager in escrow, so a $0 balance
        // here is not a loss.
        state.ownOpenGamesCount = Math.max(1, Number(state.ownOpenGamesCount) || 0);
        updateTopbar();
      }
      els.wagerInput.value = '';
      updateWagerLimitUI();
      showFeedback(els.createFeedback, 'Game created. Waiting for an opponent…', 'success');
      // Refresh open games and the user's games immediately
      refreshOpenGames();
      refreshMyGames();
      refreshMe();
    } catch (err) {
      showFeedback(els.createFeedback, err.message, 'error');
    } finally {
      setLoading(els.createBtn, false);
    }
  }

  // -------------------------------------------------------------------
  // Cancel game
  // -------------------------------------------------------------------
  async function handleCancelGame(gameId, btn) {
    if (isEliminated()) {
      showFeedback(els.createFeedback, 'You Lost! You cannot cancel games.', 'error');
      return;
    }
    if (!gameId || !confirm('Cancel this open game and refund the wager?')) return;
    setLoading(btn, true);
    try {
      const data = await api(`/api/games/${gameId}/cancel`, { method: 'POST' });
      if (data.user) {
        state.user = data.user;
        await refreshOwnOpenGamesCount();
        updateTopbar();
      }
      showFeedback(els.createFeedback, 'Game cancelled and wager refunded.', 'success');
      setTimeout(() => clearFeedback(els.createFeedback), 20000);
      refreshOpenGames().catch(() => {});
      refreshMyGames().catch(() => {});
    } catch (err) {
      showFeedback(els.createFeedback, err.message, 'error');
      setTimeout(() => clearFeedback(els.createFeedback), 20000);
      refreshMyGames().catch(() => {});
    } finally {
      setLoading(btn, false);
    }
  }

  // -------------------------------------------------------------------
  // Join game (with flip animation)
  // -------------------------------------------------------------------
  async function handleJoinGame(gameId, btn) {
    if (isEliminated()) {
      showFeedback(els.createFeedback, 'You Lost! You cannot join games.', 'error');
      return;
    }
    if (state.isFlipping) return;
    state.isFlipping = true;
    setLoading(btn, true);
    openFlipModal();

    try {
      const data = await api(`/api/games/${gameId}/join`, { method: 'POST' });
      lastModalGameId = data.game.id;
      els.flipSub.textContent = 'Here it goes…';
      // Brief beat so the user reads the subtitle change
      await wait(350);
      await animateFlip(data.game.result);
      revealFlipResult(data);
    } catch (err) {
      closeFlipModal();
      showFeedback(els.createFeedback, err.message, 'error');
      // Refresh in case the game was taken by someone else
      refreshOpenGames();
    } finally {
      state.isFlipping = false;
      setLoading(btn, false);
    }
  }

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function openFlipModal() {
    // Reset state
    els.flipResult.hidden = true;
    els.flipSub.textContent = 'Server is choosing the result…';
    const inner = els.flipCoinInner;
    inner.style.removeProperty('--final-y');
    inner.style.removeProperty('--toss-duration');
    inner.style.transform = '';
    els.flipCoin.classList.remove('is-tossing');
    els.flipCoin.classList.add('is-waiting');

    els.flipModal.hidden = false;
    els.flipModal.setAttribute('aria-hidden', 'false');
  }

  function animateFlip(result) {
    return new Promise(resolve => {
      const inner = els.flipCoinInner;
      const coin  = els.flipCoin;

      // Heads = even number of half-turns (lands face up).
      // Tails = odd number of half-turns. Multiply by 360 for a clean
      // multi-rotation finish, then add 180 for tails.
      const finalY = (result === 'heads') ? '2160deg' : '2340deg';
      const dur    = Math.min(Number(CONFIG.DEFAULT_FLIP_DURATION_MS) || 2600, 2800);

      inner.style.setProperty('--final-y', finalY);
      inner.style.setProperty('--toss-duration', `${dur}ms`);
      coin.style.setProperty('--toss-duration', `${dur}ms`);

      coin.classList.remove('is-waiting');
      // Force reflow so animation restarts cleanly
      void coin.offsetWidth;
      coin.classList.add('is-tossing');

      els.flipSub.textContent = 'Tossing…';

      setTimeout(resolve, dur + 30);
    });
  }

  function revealFlipResult(data) {
    if (!state.user) return;
    const game = data.game;
    const myId = state.user.id;
    const isCreator = (game.creator_id === myId);
    const myPick    = isCreator ? game.creator_choice : (game.creator_choice === 'heads' ? 'tails' : 'heads');
    const won       = (game.winner_id === myId);
    const wager     = Number(game.wager);

    const newBalance = data.user ? data.user.balance : data.balance;
    const hitZero = !won && Number(newBalance) <= 0;

    els.flipSub.textContent = won ? 'You won!' : (hitZero ? 'You Lost!' : 'You lost.');
    els.resultSide.textContent    = capitalize(game.result);
    els.resultPick.textContent    = capitalize(myPick);
    els.resultOutcome.textContent = won ? 'You won' : (hitZero ? 'You Lost!' : 'You lost');
    els.resultAmount.textContent  = won ? `+${formatMoney(wager * 2)}` : (hitZero ? 'You Lost!' : `−${formatMoney(wager)}`);
    els.resultBalance.textContent = formatMoney(newBalance);

    // Color the result rows
    const allRows = els.flipResult.querySelectorAll('.result-row');
    allRows.forEach(r => r.classList.remove('row-win', 'row-loss'));
    const outcomeRow = els.resultOutcome.closest('.result-row');
    const amountRow  = els.resultAmount.closest('.result-row');
    if (outcomeRow) outcomeRow.classList.add(won ? 'row-win' : 'row-loss');
    if (amountRow)  amountRow.classList.add(won ? 'row-win' : 'row-loss');

    els.flipResult.hidden = false;

    // Update local user balance from server response. Older backend responses
    // returned { balance }; newer ones may return { user }.
    if (data.user) {
      state.user = data.user;
      updateTopbar();
    } else if (state.user && Number.isFinite(Number(data.balance))) {
      state.user = { ...state.user, balance: Number(data.balance) };
      updateTopbar();
    }
    // The game is now in completed state — record it as already seen so
    // the result banner doesn't double-fire on the next poll.
    if (state.seenCompletedIds) state.seenCompletedIds.add(game.id);

    // Refresh other panels in the background
    refreshOpenGames().catch(() => {});
    refreshMyGames().catch(() => {});
    refreshLeaderboard().catch(() => {});
  }

  function closeFlipModal() {
    els.flipModal.hidden = true;
    els.flipModal.setAttribute('aria-hidden', 'true');
    els.flipCoin.classList.remove('is-tossing', 'is-waiting');
    els.flipResult.hidden = true;
  }

  // -------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------
  function wireEvents() {
    // Auth tabs
    els.authTabs.forEach(t => {
      on(t, 'click', () => switchAuthTab(t.dataset.authTab));
    });
    // Main tabs
    els.mainTabs.forEach(t => {
      on(t, 'click', () => switchMainTab(t.dataset.mainTab));
    });

    // Auth forms
    on(els.formLogin, 'submit', handleLogin);
    on(els.formSignup, 'submit', handleSignup);
    on(els.logoutBtn, 'click', handleLogout);
    on(els.lostSignout, 'click', handleLogout);
    on(els.themeToggle, 'click', toggleTheme);

    // Create
    on(els.formCreateGame, 'submit', handleCreateGame);
    on(els.wagerInput, 'beforeinput', (e) => {
      if (e.data && /[^0-9]/.test(e.data)) e.preventDefault();
    });
    on(els.wagerInput, 'input', () => sanitizeIntegerInput(els.wagerInput, { clampMax: true }));
    on(els.filterMin, 'input', () => sanitizeIntegerInput(els.filterMin));
    on(els.filterMax, 'input', () => sanitizeIntegerInput(els.filterMax));

    // Open games filters / refresh
    on(els.applyFilters, 'click', applyFilters);
    on(els.clearFilters, 'click', clearFilters);
    on(els.refreshGames, 'click', () => refreshOpenGames());
    on(els.gamesPrev, 'click', () => { if (state.pages.lobby > 1) { state.pages.lobby -= 1; refreshOpenGames(); } });
    on(els.gamesNext, 'click', () => { state.pages.lobby += 1; refreshOpenGames(); });

    // My games refresh
    on(els.refreshMy, 'click', () => refreshMyGames());
    on(els.myPrev, 'click', () => { if (state.pages.my > 1) { state.pages.my -= 1; refreshMyGames(); } });
    on(els.myNext, 'click', () => { state.pages.my += 1; refreshMyGames(); });

    // Leaderboard refresh
    on(els.refreshLb, 'click', () => refreshLeaderboard());
    on(els.lbPrev, 'click', () => { if (state.pages.leaderboard > 1) { state.pages.leaderboard -= 1; refreshLeaderboard(); } });
    on(els.lbNext, 'click', () => { state.pages.leaderboard += 1; refreshLeaderboard(); });

    // Result banner
    on(els.resultBannerClose, 'click', hideResultBanner);

    // Flip modal close
    on(els.flipCloseBtn, 'click', closeFlipModal);

    // [data-action] navigation
    on(document.body, 'click', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const action = t.getAttribute('data-action');
      if (action === 'goto-app') {
        e.preventDefault();
        if (state.user) showDashboardView();
      }
    });

    // Refresh data when tab becomes visible again
    on(document, 'visibilitychange', () => {
      if (document.hidden) return;
      if (!state.user) return;
      refreshMyGames({ forNotification: true, silent: true }).catch(() => {});
      if (state.activeMainTab === 'lobby') refreshOpenGames({ silent: true }).catch(() => {});
      if (state.activeMainTab === 'leaderboard') refreshLeaderboard({ silent: true }).catch(() => {});
    });
  }

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------
  async function boot() {
    captureElements();
    applyTheme(state.theme);
    if (!assertRequiredElements()) {
      document.body.dataset.config = 'error';
      return;
    }
    wireEvents();
    document.body.dataset.config = 'ready';

    if (!state.token) {
      showAuthView();
      return;
    }
    // Try to restore the session
    try {
      const data = await api('/api/me');
      setSession(state.token, data.user);
      enterDashboard();
    } catch {
      clearSession();
      showAuthView();
    }
  }

  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', boot);
  } else {
    boot();
  }
})();