/* =====================================================================
   CoinFlip LB — app.js
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

  const state = {
    token:          localStorage.getItem(TOKEN_KEY) || null,
    user:           null,
    activeAuthTab:  'login',
    activeMainTab:  'lobby',
    filters:        {},                // { minWager, maxWager }
    isFlipping:     false,
    pollTimer:      null,
    seenCompletedIds: null,             // Set or null (null = not initialized)
    lastBannerGameId: null,
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
      'formCreateGame', 'wagerInput', 'createBtn', 'createFeedback',
      'gamesRows', 'gamesEmpty', 'gamesLoading', 'filterMin', 'filterMax',
      'applyFilters', 'clearFilters', 'refreshGames',
      'myRows', 'myEmpty', 'myLoading', 'refreshMy',
      'lbRows', 'lbEmpty', 'lbLoading', 'refreshLb',
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

      // My panel
      myRows:    $('#my-rows'),
      myEmpty:   $('#my-empty'),
      myLoading: $('#my-loading'),
      refreshMy: $('#refresh-my'),

      // Leaderboard panel
      lbRows:    $('#lb-rows'),
      lbEmpty:   $('#lb-empty'),
      lbLoading: $('#lb-loading'),
      refreshLb: $('#refresh-lb'),

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

  // -------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------
  function formatMoney(value) {
    const n = Number(value || 0);
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      return;
    }
    els.topbar.hidden = false;
    els.balancePill.hidden = false;
    els.balanceValue.textContent = formatMoney(state.user.balance);
    els.userName.hidden = false;
    els.userName.textContent = state.user.username;
    els.logoutBtn.hidden = false;
  }

  // -------------------------------------------------------------------
  // View switching
  // -------------------------------------------------------------------
  function showAuthView() {
    els.viewAuth.hidden = false;
    els.viewDashboard.hidden = true;
    els.topbar.hidden = !state.user;
  }
  function showDashboardView() {
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

    // Initial parallel fetch (don't fail the whole boot if one fails)
    await Promise.allSettled([
      refreshMe(),
      refreshOpenGames(),
      refreshMyGames(),
      refreshLeaderboard(),
    ]);
    startPolling();
  }

  async function refreshMe() {
    try {
      const data = await api('/api/me');
      state.user = data.user;
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
      if (document.hidden || state.isFlipping) return;
      // Always refresh open games; my games is needed for completion detection.
      // Leaderboard is heavier so it only refreshes on tab activation / manual click.
      refreshOpenGames().catch(() => {});
      refreshMyGames().catch(() => {});
      // Light refresh of "me" so the balance pill stays current
      refreshMe().catch(() => {});
    }, Math.max(5000, Number(CONFIG.POLLING_INTERVAL_MS) || 60000));
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // -------------------------------------------------------------------
  // Open games panel
  // -------------------------------------------------------------------
  async function refreshOpenGames() {
    const params = new URLSearchParams();
    params.set('status', 'open');
    if (state.filters.minWager != null) params.set('minWager', state.filters.minWager);
    if (state.filters.maxWager != null) params.set('maxWager', state.filters.maxWager);

    try {
      const data = await api(`/api/games?${params.toString()}`);
      els.gamesLoading.hidden = true;
      renderOpenGames(data.games || []);
    } catch (err) {
      if (els.gamesLoading) els.gamesLoading.textContent = 'Could not load games.';
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
      const insufficient = (Number(g.wager) > myBalance);
      if (joinBtn) {
        if (isOwn) {
          joinBtn.disabled = true;
          joinBtn.textContent = 'Your game';
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
    const min = Number(els.filterMin.value);
    const max = Number(els.filterMax.value);
    state.filters = {};
    if (Number.isFinite(min) && els.filterMin.value !== '' && min >= 0) state.filters.minWager = min;
    if (Number.isFinite(max) && els.filterMax.value !== '' && max >= 0) state.filters.maxWager = max;
    refreshOpenGames();
  }
  function clearFilters() {
    els.filterMin.value = '';
    els.filterMax.value = '';
    state.filters = {};
    refreshOpenGames();
  }

  // -------------------------------------------------------------------
  // My games panel
  // -------------------------------------------------------------------
  async function refreshMyGames() {
    try {
      const data = await api('/api/me/games?limit=30');
      els.myLoading.hidden = true;
      renderMyGames(data.games || []);
      processCompletionDetection(data.games || []);
    } catch (err) {
      console.warn('[refreshMyGames]', err);
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

        amount.textContent = (won ? '+' : '−') + formatMoney(wager);
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
    if (fresh) showResultBanner(fresh);

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
      ? `You won ${formatMoney(wager)}!`
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
  }
  function hideResultBanner() {
    els.resultBanner.hidden = true;
    els.resultBanner.classList.remove('is-win', 'is-loss');
  }

  // -------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------
  async function refreshLeaderboard() {
    try {
      const data = await api('/api/leaderboard');
      els.lbLoading.hidden = true;
      renderLeaderboard(data.users || []);
    } catch (err) {
      if (els.lbLoading) els.lbLoading.textContent = 'Could not load leaderboard.';
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

    const choice = (els.formCreateGame.querySelector('input[name="choice"]:checked') || {}).value;
    const wager  = Number(els.wagerInput.value);

    if (!choice) {
      showFeedback(els.createFeedback, 'Pick heads or tails.', 'error');
      return;
    }
    const minWager = Number(CONFIG.MIN_WAGER) || 1;
    const maxWager = Number(CONFIG.MAX_WAGER) || Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(wager) || wager < minWager || wager > maxWager) {
      showFeedback(els.createFeedback, `Wager must be between $${minWager} and $${maxWager}.`, 'error');
      return;
    }
    if (state.user && wager > Number(state.user.balance)) {
      showFeedback(els.createFeedback, `You only have ${formatMoney(state.user.balance)} available.`, 'error');
      return;
    }

    setLoading(els.createBtn, true);
    try {
      await api('/api/games', {
        method: 'POST',
        body: JSON.stringify({ choice, wager }),
      });
      els.wagerInput.value = '';
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
  // Join game (with flip animation)
  // -------------------------------------------------------------------
  async function handleJoinGame(gameId, btn) {
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
      const dur    = CONFIG.DEFAULT_FLIP_DURATION_MS;

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

    els.flipSub.textContent = won ? 'You won!' : 'You lost.';
    els.resultSide.textContent    = capitalize(game.result);
    els.resultPick.textContent    = capitalize(myPick);
    els.resultOutcome.textContent = won ? 'You won' : 'You lost';
    els.resultAmount.textContent  = (won ? '+' : '−') + formatMoney(wager);
    const newBalance = data.user ? data.user.balance : data.balance;
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

    // Create
    on(els.formCreateGame, 'submit', handleCreateGame);

    // Open games filters / refresh
    on(els.applyFilters, 'click', applyFilters);
    on(els.clearFilters, 'click', clearFilters);
    on(els.refreshGames, 'click', () => refreshOpenGames());

    // My games refresh
    on(els.refreshMy, 'click', () => refreshMyGames());

    // Leaderboard refresh
    on(els.refreshLb, 'click', () => refreshLeaderboard());

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
      refreshOpenGames().catch(() => {});
      refreshMyGames().catch(() => {});
    });
  }

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------
  async function boot() {
    captureElements();
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