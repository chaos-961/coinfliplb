/* =====================================================================
   Coinflip LB — app.js (v1.4)
   ---------------------------------------------------------------------
   Single-file SPA logic. No frameworks. Cleaned up from v1.3:
   - Fixed flip result text (no "You Lost!" in the Gold change row)
   - Fixed wager-input placeholder text
   - Aligned status class names with the rebuilt stylesheet
   - Removed double-toast (showFeedback no longer also fires a toast)
   - Removed dead reference to lost-card sign-out (button removed in HTML)
   - Cleaner button loading state (CSS spinner instead of replacing text)
   ===================================================================== */
(function () {
  'use strict';

  const CONFIG = window.CONFIG;
  if (!CONFIG || !CONFIG.API_BASE_URL) {
    console.error('CONFIG missing or invalid. Check config.js loads before app.js.');
    return;
  }
  const API = String(CONFIG.API_BASE_URL).replace(/\/+$/, '');
  const TOKEN_KEY = 'cfa_token';
  const THEME_KEY = 'cfa_theme';
  const SEEN_COMPLETED_PREFIX = 'cfa_seen_completed_';
  const PENDING_CREATED_PREFIX = 'cfa_pending_created_';

  const CLIENT_ACTION_COOLDOWNS = {
    create: 2600,
    join: 1900,
    cancel: 1700,
    refresh: 900,
  };
  const actionCooldowns = new Map();
  const pendingActions = new Set();
  const pendingGetRequests = new Map();

  const tokenStorage = window.sessionStorage;
  function loadStoredToken() {
    return tokenStorage.getItem(TOKEN_KEY) || null;
  }

  const state = {
    token:          loadStoredToken(),
    user:           null,
    activeAuthTab:  'login',
    activeMainTab:  'lobby',
    filters:        {},
    pages:          { lobby: 1, my: 1, leaderboard: 1 },
    totals:         { lobby: 0, my: 0, leaderboard: 0 },
    pageSize:       { lobby: 20, my: 20, leaderboard: 20 },
    isFlipping:     false,
    pollTimer:      null,
    presenceTimer:  null,
    eventSource:    null,
    pollTick:       0,
    profileStats:   null,
    bannerTimer:    null,
    seenCompletedIds: null,
    pendingCreatedGameIds: null,
    lastBannerGameId: null,
    ownOpenGamesCount: null,
    ownLockedGold:    0,
    theme:          localStorage.getItem(THEME_KEY) || 'dark',
    runtimeConfig:  null,
  };

  const $  = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const els = {};

  function on(el, eventName, handler, options) {
    if (!el) return;
    el.addEventListener(eventName, handler, options);
  }

  function captureElements() {
    Object.assign(els, {
      topbar:           $('#topbar'),
      brandName:        $('#brand-name'),
      balancePill:      $('#balance-pill'),
      balanceValue:     $('#balance-value'),
      userName:         $('#user-name'),
      onlinePill:       $('#online-pill'),
      onlineCount:      $('#online-count'),
      logoutBtn:        $('#logout-btn'),
      themeToggle:      $('#theme-toggle'),
      themeToggleAuth:  $('#theme-toggle-auth'),
      themeIconPath:    $('#theme-icon-path'),
      themeIconPathAuth:$('#theme-icon-path-auth'),
      toastStack:       $('#toast-stack'),
      lostCard:         $('#lost-card'),

      viewAuth:      $('#view-auth'),
      viewDashboard: $('#view-dashboard'),

      formLogin:        $('#form-login'),
      formSignup:       $('#form-signup'),
      loginUsername:    $('#login-username'),
      loginPassword:    $('#login-password'),
      signupUsername:   $('#signup-username'),
      signupPassword:   $('#signup-password'),
      signupConfirm:    $('#signup-confirm'),
      passwordMeter:    $('#password-meter'),
      passwordMeterFill:$('#password-meter-fill'),
      passwordMeterText:$('#password-meter-text'),
      loginBtn:         $('#login-btn'),
      signupBtn:        $('#signup-btn'),
      loginFeedback:    $('#login-feedback'),
      signupFeedback:   $('#signup-feedback'),

      lockedPill:        $('#locked-pill'),
      lockedValue:       $('#locked-value'),

      resultBanner:      $('#result-banner'),
      resultBannerCoin:  $('#result-banner-coin'),
      resultBannerTitle: $('#result-banner-title'),
      resultBannerSub:   $('#result-banner-sub'),
      resultBannerClose: $('#result-banner-close'),

      formCreateGame: $('#form-create-game'),
      wagerInput:     $('#wager-input'),
      wagerHint:      $('#wager-hint'),
      createBtn:      $('#create-btn'),
      createFeedback: $('#create-feedback'),

      mainTabs:    $$('.main-tabs .tab'),
      authTabs:    $$('.auth-tabs .tab'),
      myGamesBadge:$('#my-games-badge'),

      panelLobby:       $('#panel-lobby'),
      panelMy:          $('#panel-my'),
      panelLeaderboard: $('#panel-leaderboard'),

      gamesRows:    $('#games-rows'),
      gamesEmpty:   $('#games-empty'),
      gamesLoading: $('#games-loading'),
      filterMin:    $('#filter-min'),
      filterMax:    $('#filter-max'),
      applyFilters: $('#apply-filters'),
      clearFilters: $('#clear-filters'),
      refreshGames: $('#refresh-games'),
      gamesPager:   $('#games-pager'),
      gamesPrev:    $('#games-prev'),
      gamesNext:    $('#games-next'),
      gamesPageInfo:$('#games-page-info'),

      myRows:    $('#my-rows'),
      myEmpty:   $('#my-empty'),
      myLoading: $('#my-loading'),
      refreshMy: $('#refresh-my'),
      myPager:   $('#my-pager'),
      myPrev:    $('#my-prev'),
      myNext:    $('#my-next'),
      myPageInfo:$('#my-page-info'),

      lbRows:    $('#lb-rows'),
      lbEmpty:   $('#lb-empty'),
      lbLoading: $('#lb-loading'),
      refreshLb: $('#refresh-lb'),
      lbPager:   $('#lb-pager'),
      lbPrev:    $('#lb-prev'),
      lbNext:    $('#lb-next'),
      lbPageInfo:$('#lb-page-info'),

      flipModal:     $('#flip-modal'),
      flipTitle:     $('#flip-title'),
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

      profileModal:    $('#profile-modal'),
      profileTitle:    $('#profile-title'),
      profileClose:    $('#profile-close'),
      profileBalance:  $('#profile-balance'),
      profileAge:      $('#profile-age'),
      profileStreak:   $('#profile-streak'),
      profileMaxStreak:$('#profile-max-streak'),
      profileRecord:   $('#profile-record'),
      profileRatio:    $('#profile-ratio'),
      profileNote:     $('#profile-note'),

      confirmModal: $('#confirm-modal'),
      confirmTitle: $('#confirm-title'),
      confirmBody:  $('#confirm-body'),
      confirmYes:   $('#confirm-yes'),
      confirmNo:    $('#confirm-no'),

      tplGameRow: $('#tpl-game-row'),
      tplMyRow:   $('#tpl-my-row'),
      tplLbRow:   $('#tpl-lb-row'),
    });

    if (els.brandName) els.brandName.textContent = CONFIG.APP_NAME || 'Coinflip LB';
  }

  // ---------- Throttling ----------
  function remainingCooldownMs(key) {
    return Math.max(0, (actionCooldowns.get(key) || 0) - Date.now());
  }
  function startClientCooldown(key, ms, message) {
    if (!key || !ms) return true;
    const remaining = remainingCooldownMs(key);
    if (remaining > 0) {
      if (message) showToast(`${message} (${Math.ceil(remaining / 1000)}s)`, 'info', { timeout: 2200 });
      return false;
    }
    actionCooldowns.set(key, Date.now() + ms);
    return true;
  }
  function beginClientAction(key, ms, message) {
    if (pendingActions.has(key)) {
      if (message) showToast(message, 'info', { timeout: 2200 });
      return null;
    }
    if (!startClientCooldown(key, ms, message)) return null;
    pendingActions.add(key);
    return () => pendingActions.delete(key);
  }
  function clearClientReadCache() { pendingGetRequests.clear(); }
  function cloneJson(value) {
    if (value == null) return value;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
  }
  function runThrottled(key, ms, fn) {
    if (!startClientCooldown(`refresh:${key}`, ms || CLIENT_ACTION_COOLDOWNS.refresh, 'Refreshing too fast')) return;
    return fn();
  }

  // ---------- API ----------
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.data = data;
    }
  }

  async function api(path, opts = {}) {
    const method = opts.method || 'GET';
    const dedupeKey = method === 'GET' ? path : null;

    if (dedupeKey && pendingGetRequests.has(dedupeKey)) {
      return cloneJson(await pendingGetRequests.get(dedupeKey));
    }

    const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    if (state.token && !opts.skipAuth) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    const performRequest = (async () => {
      let res;
      try {
        res = await fetch(API + path, { method, headers, body: opts.body, cache: 'no-store' });
      } catch {
        throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0, null);
      }
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { data = await res.json(); } catch { data = null; }
      }
      if (!res.ok) {
        const msg = (data && data.error) ? data.error : `Request failed (${res.status})`;
        if (res.status === 401 && state.token) {
          clearSession();
          showAuthView();
          showFeedback(els.loginFeedback, 'Your session expired. Please sign in again.', 'info');
        }
        if (res.status === 429) {
          showToast(msg || 'Slow down a bit.', 'error', { timeout: 4200 });
        }
        throw new ApiError(msg, res.status, data);
      }
      return data;
    })();

    if (dedupeKey) pendingGetRequests.set(dedupeKey, performRequest);
    try {
      return cloneJson(await performRequest);
    } finally {
      if (dedupeKey) pendingGetRequests.delete(dedupeKey);
    }
  }

  // ---------- Inline feedback (NO automatic toast) ----------
  function showFeedback(el, message, type = 'info') {
    if (!el || !message) return;
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

  function showToast(message, type = 'info', { timeout = 4500 } = {}) {
    if (!els.toastStack || !message) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'success' ? '✓' : (type === 'error' ? '!' : 'i');

    const text = document.createElement('div');
    text.className = 'toast-msg';
    text.textContent = String(message);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(close);
    els.toastStack.appendChild(toast);

    const dismiss = () => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 200);
    };
    close.addEventListener('click', dismiss);
    if (timeout > 0) setTimeout(dismiss, timeout);
  }

  // ---------- Loading state ----------
  function setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('is-loading', !!loading);
    btn.disabled = !!loading;
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

    if (loading) {
      target.loading.innerHTML = isError
        ? `<div style="padding:18px;text-align:center;">${label}</div>`
        : Array.from({ length: kind === 'lb' ? 5 : 4 }, () =>
          '<div class="skeleton-row"><span class="skeleton-dot"></span><span class="skeleton-line"></span><span class="skeleton-pill"></span></div>'
        ).join('');
      if (!isError && target.empty) target.empty.hidden = true;
      if (target.rows) target.rows.setAttribute('aria-busy', 'true');
    } else {
      target.loading.innerHTML = '';
      if (target.rows) target.rows.setAttribute('aria-busy', 'false');
    }
  }

  // ---------- Formatting ----------
  function formatMoney(value) {
    const n = Math.max(0, Math.floor(Number(value || 0)));
    return `${n.toLocaleString('en-US')} Gold`;
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
  function formatAccountAge(dateInput) {
    if (!dateInput) return '—';
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) return '—';
    const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
    if (days === 0) return 'Today';
    if (days === 1) return '1 day';
    return `${days.toLocaleString('en-US')} days`;
  }
  function formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0%';
    return `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function compactMoney(value) {
    const n = Number(value || 0);
    return `${Math.floor(n).toLocaleString('en-US')} Gold`;
  }

  function passwordStrength(password) {
    let score = 0;
    if (password.length >= getMinPasswordLength()) score += 1;
    if (password.length >= 10) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;
    return Math.min(score, 5);
  }
  function getMinPasswordLength() {
    return Number((state.runtimeConfig && state.runtimeConfig.minPasswordLength) || CONFIG.MIN_PASSWORD_LENGTH) || 6;
  }
  function updatePasswordMeter() {
    if (!els.passwordMeter || !els.passwordMeterFill || !els.passwordMeterText) return;
    const password = els.signupPassword ? els.signupPassword.value || '' : '';
    if (!password) {
      els.passwordMeter.hidden = true;
      return;
    }
    const score = passwordStrength(password);
    const labels = ['Too weak', 'Weak', 'Okay', 'Good', 'Strong', 'Excellent'];
    els.passwordMeter.hidden = false;
    els.passwordMeter.dataset.score = String(score);
    els.passwordMeterFill.style.width = `${Math.max(8, score * 20)}%`;
    els.passwordMeterText.textContent = labels[score];
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

  // ---------- Confirm modal ----------
  let confirmResolver = null;
  function confirmModal({ title, body, confirmText, cancelText, danger = true } = {}) {
    return new Promise((resolve) => {
      els.confirmTitle.textContent = title || 'Are you sure?';
      els.confirmBody.textContent  = body  || '';
      els.confirmYes.textContent   = confirmText || 'Yes';
      els.confirmNo.textContent    = cancelText  || 'No';
      els.confirmYes.classList.toggle('btn-danger', !!danger);
      els.confirmYes.classList.toggle('btn-primary', !danger);
      els.confirmModal.hidden = false;
      els.confirmModal.setAttribute('aria-hidden', 'false');
      confirmResolver = resolve;
      setTimeout(() => els.confirmNo.focus(), 30);
    });
  }
  function closeConfirmModal(answer) {
    els.confirmModal.hidden = true;
    els.confirmModal.setAttribute('aria-hidden', 'true');
    if (confirmResolver) {
      const r = confirmResolver;
      confirmResolver = null;
      r(answer);
    }
  }

  // ---------- Helpers (lost-state, theme, wager) ----------
  function hasOwnOpenGames() { return Number(state.ownOpenGamesCount) > 0; }

  function updateLockedPill() {
    if (!els.lockedPill) return;
    const locked = Math.max(0, Math.floor(Number(state.ownLockedGold) || 0));
    if (!state.user || locked <= 0) {
      els.lockedPill.hidden = true;
      return;
    }
    els.lockedPill.hidden = false;
    if (els.lockedValue) els.lockedValue.textContent = `${formatMoney(locked)} locked`;
    els.lockedPill.title = `${formatMoney(locked)} reserved in your open games. Cancel a game to free it up.`;
  }

  function isEliminated() {
    if (!state.user) return false;
    const balance = Number(state.user.balance);
    if (!Number.isFinite(balance) || balance > 0) return false;
    if (state.ownOpenGamesCount === null) return false;
    return !hasOwnOpenGames();
  }

  function applyEliminatedState() {
    const lost = isEliminated();
    document.body.classList.toggle('is-eliminated', lost);
    if (els.lostCard) els.lostCard.hidden = !lost;

    if (els.createFeedback && lost) {
      showFeedback(els.createFeedback, "You're out of Gold. You can still browse games and the leaderboard. Sign out and create a new account to play again.", 'error');
    } else if (els.createFeedback && !lost && /out of Gold|reached 0 Gold/i.test(els.createFeedback.textContent || '')) {
      clearFeedback(els.createFeedback);
    }
  }

  const SUN_PATH  = 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66l1.42-1.42M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14l-1.42-1.42M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z';
  const MOON_PATH = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';

  function applyTheme(theme) {
    const next = (theme === 'light') ? 'light' : 'dark';
    state.theme = next;
    document.body.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    const path = next === 'light' ? MOON_PATH : SUN_PATH;
    const label = next === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    if (els.themeIconPath)     els.themeIconPath.setAttribute('d', path);
    if (els.themeIconPathAuth) els.themeIconPathAuth.setAttribute('d', path);
    [els.themeToggle, els.themeToggleAuth].forEach(btn => {
      if (btn) {
        btn.title = label;
        btn.setAttribute('aria-label', label);
      }
    });
  }
  function toggleTheme() { applyTheme(state.theme === 'light' ? 'dark' : 'light'); }

  function getMaxAllowedWager() {
    const cfgMax = Number((state.runtimeConfig && state.runtimeConfig.maxWager) || CONFIG.MAX_WAGER) || Number.MAX_SAFE_INTEGER;
    const balance = state.user ? Number(state.user.balance) : cfgMax;
    const safeBalance = Number.isFinite(balance) ? Math.max(0, balance) : 0;
    return Math.max(0, Math.min(cfgMax, safeBalance));
  }
  function getMinWager() {
    return Number((state.runtimeConfig && state.runtimeConfig.minWager) || CONFIG.MIN_WAGER) || 1;
  }
  function updateWagerLimitUI() {
    if (!els.wagerInput) return;
    const min = getMinWager();
    const max = getMaxAllowedWager();
    const lost = isEliminated();
    const unavailable = max < min;

    if (els.wagerHint) {
      els.wagerHint.textContent = '';
      els.wagerHint.hidden = true;
    }

    if (max >= min) {
      els.wagerInput.placeholder = `${compactMoney(min)} – ${compactMoney(max)}`;
    } else if (lost) {
      els.wagerInput.placeholder = 'Out of Gold';
    } else if (hasOwnOpenGames()) {
      els.wagerInput.placeholder = 'Gold reserved';
    } else {
      els.wagerInput.placeholder = 'No Gold available';
    }

    const createDisabled = lost || unavailable;
    els.wagerInput.disabled = createDisabled;
    if (els.createBtn) els.createBtn.disabled = createDisabled;
    if (els.formCreateGame) {
      els.formCreateGame.querySelectorAll('input[name="choice"]').forEach(input => {
        input.disabled = createDisabled;
      });
    }
  }

  // ---------- Notification storage ----------
  function idSetFromStorage(key) {
    try {
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : []);
    } catch { return new Set(); }
  }
  function saveIdSet(key, set, limit = 120) {
    try {
      const list = Array.from(set).map(Number).filter(Number.isFinite).slice(-limit);
      localStorage.setItem(key, JSON.stringify(list));
    } catch {}
  }
  function seenCompletedKey() { return state.user ? `${SEEN_COMPLETED_PREFIX}${state.user.id}` : null; }
  function pendingCreatedKey() { return state.user ? `${PENDING_CREATED_PREFIX}${state.user.id}` : null; }
  function loadNotificationSets() {
    state.seenCompletedIds = seenCompletedKey() ? idSetFromStorage(seenCompletedKey()) : new Set();
    state.pendingCreatedGameIds = pendingCreatedKey() ? idSetFromStorage(pendingCreatedKey()) : new Set();
  }
  function saveSeenCompletedIds() {
    const key = seenCompletedKey();
    if (key && state.seenCompletedIds) saveIdSet(key, state.seenCompletedIds);
  }
  function savePendingCreatedIds() {
    const key = pendingCreatedKey();
    if (key && state.pendingCreatedGameIds) saveIdSet(key, state.pendingCreatedGameIds, 60);
  }
  function trackCreatedGameForNotification(gameId) {
    if (!gameId) return;
    if (!state.pendingCreatedGameIds) loadNotificationSets();
    state.pendingCreatedGameIds.add(Number(gameId));
    savePendingCreatedIds();
  }

  // ---------- Session ----------
  function setSession(token, user) {
    state.token = token;
    state.user  = user;
    if (token) tokenStorage.setItem(TOKEN_KEY, token);
    if (user) loadNotificationSets();
    updateTopbar();
  }
  function clearSession() {
    state.token = null;
    state.user  = null;
    state.seenCompletedIds = null;
    state.pendingCreatedGameIds = null;
    state.lastBannerGameId = null;
    state.ownOpenGamesCount = null;
    state.ownLockedGold = 0;
    tokenStorage.removeItem(TOKEN_KEY);
    stopPolling();
    stopPresence();
    stopEvents();
    updateTopbar();
  }
  function updateTopbar() {
    const signedIn = !!state.user;
    if (!signedIn) {
      if (els.topbar) els.topbar.hidden = true;
      if (els.balancePill) els.balancePill.hidden = true;
      if (els.lockedPill) els.lockedPill.hidden = true;
      if (els.userName) els.userName.hidden = true;
      if (els.onlinePill) els.onlinePill.hidden = true;
      if (els.logoutBtn) els.logoutBtn.hidden = true;
      updateWagerLimitUI();
      applyEliminatedState();
      return;
    }
    els.topbar.hidden = false;
    els.balancePill.hidden = false;
    els.balanceValue.textContent = formatMoney(state.user.balance);
    els.balancePill.setAttribute('aria-label', `Gold balance ${formatMoney(state.user.balance)}`);
    els.userName.hidden = false;
    els.userName.textContent = state.user.username;
    if (els.onlinePill) els.onlinePill.hidden = false;
    els.logoutBtn.hidden = false;
    updateLockedPill();
    updateWagerLimitUI();
    applyEliminatedState();
  }

  // ---------- View switching ----------
  function showAuthView() {
    document.body.dataset.view = 'auth';
    els.viewAuth.hidden = false;
    els.viewDashboard.hidden = true;
    els.topbar.hidden = !state.user;
    if (els.themeToggleAuth) els.themeToggleAuth.hidden = false;
  }
  function showDashboardView() {
    document.body.dataset.view = 'dashboard';
    els.viewAuth.hidden = true;
    els.viewDashboard.hidden = false;
    els.topbar.hidden = false;
    if (els.themeToggleAuth) els.themeToggleAuth.hidden = true;
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
    updatePasswordMeter();
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

    if (name === 'my') hideMyGamesBadge();
    if (name === 'lobby')       refreshOpenGames().catch(() => {});
    if (name === 'my')          refreshMyGames().catch(() => {});
    if (name === 'leaderboard') refreshLeaderboard().catch(() => {});
  }

  // ---------- Auth handlers ----------
  async function handleSignup(e) {
    e.preventDefault();
    clearFeedback(els.signupFeedback);

    const username = (els.signupUsername.value || '').trim();
    const password = els.signupPassword.value || '';
    const confirm  = els.signupConfirm.value  || '';

    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9_.\-]*[a-zA-Z0-9])?$/.test(username) || username.length < 3 || username.length > 32 || /[._-]{2,}/.test(username)) {
      showFeedback(els.signupFeedback, "Username must be 3–32 characters using letters, numbers, _, ., or -.", 'error');
      return;
    }
    const minPasswordLength = getMinPasswordLength();
    if (password.length < minPasswordLength) {
      showFeedback(els.signupFeedback, `Password must be at least ${minPasswordLength} characters.`, 'error');
      return;
    }
    if (state.runtimeConfig?.requireStrongPassword && !(/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password))) {
      showFeedback(els.signupFeedback, 'Password must include lowercase, uppercase, and a number.', 'error');
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

  async function handleLogout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    clearSession();
    showAuthView();
    switchAuthTab('login');
    els.formLogin.reset();
    els.formSignup.reset();
    hideResultBanner();
  }

  // ---------- Runtime config ----------
  async function loadRuntimeConfig() {
    try {
      const data = await api('/api/config', { skipAuth: true });
      state.runtimeConfig = data;
      updateWagerLimitUI();
    } catch (err) {
      console.warn('[loadRuntimeConfig] using client defaults:', err.message);
    }
  }

  // ---------- Dashboard entry & polling ----------
  async function enterDashboard() {
    showDashboardView();
    switchMainTab('lobby');
    loadNotificationSets();

    await Promise.allSettled([
      refreshMe(),
      refreshMyGames({ skipCompletionDetection: true }),
      refreshCompletedNotifications({ initial: true }),
      heartbeatPresence(),
    ]);
    startEvents();
    startPolling();
    startPresence();
  }

  async function refreshMe() {
    try {
      const data = await api('/api/me');
      state.user = data.user;
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

      refreshMyGames({ silent: true, forNotification: true }).catch(() => {});

      if (state.activeMainTab === 'lobby') refreshOpenGames({ silent: true }).catch(() => {});
      if (state.activeMainTab === 'leaderboard' && state.pollTick % 4 === 0) refreshLeaderboard({ silent: true }).catch(() => {});
      if (state.pollTick % 8 === 0) heartbeatPresence().catch(() => {});
      refreshMe().catch(() => {});
    }, Math.max(2500, Number(CONFIG.POLLING_INTERVAL_MS) || 4000));
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function startEvents() {
    stopEvents();
    if (!state.token || !window.EventSource) return;
    const url = `${API}/api/events?token=${encodeURIComponent(state.token)}`;
    const es = new EventSource(url);
    state.eventSource = es;

    es.addEventListener('game_joined', (event) => {
      try {
        const data = JSON.parse(event.data || '{}');
        clearClientReadCache();
        if (data.user) {
          state.user = data.user;
          updateTopbar();
        }
        if (data.game) {
          refreshOpenGames({ silent: true }).catch(() => {});
          refreshMyGames({ silent: true, forNotification: true, skipCompletionDetection: true }).catch(() => {});
          showCreatorFlip(data.game, data.user || null).catch(() => showResultBanner(data.game));
        }
      } catch (err) {
        console.warn('[events]', err);
      }
    });
  }
  function stopEvents() {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch {}
      state.eventSource = null;
    }
  }

  async function heartbeatPresence() {
    if (!state.user || document.hidden) return;
    try {
      const data = await api('/api/presence/heartbeat', { method: 'POST' });
      const n = Math.max(0, Number(data.online || 0));
      if (els.onlineCount) els.onlineCount.textContent = `${n.toLocaleString('en-US')} online`;
      if (els.onlinePill) els.onlinePill.hidden = false;
    } catch {
      if (els.onlinePill) els.onlinePill.hidden = true;
    }
  }
  function startPresence() {
    stopPresence();
    heartbeatPresence().catch(() => {});
    state.presenceTimer = setInterval(() => {
      if (!state.user || document.hidden) return;
      heartbeatPresence().catch(() => {});
    }, 45000);
  }
  function stopPresence() {
    if (state.presenceTimer) clearInterval(state.presenceTimer);
    state.presenceTimer = null;
  }

  async function refreshOwnOpenGamesCount() {
    if (!state.user) {
      state.ownOpenGamesCount = null;
      state.ownLockedGold = 0;
      return 0;
    }
    try {
      const data = await api('/api/me/games?status=open&page=1&limit=10');
      const count = Number(data.total);
      state.ownOpenGamesCount = Number.isFinite(count) ? count : ((data.games || []).length);
      const locked = (data.games || []).reduce((sum, g) => sum + Number(g.wager || 0), 0);
      state.ownLockedGold = Number.isFinite(locked) ? locked : 0;
      updateLockedPill();
      return state.ownOpenGamesCount;
    } catch (err) {
      console.warn('[refreshOwnOpenGamesCount]', err);
      if (state.ownOpenGamesCount === null) return 0;
      return state.ownOpenGamesCount;
    }
  }

  // ---------- Open games ----------
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
    } catch {
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

      const avatar = $('.avatar', node);
      if (avatar && g.creator_username) {
        avatar.textContent = String(g.creator_username).charAt(0).toUpperCase();
      }

      const pickCoin = $('.game-pick-coin', node);
      if (pickCoin) {
        const side = (g.creator_choice === 'tails') ? 'tails' : 'heads';
        pickCoin.classList.toggle('static-coin-heads', side === 'heads');
        pickCoin.classList.toggle('static-coin-tails', side === 'tails');
        const coinText = pickCoin.querySelector('span');
        if (coinText) coinText.textContent = side === 'heads' ? 'H' : 'T';
      }
      $('.pick-label', node).textContent = capitalize(g.creator_choice);
      $('.game-row-wager', node).textContent = formatMoney(g.wager);

      const joinBtn = $('.game-row-join', node);
      const isOwn = (g.creator_id === myId);
      const lost = isEliminated();
      const insufficient = (Number(g.wager) > myBalance);
      if (joinBtn) {
        if (isOwn) {
          joinBtn.textContent = 'Cancel';
          joinBtn.classList.remove('btn-primary');
          joinBtn.classList.add('btn-danger');
          joinBtn.setAttribute('aria-label', 'Cancel your open game');
          on(joinBtn, 'click', () => handleCancelGame(g.id, joinBtn));
        } else if (lost) {
          joinBtn.disabled = true;
          joinBtn.textContent = 'Locked';
          joinBtn.title = 'You can browse, but cannot play after reaching 0 Gold.';
        } else if (insufficient) {
          joinBtn.disabled = true;
          joinBtn.textContent = 'Insufficient';
        } else {
          on(joinBtn, 'click', () => handleJoinGame(g.id, g.wager, joinBtn));
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

  // ---------- My games ----------
  async function refreshMyGames(options = {}) {
    try {
      const page = options.forNotification ? 1 : state.pages.my;
      const limit = options.forNotification ? 20 : state.pageSize.my;
      if (!options.silent) setListLoading('my', true, 'Loading your games…');
      const data = await api(`/api/me/games?page=${page}&limit=${limit}`);
      const games = data.games || [];
      const meta = normalizeMeta(data, games, page, limit);
      if (!options.forNotification) {
        state.totals.my = meta.total;
        if (page > meta.totalPages && meta.totalPages > 0) {
          state.pages.my = meta.totalPages;
          return refreshMyGames(options);
        }
        state.pages.my = Math.min(page, meta.totalPages);
        setListLoading('my', false);
        renderMyGames(games);
        updatePager('my', meta);
      } else if (state.activeMainTab === 'my' && page === state.pages.my) {
        renderMyGames(games);
      }
      processCompletionDetection(games, options);
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
        status.classList.add('status-open');
        detail.innerHTML = '';
        const txt = document.createElement('span');
        txt.textContent = 'You picked ';
        const strong = document.createElement('strong');
        strong.textContent = capitalize(g.creator_choice);
        txt.appendChild(strong);
        detail.appendChild(txt);
        amount.textContent = formatMoney(wager);
        if (isCreator && cancelBtn) {
          cancelBtn.hidden = false;
          cancelBtn.disabled = false;
          cancelBtn.title = 'Cancel this game and refund your wager.';
          on(cancelBtn, 'click', () => handleCancelGame(g.id, cancelBtn));
        }
      } else if (g.status === 'completed') {
        const won = (g.winner_id === myId);
        status.textContent = won ? 'Won' : 'Lost';
        status.classList.add(won ? 'status-win' : 'status-loss');

        detail.innerHTML = '';
        const part1 = document.createElement('span');
        part1.textContent = 'vs ';
        const oppName = document.createElement('strong');
        oppName.textContent = opponent || 'opponent';
        const part2 = document.createElement('span');
        part2.textContent = ` · ${capitalize(g.result)} · you picked ${capitalize(myPick)}`;
        detail.appendChild(part1);
        detail.appendChild(oppName);
        detail.appendChild(part2);

        amount.textContent = won ? `+${formatMoney(wager * 2)}` : `−${formatMoney(wager)}`;
        amount.classList.add(won ? 'amt-gain' : 'amt-loss');
      } else {
        status.textContent = 'Cancelled';
        status.classList.add('status-cancelled');
        detail.textContent = 'No opponent joined.';
        amount.textContent = formatMoney(wager);
      }
      time.textContent = formatRelative(g.completed_at || g.created_at);
      frag.appendChild(node);
    });
    els.myRows.appendChild(frag);
  }

  async function refreshCompletedNotifications(options = {}) {
    if (!state.user) return;
    const data = await api('/api/me/games?status=completed&page=1&limit=20');
    processCompletionDetection(data.games || [], options);
  }

  function processCompletionDetection(games, options = {}) {
    if (!state.user) return;
    if (!state.seenCompletedIds || !state.pendingCreatedGameIds) loadNotificationSets();

    const completed = games.filter(g => g.status === 'completed');
    const completedIds = new Set(completed.map(g => Number(g.id)).filter(Number.isFinite));

    const seenKey = seenCompletedKey();
    const isBrandNewSeenList = state.seenCompletedIds.size === 0 && (!seenKey || !localStorage.getItem(seenKey));
    const pendingOnInitialLoad = completed.filter(g => state.pendingCreatedGameIds.has(Number(g.id)));
    let newOnes = completed.filter(g => !state.seenCompletedIds.has(Number(g.id)));
    if (options.initial && isBrandNewSeenList) {
      newOnes = pendingOnInitialLoad;
    }

    completedIds.forEach(id => state.seenCompletedIds.add(id));
    completedIds.forEach(id => state.pendingCreatedGameIds.delete(id));
    saveSeenCompletedIds();
    savePendingCreatedIds();

    if (newOnes.length === 0) return;

    const fresh = newOnes
      .filter(g => g.id !== state.lastBannerGameId && !justSawInModal(g))
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))[0];

    if (fresh) {
      const myId = state.user.id;
      const isCreatorOfFresh = (fresh.creator_id === myId);
      if (isCreatorOfFresh && !state.isFlipping) {
        showCreatorFlip(fresh).catch(err => {
          console.warn('[showCreatorFlip]', err);
          showResultBanner(fresh);
        });
      } else {
        showResultBanner(fresh);
      }
      refreshMe().catch(() => {});
      refreshOwnOpenGamesCount().then(() => { updateWagerLimitUI(); applyEliminatedState(); }).catch(() => {});
      refreshLeaderboard({ silent: true }).catch(() => {});
      if (state.activeMainTab === 'lobby') refreshOpenGames({ silent: true }).catch(() => {});
      if (state.activeMainTab === 'my') refreshMyGames({ silent: true }).catch(() => {});
    }

    if (state.activeMainTab !== 'my') {
      bumpMyGamesBadge(newOnes.length);
    }
  }

  let lastModalGameId = null;
  function justSawInModal(g) { return lastModalGameId === g.id; }

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

  // ---------- Result banner ----------
  function showResultBanner(g) {
    if (!state.user) return;
    const myId = state.user.id;
    const won  = (g.winner_id === myId);
    const opponent = (g.creator_id === myId) ? g.joiner_username : g.creator_username;
    const wager = Number(g.wager);

    state.lastBannerGameId = g.id;

    els.resultBanner.classList.remove('is-win', 'is-loss');
    els.resultBanner.classList.add(won ? 'is-win' : 'is-loss');

    if (els.resultBannerCoin) {
      const side = (g.result === 'tails') ? 'tails' : 'heads';
      els.resultBannerCoin.classList.toggle('static-coin-heads', side === 'heads');
      els.resultBannerCoin.classList.toggle('static-coin-tails', side === 'tails');
      const coinText = els.resultBannerCoin.querySelector('span');
      if (coinText) coinText.textContent = side === 'heads' ? 'H' : 'T';
    }

    els.resultBannerTitle.textContent = won
      ? `You won ${formatMoney(wager * 2)}!`
      : `You lost ${formatMoney(wager)}.`;

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
    showToast(
      won ? `You won ${formatMoney(wager * 2)}!` : `You lost ${formatMoney(wager)}.`,
      won ? 'success' : 'error',
      { timeout: 6000 }
    );
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

  // ---------- Leaderboard ----------
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
    } catch {
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
      const lbBalance = $('.lb-balance', node);
      const lbRecord = $('.lb-record', node);
      const lbWinrate = $('.lb-winrate', node);
      const st = u.stats || {};
      lbBalance.textContent = formatMoney(u.balance);
      if (lbRecord) lbRecord.textContent = `${Number(st.wins || 0)}W / ${Number(st.losses || 0)}L`;
      if (lbWinrate) lbWinrate.textContent = `${formatPercent(st.win_rate || 0)} win`;
      if (u.rank === 1) node.classList.add('is-rank-1');
      else if (u.rank === 2) node.classList.add('is-rank-2');
      else if (u.rank === 3) node.classList.add('is-rank-3');
      if (u.id === myId) node.classList.add('is-me');
      frag.appendChild(node);
    });
    els.lbRows.appendChild(frag);
  }

  // ---------- Create / Cancel / Join ----------
  async function handleCreateGame(e) {
    e.preventDefault();
    clearFeedback(els.createFeedback);

    if (isEliminated()) {
      showFeedback(els.createFeedback, "You're out of Gold and can't create a game.", 'error');
      return;
    }
    sanitizeIntegerInput(els.wagerInput, { clampMax: true });
    const choice = (els.formCreateGame.querySelector('input[name="choice"]:checked') || {}).value;
    const wager  = parseWholeDollars(els.wagerInput.value);

    if (!choice) {
      showFeedback(els.createFeedback, 'Pick heads or tails.', 'error');
      return;
    }
    const minWager = getMinWager();
    const maxWager = getMaxAllowedWager();
    if (wager === null || wager < minWager || wager > maxWager) {
      showFeedback(els.createFeedback, `Wager must be between ${compactMoney(minWager)} and ${compactMoney(maxWager)}.`, 'error');
      return;
    }

    if (state.user && wager >= 100 && wager >= Math.floor(Number(state.user.balance) * 0.5)) {
      const ok = await confirmModal({
        title: 'Confirm wager',
        body: `You're wagering ${formatMoney(wager)} — that's a big chunk of your balance. Continue?`,
        confirmText: 'Wager it',
        cancelText: 'Back',
        danger: false,
      });
      if (!ok) return;
    }

    const finishAction = beginClientAction('create-game', CLIENT_ACTION_COOLDOWNS.create, 'Creating too fast');
    if (!finishAction) return;

    setLoading(els.createBtn, true);
    try {
      const data = await api('/api/games', {
        method: 'POST',
        body: JSON.stringify({ choice, wager }),
      });
      clearClientReadCache();
      if (data.game) trackCreatedGameForNotification(data.game.id);
      if (data.user) {
        state.user = data.user;
        state.ownOpenGamesCount = Math.max(1, Number(state.ownOpenGamesCount) || 0);
        updateTopbar();
      }
      els.wagerInput.value = '';
      els.formCreateGame.querySelectorAll('input[name="choice"]').forEach(input => { input.checked = false; });
      updateWagerLimitUI();
      showFeedback(els.createFeedback, 'Game created. Waiting for an opponent…', 'success');
      showToast('Game created. Waiting for an opponent…', 'success', { timeout: 3500 });
      refreshOpenGames();
      refreshMyGames();
      refreshMe();
    } catch (err) {
      showFeedback(els.createFeedback, err.message, 'error');
    } finally {
      finishAction();
      setLoading(els.createBtn, false);
      updateWagerLimitUI();
    }
  }

  async function handleCancelGame(gameId, btn) {
    if (!gameId) return;
    const finishAction = beginClientAction(`cancel-game:${gameId}`, CLIENT_ACTION_COOLDOWNS.cancel, 'Cancelling too fast');
    if (!finishAction) return;
    const ok = await confirmModal({
      title: 'Cancel game?',
      body: 'Cancel this open game and refund the wager? You can always create a new one.',
      confirmText: 'Cancel game',
      cancelText: 'Keep game',
      danger: true,
    });
    if (!ok) { finishAction(); return; }
    setLoading(btn, true);
    try {
      const data = await api(`/api/games/${gameId}/cancel`, { method: 'POST' });
      clearClientReadCache();
      if (data.user) {
        state.user = data.user;
        await refreshOwnOpenGamesCount();
        updateTopbar();
      }
      showToast('Game cancelled and wager refunded.', 'success', { timeout: 3500 });
      refreshOpenGames().catch(() => {});
      refreshMyGames().catch(() => {});
    } catch (err) {
      showToast(err.message, 'error', { timeout: 4500 });
      refreshMyGames().catch(() => {});
    } finally {
      finishAction();
      setLoading(btn, false);
    }
  }

  async function handleJoinGame(gameId, wager, btn) {
    if (isEliminated()) {
      showToast("You're out of Gold and can't join games.", 'error');
      return;
    }
    if (state.isFlipping) return;
    const finishAction = beginClientAction(`join-game:${gameId}`, CLIENT_ACTION_COOLDOWNS.join, 'Joining too fast');
    if (!finishAction) return;

    if (state.user && Number(wager) >= 100 && Number(wager) >= Math.floor(Number(state.user.balance) * 0.5)) {
      const ok = await confirmModal({
        title: 'Join this flip?',
        body: `${formatMoney(wager)} on the line. Win or lose, the result is final.`,
        confirmText: 'Flip it',
        cancelText: 'Back',
        danger: false,
      });
      if (!ok) { finishAction(); return; }
    }

    state.isFlipping = true;
    setLoading(btn, true);
    openFlipModal({ title: 'Flipping the coin…', sub: 'Server is choosing the result…' });

    try {
      const data = await api(`/api/games/${gameId}/join`, { method: 'POST' });
      clearClientReadCache();
      lastModalGameId = data.game.id;
      els.flipSub.textContent = 'Here it goes…';
      await wait(350);
      await animateFlip(data.game.result);
      revealFlipResult(data);
    } catch (err) {
      closeFlipModal();
      showToast(err.message, 'error', { timeout: 4500 });
      refreshOpenGames();
    } finally {
      finishAction();
      state.isFlipping = false;
      setLoading(btn, false);
    }
  }

  async function showCreatorFlip(g, freshUser = null) {
    if (!state.user) return;
    state.isFlipping = true;
    state.lastBannerGameId = g.id;
    lastModalGameId = g.id;

    openFlipModal({ title: 'Someone joined your game!', sub: `${g.joiner_username || 'A player'} took your bet…` });

    try {
      await wait(550);
      els.flipSub.textContent = 'Here it goes…';
      await wait(280);
      await animateFlip(g.result);

      const payload = {
        game: g,
        user: freshUser || state.user,
        balance: freshUser ? freshUser.balance : (state.user ? state.user.balance : 0),
      };
      revealFlipResult(payload);
    } catch (err) {
      console.warn('[showCreatorFlip] flip failed', err);
      closeFlipModal();
      showResultBanner(g);
    } finally {
      state.isFlipping = false;
    }
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function openFlipModal({ title, sub } = {}) {
    els.flipResult.hidden = true;
    if (title && els.flipTitle) els.flipTitle.textContent = title;
    if (els.flipSub) els.flipSub.textContent = sub || 'Server is choosing the result…';
    const inner = els.flipCoinInner;
    inner.style.removeProperty('--final-x');
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

      // Vertical X-axis flip.
      // Heads = even half-turns -> heads face up.
      // Tails = odd half-turns  -> tails (rotated 180°) shows up.
      const finalX = (result === 'heads') ? '2160deg' : '2340deg';
      const configuredDuration = Number(CONFIG.DEFAULT_FLIP_DURATION_MS) || 1500;
      const dur = Math.min(Math.max(configuredDuration, 1200), 2400);

      inner.style.setProperty('--final-x', finalX);
      coin.style.setProperty('--toss-duration', `${dur}ms`);
      inner.style.setProperty('--toss-duration', `${dur}ms`);

      coin.classList.remove('is-waiting');
      void coin.offsetWidth;
      coin.classList.add('is-tossing');

      els.flipSub.textContent = 'Coin is in the air…';

      setTimeout(resolve, dur + 30);
    });
  }

  // FIX: previously the "Gold change" / "Outcome" rows showed "You Lost!"
  // when the user lost their last gold. Always show the actual amount.
  function revealFlipResult(data) {
    if (!state.user) return;
    const game = data.game;
    const myId = state.user.id;
    const isCreator = (game.creator_id === myId);
    const myPick    = isCreator ? game.creator_choice : (game.creator_choice === 'heads' ? 'tails' : 'heads');
    const won       = (game.winner_id === myId);
    const wager     = Number(game.wager);

    const newBalance = data.user ? data.user.balance : data.balance;

    els.flipSub.textContent = won ? 'You won!' : 'You lost.';
    els.resultSide.textContent    = capitalize(game.result);
    els.resultPick.textContent    = capitalize(myPick);
    els.resultOutcome.textContent = won ? 'You won' : 'You lost';
    els.resultAmount.textContent  = won ? `+${formatMoney(wager * 2)}` : `−${formatMoney(wager)}`;
    els.resultBalance.textContent = formatMoney(newBalance);

    const allRows = els.flipResult.querySelectorAll('.result-row');
    allRows.forEach(r => r.classList.remove('row-win', 'row-loss'));
    const outcomeRow = els.resultOutcome.closest('.result-row');
    const amountRow  = els.resultAmount.closest('.result-row');
    if (outcomeRow) outcomeRow.classList.add(won ? 'row-win' : 'row-loss');
    if (amountRow)  amountRow.classList.add(won ? 'row-win' : 'row-loss');

    els.flipResult.hidden = false;

    if (navigator.vibrate) {
      try { navigator.vibrate(won ? [35, 40, 35] : [60]); } catch {}
    }

    if (data.user) {
      state.user = data.user;
      updateTopbar();
    } else if (state.user && Number.isFinite(Number(data.balance))) {
      state.user = { ...state.user, balance: Number(data.balance) };
      updateTopbar();
    }
    if (state.seenCompletedIds) {
      state.seenCompletedIds.add(game.id);
      saveSeenCompletedIds();
    }
    if (state.pendingCreatedGameIds) {
      state.pendingCreatedGameIds.delete(Number(game.id));
      savePendingCreatedIds();
    }

    refreshOwnOpenGamesCount().then(() => { updateWagerLimitUI(); applyEliminatedState(); }).catch(() => {});
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

  // ---------- Profile ----------
  function renderProfileStats(payload) {
    const user = payload?.user || state.user || {};
    const stats = payload?.stats || {};
    if (els.profileTitle) els.profileTitle.textContent = user.username || 'Your stats';
    if (els.profileBalance) els.profileBalance.textContent = formatMoney(user.balance ?? state.user?.balance ?? 0);
    if (els.profileAge) els.profileAge.textContent = formatAccountAge(user.created_at || state.user?.created_at);
    if (els.profileStreak) els.profileStreak.textContent = `${Number(stats.current_win_streak || 0)} wins`;
    if (els.profileMaxStreak) els.profileMaxStreak.textContent = `${Number(stats.max_win_streak || 0)} wins`;
    if (els.profileRecord) els.profileRecord.textContent = `${Number(stats.wins || 0)}W / ${Number(stats.losses || 0)}L`;
    if (els.profileRatio) els.profileRatio.textContent = `${formatPercent(stats.win_rate || 0)}`;
    if (els.profileNote) els.profileNote.textContent = `${Number(stats.games_played || 0).toLocaleString('en-US')} completed games counted.`;
  }

  async function openProfileModal() {
    if (!state.user || !els.profileModal) return;
    renderProfileStats({ user: state.user, stats: state.profileStats || {} });
    els.profileModal.hidden = false;
    els.profileModal.setAttribute('aria-hidden', 'false');
    try {
      const payload = await api('/api/me/stats');
      state.profileStats = payload.stats;
      if (payload.user) {
        state.user = payload.user;
        updateTopbar();
      }
      renderProfileStats(payload);
    } catch (err) {
      if (els.profileNote) els.profileNote.textContent = err.message || 'Could not refresh stats.';
    }
  }

  function closeProfileModal() {
    if (!els.profileModal) return;
    els.profileModal.hidden = true;
    els.profileModal.setAttribute('aria-hidden', 'true');
  }

  // ---------- Wire events & boot ----------
  function wireEvents() {
    els.authTabs.forEach(t => on(t, 'click', () => switchAuthTab(t.dataset.authTab)));
    els.mainTabs.forEach(t => on(t, 'click', () => switchMainTab(t.dataset.mainTab)));

    on(els.formLogin, 'submit', handleLogin);
    on(els.formSignup, 'submit', handleSignup);
    on(els.signupPassword, 'input', updatePasswordMeter);
    on(els.logoutBtn, 'click', handleLogout);
    on(els.userName, 'click', openProfileModal);
    on(els.themeToggle, 'click', toggleTheme);
    on(els.themeToggleAuth, 'click', toggleTheme);

    on(els.formCreateGame, 'submit', handleCreateGame);
    on(els.wagerInput, 'beforeinput', (e) => {
      if (e.data && /[^0-9]/.test(e.data)) e.preventDefault();
    });
    on(els.wagerInput, 'input', () => sanitizeIntegerInput(els.wagerInput, { clampMax: true }));
    on(els.filterMin, 'input', () => sanitizeIntegerInput(els.filterMin));
    on(els.filterMax, 'input', () => sanitizeIntegerInput(els.filterMax));

    on(els.applyFilters, 'click', applyFilters);
    on(els.clearFilters, 'click', clearFilters);
    on(els.refreshGames, 'click', () => runThrottled('games', CLIENT_ACTION_COOLDOWNS.refresh, () => refreshOpenGames()));
    on(els.gamesPrev, 'click', () => runThrottled('games-prev', CLIENT_ACTION_COOLDOWNS.refresh, () => { if (state.pages.lobby > 1) { state.pages.lobby -= 1; refreshOpenGames(); } }));
    on(els.gamesNext, 'click', () => runThrottled('games-next', CLIENT_ACTION_COOLDOWNS.refresh, () => { state.pages.lobby += 1; refreshOpenGames(); }));

    on(els.refreshMy, 'click', () => runThrottled('my', CLIENT_ACTION_COOLDOWNS.refresh, () => refreshMyGames()));
    on(els.myPrev, 'click', () => runThrottled('my-prev', CLIENT_ACTION_COOLDOWNS.refresh, () => { if (state.pages.my > 1) { state.pages.my -= 1; refreshMyGames(); } }));
    on(els.myNext, 'click', () => runThrottled('my-next', CLIENT_ACTION_COOLDOWNS.refresh, () => { state.pages.my += 1; refreshMyGames(); }));

    on(els.refreshLb, 'click', () => runThrottled('leaderboard', CLIENT_ACTION_COOLDOWNS.refresh, () => refreshLeaderboard()));
    on(els.lbPrev, 'click', () => runThrottled('lb-prev', CLIENT_ACTION_COOLDOWNS.refresh, () => { if (state.pages.leaderboard > 1) { state.pages.leaderboard -= 1; refreshLeaderboard(); } }));
    on(els.lbNext, 'click', () => runThrottled('lb-next', CLIENT_ACTION_COOLDOWNS.refresh, () => { state.pages.leaderboard += 1; refreshLeaderboard(); }));

    on(els.resultBannerClose, 'click', hideResultBanner);

    on(els.flipCloseBtn, 'click', closeFlipModal);

    on(els.confirmYes, 'click', () => closeConfirmModal(true));
    on(els.confirmNo,  'click', () => closeConfirmModal(false));
    on(els.profileClose, 'click', closeProfileModal);
    on(els.profileModal, 'click', (e) => { if (e.target === els.profileModal) closeProfileModal(); });
    on(els.confirmModal, 'click', (e) => { if (e.target === els.confirmModal) closeConfirmModal(false); });
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && els.profileModal && !els.profileModal.hidden) closeProfileModal();
      if (e.key === 'Escape' && !els.confirmModal.hidden) closeConfirmModal(false);
    });

    on(document.body, 'click', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const action = t.getAttribute('data-action');
      if (action === 'goto-app') {
        e.preventDefault();
        if (state.user) showDashboardView();
      }
    });

    on(document, 'visibilitychange', () => {
      if (document.hidden) return;
      if (!state.user || state.isFlipping) return;
      refreshCompletedNotifications({ silent: true }).catch(() => {});
      refreshMe().catch(() => {});
      refreshMyGames({ forNotification: true, silent: true }).catch(() => {});
      refreshOpenGames({ silent: true }).catch(() => {});
      heartbeatPresence().catch(() => {});
      if (state.activeMainTab === 'leaderboard') refreshLeaderboard({ silent: true }).catch(() => {});
    });
  }

  async function boot() {
    captureElements();
    applyTheme(state.theme);
    wireEvents();
    document.body.dataset.config = 'ready';

    loadRuntimeConfig().catch(() => {});

    if (!state.token) {
      showAuthView();
      return;
    }
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
