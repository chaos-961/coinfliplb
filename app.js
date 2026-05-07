/* =====================================================================
   Coinflip LB — app.js (v0.9)
   ---------------------------------------------------------------------
   Single-file SPA logic. No frameworks.
   - Inline feedback (no toast popups)
   - Auth view default, with confirm-password on signup
   - Dashboard with tabs: Open games / My games / Leaderboard
   - Result banner when one of the user's open games is joined+completed
   - Multi-stage 3D coin flip animation
   - Creator-side flip animation when their game is joined
   - Web Audio sound effects (no external assets)
   - In-app confirm modal (no native confirm())
   - Runtime config pulled from /api/config
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
  const SFX_KEY   = 'cfa_sfx';
  const SEEN_COMPLETED_PREFIX = 'cfa_seen_completed_';
  const PENDING_CREATED_PREFIX = 'cfa_pending_created_';

  function loadSfxPref() {
    const stored = localStorage.getItem(SFX_KEY);
    if (stored === null) return CONFIG.SFX_ENABLED_BY_DEFAULT !== false;
    return stored === '1';
  }

  const state = {
    token:          localStorage.getItem(TOKEN_KEY) || null,
    user:           null,
    activeAuthTab:  'login',
    activeMainTab:  'lobby',
    filters:        {},
    pages:          { lobby: 1, my: 1, leaderboard: 1 },
    totals:         { lobby: 0, my: 0, leaderboard: 0 },
    pageSize:       { lobby: 20, my: 20, leaderboard: 20 },
    isFlipping:     false,
    pollTimer:      null,
    pollTick:       0,
    bannerTimer:    null,
    seenCompletedIds: null,
    pendingCreatedGameIds: null,
    lastBannerGameId: null,
    ownOpenGamesCount: null,
    theme:          localStorage.getItem(THEME_KEY) || 'dark',
    sfxEnabled:     loadSfxPref(),
    runtimeConfig:  null,
  };

  // -------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------
  const $  = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
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
      'flipModal', 'flipCoin', 'flipCoinInner', 'flipSub', 'flipResult', 'flipTitle',
      'resultSide', 'resultPick', 'resultOutcome', 'resultAmount', 'resultBalance',
      'flipCloseBtn', 'tplGameRow', 'tplMyRow', 'tplLbRow',
      'confirmModal', 'confirmTitle', 'confirmBody', 'confirmYes', 'confirmNo',
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
      topbar:        $('#topbar'),
      brandName:     $('#brand-name'),
      balancePill:   $('#balance-pill'),
      balanceValue:  $('#balance-value'),
      userName:      $('#user-name'),
      logoutBtn:     $('#logout-btn'),
      themeToggle:   $('#theme-toggle'),
      themeToggleAuth: $('#theme-toggle-auth'),
      themeIconPath: $('#theme-icon-path'),
      themeIconPathAuth: $('#theme-icon-path-auth'),
      soundToggle:   $('#sound-toggle'),
      soundIconPath: $('#sound-icon-path'),
      lostCard:      $('#lost-card'),
      lostSignout:   $('#lost-signout'),

      viewAuth:      $('#view-auth'),
      viewDashboard: $('#view-dashboard'),

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
      myGamesBadge: $('#my-games-badge'),

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

      confirmModal: $('#confirm-modal'),
      confirmTitle: $('#confirm-title'),
      confirmBody:  $('#confirm-body'),
      confirmYes:   $('#confirm-yes'),
      confirmNo:    $('#confirm-no'),

      tplGameRow: $('#tpl-game-row'),
      tplMyRow:   $('#tpl-my-row'),
      tplLbRow:   $('#tpl-lb-row'),
    });

    if (els.brandName) els.brandName.textContent = CONFIG.APP_NAME;
  }

  // -------------------------------------------------------------------
  // SOUND EFFECTS — Web Audio API, no external assets
  // -------------------------------------------------------------------
  let audioCtx = null;

  function getCtx() {
    if (!state.sfxEnabled) return null;
    if (!audioCtx) {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
      } catch { return null; }
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playTone({ freq = 440, dur = 0.08, type = 'sine', gain = 0.12, attack = 0.005, release = 0.06, freqEnd = null } = {}) {
    const ctx = getCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== null) {
      try { osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur); } catch {}
    }
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + release);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.02);
  }

  let tickInterval = null;
  function startFlipTicks(durationMs) {
    if (!state.sfxEnabled) return;
    stopFlipTicks();
    let i = 0;
    const total = Math.max(1, Math.floor(durationMs / 110));
    tickInterval = setInterval(() => {
      const pitch = 1300 + (Math.sin(i * 0.7) * 180) + (i * 4);
      playTone({ freq: pitch, dur: 0.02, type: 'square', gain: 0.045, attack: 0.001, release: 0.02 });
      i += 1;
      if (i >= total) stopFlipTicks();
    }, 110);
  }
  function stopFlipTicks() {
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  }

  function playLandSound() {
    if (!state.sfxEnabled) return;
    playTone({ freq: 660, dur: 0.05, type: 'triangle', gain: 0.16, freqEnd: 220 });
    setTimeout(() => playTone({ freq: 220, dur: 0.12, type: 'sine', gain: 0.10, freqEnd: 140 }), 60);
  }

  function playWinSound() {
    if (!state.sfxEnabled) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      setTimeout(() => playTone({ freq: f, dur: 0.10, type: 'triangle', gain: 0.13 }), i * 90);
    });
  }

  function playLossSound() {
    if (!state.sfxEnabled) return;
    [392, 311.13, 233.08].forEach((f, i) => {
      setTimeout(() => playTone({ freq: f, dur: 0.16, type: 'sawtooth', gain: 0.10 }), i * 110);
    });
  }

  function playClick() {
    if (!state.sfxEnabled) return;
    playTone({ freq: 920, dur: 0.02, type: 'square', gain: 0.05 });
  }

  function applySfxIcon() {
    if (!els.soundIconPath || !els.soundToggle) return;
    if (state.sfxEnabled) {
      els.soundIconPath.setAttribute('d', 'M11 5L6 9H3v6h3l5 4V5zm5.5 7a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z');
      els.soundToggle.title = 'Mute sounds';
      els.soundToggle.setAttribute('aria-label', 'Mute sounds');
      els.soundToggle.classList.remove('is-muted');
    } else {
      els.soundIconPath.setAttribute('d', 'M11 5L6 9H3v6h3l5 4V5zm5 4l5 5m0-5l-5 5');
      els.soundToggle.title = 'Unmute sounds';
      els.soundToggle.setAttribute('aria-label', 'Unmute sounds');
      els.soundToggle.classList.add('is-muted');
    }
  }

  function toggleSfx() {
    state.sfxEnabled = !state.sfxEnabled;
    localStorage.setItem(SFX_KEY, state.sfxEnabled ? '1' : '0');
    applySfxIcon();
    if (state.sfxEnabled) playClick();
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
    if (state.token && !opts.skipAuth) {
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
  // Inline feedback
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

  function getBalanceTone(balance) {
    const n = Math.max(0, Math.floor(Number(balance) || 0));
    if (n >= 10000) return { key: 'b-white', bg: '#f8fafc', fg: '#0f172a', glow: 'rgba(248, 250, 252, 0.34)' };
    if (n >= 2000)  return { key: 'b-2000',  bg: '#d946ef', fg: '#fff7ff', glow: 'rgba(217, 70, 239, 0.42)' };
    if (n >= 1500)  return { key: 'b-1500',  bg: '#8b5cf6', fg: '#ffffff', glow: 'rgba(139, 92, 246, 0.45)' };
    if (n >= 1000)  return { key: 'b-1000',  bg: '#3b82f6', fg: '#eff6ff', glow: 'rgba(59, 130, 246, 0.42)' };
    if (n >= 500)   return { key: 'b-500',   bg: '#06b6d4', fg: '#ecfeff', glow: 'rgba(6, 182, 212, 0.40)' };
    if (n >= 400)   return { key: 'b-400',   bg: '#14b8a6', fg: '#ecfdf5', glow: 'rgba(20, 184, 166, 0.38)' };
    if (n >= 300)   return { key: 'b-300',   bg: '#22c55e', fg: '#052e16', glow: 'rgba(34, 197, 94, 0.38)' };
    if (n >= 200)   return { key: 'b-200',   bg: '#84cc16', fg: '#1a2e05', glow: 'rgba(132, 204, 22, 0.38)' };
    if (n >= 100)   return { key: 'b-100',   bg: '#facc15', fg: '#422006', glow: 'rgba(250, 204, 21, 0.40)' };
    if (n > 0) {
      const t = Math.min(1, n / 100);
      return {
        key: 'b-low',
        bg: `color-mix(in srgb, #ef4444 ${Math.round(100 - t * 48)}%, #22c55e ${Math.round(t * 52)}%)`,
        fg: '#fff7ed',
        glow: 'rgba(245, 158, 11, 0.32)'
      };
    }
    return { key: 'b-zero', bg: '#ef4444', fg: '#fff1f2', glow: 'rgba(239, 68, 68, 0.42)' };
  }

  function applyBalanceTone(el, balance) {
    if (!el) return;
    const tone = getBalanceTone(balance);
    el.dataset.balanceTone = tone.key;
    el.style.setProperty('--balance-bg', tone.bg);
    el.style.setProperty('--balance-fg', tone.fg);
    el.style.setProperty('--balance-glow', tone.glow);
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
  // Confirm modal (replaces window.confirm)
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // Theme + wager limits
  // -------------------------------------------------------------------
  function hasOwnOpenGames() {
    return Number(state.ownOpenGamesCount) > 0;
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
      showFeedback(els.createFeedback, 'You Lost! You can still view games and the leaderboard, but you cannot create, join, or cancel games.', 'error');
    } else if (els.createFeedback && !lost && els.createFeedback.textContent.includes('You Lost!')) {
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

  function toggleTheme() {
    applyTheme(state.theme === 'light' ? 'dark' : 'light');
    playClick();
  }

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

    els.wagerInput.min = String(min);
    els.wagerInput.max = max >= min ? String(max) : String(min);

    if (max >= min) {
      els.wagerInput.placeholder = `${compactMoney(min)} - ${compactMoney(max)}`;
    } else if (lost) {
      els.wagerInput.placeholder = 'You Lost!';
    } else if (hasOwnOpenGames()) {
      els.wagerInput.placeholder = 'Money reserved';
    } else {
      els.wagerInput.placeholder = 'No money available';
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

  // -------------------------------------------------------------------
  // Result notification storage
  // -------------------------------------------------------------------
  function idSetFromStorage(key) {
    try {
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : []);
    } catch {
      return new Set();
    }
  }
  function saveIdSet(key, set, limit = 120) {
    try {
      const list = Array.from(set).map(Number).filter(Number.isFinite).slice(-limit);
      localStorage.setItem(key, JSON.stringify(list));
    } catch {}
  }
  function seenCompletedKey() {
    return state.user ? `${SEEN_COMPLETED_PREFIX}${state.user.id}` : null;
  }
  function pendingCreatedKey() {
    return state.user ? `${PENDING_CREATED_PREFIX}${state.user.id}` : null;
  }
  function loadNotificationSets() {
    const seenKey = seenCompletedKey();
    const pendingKey = pendingCreatedKey();
    state.seenCompletedIds = seenKey ? idSetFromStorage(seenKey) : new Set();
    state.pendingCreatedGameIds = pendingKey ? idSetFromStorage(pendingKey) : new Set();
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

  // -------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------
  function setSession(token, user) {
    state.token = token;
    state.user  = user;
    if (token) localStorage.setItem(TOKEN_KEY, token);
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
    els.balancePill.setAttribute('aria-label', `Money ${formatMoney(state.user.balance)}`);
    applyBalanceTone(els.balancePill, state.user.balance);
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
    const minPasswordLength = Number((state.runtimeConfig && state.runtimeConfig.minPasswordLength) || CONFIG.MIN_PASSWORD_LENGTH) || 6;
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

  async function handleLogout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    clearSession();
    showAuthView();
    switchAuthTab('login');
    els.formLogin.reset();
    els.formSignup.reset();
    hideResultBanner();
  }

  // -------------------------------------------------------------------
  // Runtime config
  // -------------------------------------------------------------------
  async function loadRuntimeConfig() {
    try {
      const data = await api('/api/config', { skipAuth: true });
      state.runtimeConfig = data;
      updateWagerLimitUI();
    } catch (err) {
      console.warn('[loadRuntimeConfig] using client defaults:', err.message);
    }
  }

  // -------------------------------------------------------------------
  // Dashboard entry & polling
  // -------------------------------------------------------------------
  async function enterDashboard() {
    showDashboardView();
    switchMainTab('lobby');

    loadNotificationSets();

    await Promise.allSettled([
      refreshMe(),
      refreshMyGames({ skipCompletionDetection: true }),
      refreshCompletedNotifications({ initial: true }),
    ]);
    startPolling();
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

      // refreshMyGames runs completion detection internally, which is what
      // drives the result banner and creator-side flip animation.
      refreshMyGames({ silent: true, forNotification: true }).catch(() => {});

      if (state.activeMainTab === 'lobby') refreshOpenGames({ silent: true }).catch(() => {});
      if (state.activeMainTab === 'leaderboard' && state.pollTick % 6 === 0) refreshLeaderboard({ silent: true }).catch(() => {});
      refreshMe().catch(() => {});
    }, Math.max(2500, Number(CONFIG.POLLING_INTERVAL_MS) || 4000));
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

      const avatar = $('.avatar', node);
      if (avatar && g.creator_username) {
        avatar.textContent = String(g.creator_username).charAt(0).toUpperCase();
        avatar.classList.add('avatar-letter');
      }

      // Static coin face for the creator's pick. Do NOT use the animated 3D coin
      // here; it has depth/rim pseudo-elements that overlap at small sizes.
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
      if (options.forOpenCount) {
        state.ownOpenGamesCount = meta.total;
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
      // Always run completion detection unless this call is purely a count probe.
      if (!options.forOpenCount) processCompletionDetection(games, options);
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

    const isBrandNewSeenList = state.seenCompletedIds.size === 0 && !localStorage.getItem(seenCompletedKey());
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
      // If the user is the CREATOR of this freshly completed game,
      // show them the same flip animation the joiner saw — instead of
      // just a banner. Symmetric experience for both sides.
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

    // Show the actual landed side with the same isolated static coin used in the picker.
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
    els.resultBanner.setAttribute('role', 'status');
    if (state.bannerTimer) clearTimeout(state.bannerTimer);
    state.bannerTimer = setTimeout(hideResultBanner, 20000);
    if (navigator.vibrate) {
      try { navigator.vibrate(won ? [35, 40, 35] : [60]); } catch {}
    }
    if (won) playWinSound(); else playLossSound();
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
      const lbBalance = $('.lb-balance', node);
      lbBalance.textContent = formatMoney(u.balance);
      applyBalanceTone(lbBalance, u.balance);
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
    const minWager = getMinWager();
    const maxWager = getMaxAllowedWager();
    if (wager === null || wager < minWager || wager > maxWager) {
      showFeedback(els.createFeedback, `Wager must be between ${compactMoney(minWager)} and ${compactMoney(maxWager)}.`, 'error');
      return;
    }

    // Confirm large wagers (>= 50% of balance and >= $100)
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

    setLoading(els.createBtn, true);
    try {
      const data = await api('/api/games', {
        method: 'POST',
        body: JSON.stringify({ choice, wager }),
      });
      if (data.game) trackCreatedGameForNotification(data.game.id);
      if (data.user) {
        state.user = data.user;
        state.ownOpenGamesCount = Math.max(1, Number(state.ownOpenGamesCount) || 0);
        updateTopbar();
      }
      els.wagerInput.value = '';
      els.formCreateGame.querySelectorAll('input[name="choice"]').forEach(input => { input.checked = false; });
      updateWagerLimitUI();
      playClick();
      showFeedback(els.createFeedback, 'Game created. Waiting for an opponent…', 'success');
      refreshOpenGames();
      refreshMyGames();
      refreshMe();
    } catch (err) {
      showFeedback(els.createFeedback, err.message, 'error');
    } finally {
      setLoading(els.createBtn, false);
      updateWagerLimitUI();
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
    if (!gameId) return;
    const ok = await confirmModal({
      title: 'Cancel game?',
      body: 'Cancel this open game and refund the wager? You can always create a new one.',
      confirmText: 'Cancel game',
      cancelText: 'Keep game',
      danger: true,
    });
    if (!ok) return;
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
  // Join game (with flip animation) — JOINER side
  // -------------------------------------------------------------------
  async function handleJoinGame(gameId, wager, btn) {
    if (isEliminated()) {
      showFeedback(els.createFeedback, 'You Lost! You cannot join games.', 'error');
      return;
    }
    if (state.isFlipping) return;

    if (state.user && Number(wager) >= 100 && Number(wager) >= Math.floor(Number(state.user.balance) * 0.5)) {
      const ok = await confirmModal({
        title: 'Join this flip?',
        body: `${formatMoney(wager)} on the line. Win or lose, the result is final.`,
        confirmText: 'Flip it',
        cancelText: 'Back',
        danger: false,
      });
      if (!ok) return;
    }

    state.isFlipping = true;
    setLoading(btn, true);
    openFlipModal({ title: 'Flipping the coin…', sub: 'Server is choosing the result…' });

    try {
      const data = await api(`/api/games/${gameId}/join`, { method: 'POST' });
      lastModalGameId = data.game.id;
      els.flipSub.textContent = 'Here it goes…';
      await wait(350);
      await animateFlip(data.game.result);
      revealFlipResult(data);
    } catch (err) {
      closeFlipModal();
      showFeedback(els.createFeedback, err.message, 'error');
      refreshOpenGames();
    } finally {
      state.isFlipping = false;
      setLoading(btn, false);
    }
  }

  // -------------------------------------------------------------------
  // CREATOR-side flip: when the user's open game has just been joined
  // and completed, replay the flip animation for them too.
  // -------------------------------------------------------------------
  async function showCreatorFlip(g) {
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

      // Build a payload that revealFlipResult expects
      const payload = {
        game: g,
        user: state.user,
        balance: state.user ? state.user.balance : 0,
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

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function openFlipModal({ title, sub } = {}) {
    els.flipResult.hidden = true;
    if (title && els.flipTitle) els.flipTitle.textContent = title;
    if (els.flipSub) els.flipSub.textContent = sub || 'Server is choosing the result…';
    const inner = els.flipCoinInner;
    inner.style.removeProperty('--final-y');
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

      // X-axis rotation for the v0.13 physical vertical flip.
      // Heads = even number of half-turns (lands face up).
      // Tails = odd number of half-turns.
      const finalX = (result === 'heads') ? '2160deg' : '2340deg';
      // Fast readable vertical flip: about 1.5s of motion, then result.
      const configuredDuration = Number(CONFIG.DEFAULT_FLIP_DURATION_MS) || 1500;
      const dur = Math.min(Math.max(configuredDuration, 1350), 1650);

      inner.style.setProperty('--final-x', finalX);
      // Keep the legacy variable updated too so older fallback CSS never lands wrong.
      inner.style.setProperty('--final-y', (result === 'heads') ? '2880deg' : '3060deg');
      inner.style.setProperty('--toss-duration', `${dur}ms`);
      coin.style.setProperty('--toss-duration', `${dur}ms`);

      coin.classList.remove('is-waiting');
      void coin.offsetWidth;
      coin.classList.add('is-tossing');

      els.flipSub.textContent = 'Tossing…';

      // Sound effects: ticks during the spin, thud at the end.
      startFlipTicks(dur);
      setTimeout(() => { stopFlipTicks(); playLandSound(); }, dur - 30);

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

    const allRows = els.flipResult.querySelectorAll('.result-row');
    allRows.forEach(r => r.classList.remove('row-win', 'row-loss'));
    const outcomeRow = els.resultOutcome.closest('.result-row');
    const amountRow  = els.resultAmount.closest('.result-row');
    if (outcomeRow) outcomeRow.classList.add(won ? 'row-win' : 'row-loss');
    if (amountRow)  amountRow.classList.add(won ? 'row-win' : 'row-loss');

    els.flipResult.hidden = false;

    if (won) playWinSound(); else playLossSound();
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
    stopFlipTicks();
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
    on(els.themeToggleAuth, 'click', toggleTheme);
    on(els.soundToggle, 'click', toggleSfx);

    // Create
    on(els.formCreateGame, 'submit', handleCreateGame);
    on(els.wagerInput, 'beforeinput', (e) => {
      if (e.data && /[^0-9]/.test(e.data)) e.preventDefault();
    });
    on(els.wagerInput, 'input', () => sanitizeIntegerInput(els.wagerInput, { clampMax: true }));
    on(els.filterMin, 'input', () => sanitizeIntegerInput(els.filterMin));
    on(els.filterMax, 'input', () => sanitizeIntegerInput(els.filterMax));

    // Open games
    on(els.applyFilters, 'click', applyFilters);
    on(els.clearFilters, 'click', clearFilters);
    on(els.refreshGames, 'click', () => refreshOpenGames());
    on(els.gamesPrev, 'click', () => { if (state.pages.lobby > 1) { state.pages.lobby -= 1; refreshOpenGames(); } });
    on(els.gamesNext, 'click', () => { state.pages.lobby += 1; refreshOpenGames(); });

    // My games
    on(els.refreshMy, 'click', () => refreshMyGames());
    on(els.myPrev, 'click', () => { if (state.pages.my > 1) { state.pages.my -= 1; refreshMyGames(); } });
    on(els.myNext, 'click', () => { state.pages.my += 1; refreshMyGames(); });

    // Leaderboard
    on(els.refreshLb, 'click', () => refreshLeaderboard());
    on(els.lbPrev, 'click', () => { if (state.pages.leaderboard > 1) { state.pages.leaderboard -= 1; refreshLeaderboard(); } });
    on(els.lbNext, 'click', () => { state.pages.leaderboard += 1; refreshLeaderboard(); });

    // Result banner
    on(els.resultBannerClose, 'click', hideResultBanner);

    // Flip modal close
    on(els.flipCloseBtn, 'click', closeFlipModal);

    // Confirm modal
    on(els.confirmYes, 'click', () => closeConfirmModal(true));
    on(els.confirmNo,  'click', () => closeConfirmModal(false));
    on(els.confirmModal, 'click', (e) => {
      if (e.target === els.confirmModal) closeConfirmModal(false);
    });
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && !els.confirmModal.hidden) closeConfirmModal(false);
    });

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

    // Refresh data when the tab becomes visible again. Browsers pause
    // timers in hidden tabs, so we want to catch up on completions, balance,
    // and the visible list as soon as the user returns.
    on(document, 'visibilitychange', () => {
      if (document.hidden) return;
      if (!state.user || state.isFlipping) return;
      refreshCompletedNotifications({ silent: true }).catch(() => {});
      refreshMe().catch(() => {});
      refreshMyGames({ forNotification: true, silent: true }).catch(() => {});
      refreshOpenGames({ silent: true }).catch(() => {});
      if (state.activeMainTab === 'leaderboard') refreshLeaderboard({ silent: true }).catch(() => {});
    });
  }

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------
  async function boot() {
    captureElements();
    applyTheme(state.theme);
    applySfxIcon();
    if (!assertRequiredElements()) {
      document.body.dataset.config = 'error';
      return;
    }
    wireEvents();
    document.body.dataset.config = 'ready';

    // Pull authoritative limits from /api/config (non-blocking).
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
