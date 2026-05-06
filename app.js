// =====================================================================
// app.js — CoinFlip Arena frontend logic
// ---------------------------------------------------------------------
// All UI logic lives here. Anything sensitive (game results, balances,
// authentication) is delegated to the backend via the REST API. The
// frontend never decides who wins; it only renders what the server says.
//
// Auth token is kept in localStorage. For an MVP this is acceptable —
// in production you would prefer an HttpOnly cookie session, but that
// requires a backend that lives on the same domain (or a fancier CORS
// + cookie setup). See the project README for the rationale.
// =====================================================================

(function () {
  'use strict';

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------
  const state = {
    token: localStorage.getItem('cfa_token') || null,
    user:  null,                    // {id, username, balance}
    pollTimer: null,
    activeFilters: { wager: null, minWager: null, maxWager: null },
    isFlipping: false,
  };

  // Cache DOM lookups
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    // Topbar
    brandName:    $('#brand-name'),
    balancePill:  $('#balance-pill'),
    balanceAmount:$('#balance-amount'),
    userName:     $('#user-name'),
    logoutBtn:    $('#logout-btn'),

    // Views
    viewLanding:  $('#view-landing'),
    viewAuth:     $('#view-auth'),
    viewDashboard:$('#view-dashboard'),

    // Auth
    tabLogin:     $('#tab-login'),
    tabSignup:    $('#tab-signup'),
    formLogin:    $('#form-login'),
    formSignup:   $('#form-signup'),

    // Create game
    formCreate:   $('#form-create-game'),
    wagerHint:    $('#wager-hint'),

    // Games list
    gamesList:    $('#games-list'),
    gamesEmpty:   $('#games-empty'),
    gamesLoading: $('#games-loading'),
    refreshGames: $('#refresh-games-btn'),

    // Filters
    filterWager:  $('#filter-wager'),
    filterMin:    $('#filter-min'),
    filterMax:    $('#filter-max'),
    applyFilters: $('#apply-filters-btn'),
    clearFilters: $('#clear-filters-btn'),

    // Leaderboard
    leaderboard:      $('#leaderboard'),
    leaderboardEmpty: $('#leaderboard-empty'),
    refreshLb:        $('#refresh-leaderboard-btn'),

    // Flip modal
    flipModal:    $('#flip-modal'),
    flipTitle:    $('#flip-title'),
    flipSub:      $('#flip-sub'),
    flipCoin:     $('#flip-coin'),
    flipResult:   $('#flip-result'),
    resultSide:   $('#result-side'),
    resultWinner: $('#result-winner'),
    resultAmount: $('#result-amount'),
    resultBalance:$('#result-balance'),
    flipClose:    $('#flip-close-btn'),

    // Toasts
    toastStack:   $('#toast-stack'),

    // Templates
    tplGameRow:    $('#tpl-game-row'),
    tplLbRow:      $('#tpl-leaderboard-row'),
  };

  // -------------------------------------------------------------------
  // Apply CONFIG values into the page
  // -------------------------------------------------------------------
  function applyConfigToDOM() {
    document.title = CONFIG.APP_NAME;
    if (els.brandName) els.brandName.textContent = CONFIG.APP_NAME;

    $$('[data-config]').forEach(el => {
      const key = el.getAttribute('data-config');
      if (CONFIG[key] !== undefined) el.textContent = CONFIG[key];
    });

    // Apply wager bounds to the create-game input.
    const wagerInput = els.formCreate?.elements?.wager;
    if (wagerInput) {
      wagerInput.min = CONFIG.MIN_WAGER;
      wagerInput.max = CONFIG.MAX_WAGER;
    }
  }

  // -------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------
  function toast(message, type = 'info', timeout = 4500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    els.toastStack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 200);
    }, timeout);
  }

  // -------------------------------------------------------------------
  // API helper
  // -------------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.token) headers['Authorization'] = `Bearer ${state.token}`;

    let response;
    try {
      response = await fetch(CONFIG.API_BASE_URL + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network-level failure (CORS, offline, server down, etc.).
      throw new ApiError("Couldn't reach the server. Check your connection and try again.");
    }

    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }

    if (!response.ok) {
      const msg = (data && data.error) || `Request failed (${response.status}).`;
      // 401 → token is bad; force logout.
      if (response.status === 401 && auth) {
        clearSession();
        showAuthLogin();
      }
      throw new ApiError(msg, response.status);
    }
    return data;
  }

  // -------------------------------------------------------------------
  // Button loading states
  // -------------------------------------------------------------------
  function setLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.dataset._origText = btn.textContent;
      const t = btn.getAttribute('data-loading-text');
      if (t) btn.textContent = t;
      btn.disabled = true;
    } else {
      if (btn.dataset._origText !== undefined) btn.textContent = btn.dataset._origText;
      btn.disabled = false;
      delete btn.dataset._origText;
    }
  }

  // -------------------------------------------------------------------
  // View switching
  // -------------------------------------------------------------------
  function showView(name) {
    els.viewLanding.hidden   = (name !== 'landing');
    els.viewAuth.hidden      = (name !== 'auth');
    els.viewDashboard.hidden = (name !== 'dashboard');

    // Stop polling unless we are on the dashboard.
    if (name !== 'dashboard') stopPolling();
  }

  function showAuthLogin()  { showView('auth'); switchAuthTab('login');  }
  function showAuthSignup() { showView('auth'); switchAuthTab('signup'); }

  function switchAuthTab(tab) {
    const isLogin = tab === 'login';
    els.tabLogin.classList.toggle('active', isLogin);
    els.tabSignup.classList.toggle('active', !isLogin);
    els.formLogin.hidden  = !isLogin;
    els.formSignup.hidden = isLogin;
  }

  // -------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------
  function setSession(token, user) {
    state.token = token;
    state.user  = user;
    localStorage.setItem('cfa_token', token);
    renderUser();
  }

  function clearSession() {
    state.token = null;
    state.user  = null;
    localStorage.removeItem('cfa_token');
    renderUser();
  }

  function renderUser() {
    const loggedIn = !!state.user;
    els.balancePill.hidden = !loggedIn;
    els.userName.hidden    = !loggedIn;
    els.logoutBtn.hidden   = !loggedIn;
    if (loggedIn) {
      els.userName.textContent      = state.user.username;
      els.balanceAmount.textContent = formatMoney(state.user.balance);
    }
  }

  // -------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------
  function formatMoney(n) {
    const num = Number(n) || 0;
    return '$' + num.toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  function formatRelative(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)    return Math.max(1, Math.floor(diff)) + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString();
  }

  // -------------------------------------------------------------------
  // Auth handlers
  // -------------------------------------------------------------------
  async function handleSignup(ev) {
    ev.preventDefault();
    const form = ev.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;

    if (password.length < CONFIG.MIN_PASSWORD_LENGTH) {
      toast(`Password must be at least ${CONFIG.MIN_PASSWORD_LENGTH} characters.`, 'error');
      return;
    }

    setLoading(submitBtn, true);
    try {
      const data = await api('/api/auth/signup', {
        method: 'POST', auth: false, body: { username, password },
      });
      setSession(data.token, data.user);
      toast(`Welcome, ${data.user.username}! You start with ${formatMoney(data.user.balance)}.`, 'success');
      await enterDashboard();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(submitBtn, false);
    }
  }

  async function handleLogin(ev) {
    ev.preventDefault();
    const form = ev.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;

    setLoading(submitBtn, true);
    try {
      const data = await api('/api/auth/login', {
        method: 'POST', auth: false, body: { username, password },
      });
      setSession(data.token, data.user);
      toast(`Welcome back, ${data.user.username}!`, 'success');
      await enterDashboard();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(submitBtn, false);
    }
  }

  function handleLogout() {
    clearSession();
    stopPolling();
    showView('landing');
    toast('Logged out.', 'info', 2500);
  }

  // -------------------------------------------------------------------
  // Dashboard entry
  // -------------------------------------------------------------------
  async function enterDashboard() {
    showView('dashboard');
    await Promise.all([refreshMe(), refreshGames(), refreshLeaderboard()]);
    startPolling();
  }

  async function refreshMe() {
    try {
      const { user } = await api('/api/me');
      state.user = user;
      renderUser();
    } catch (err) {
      // 401 already handled inside api()
      if (!(err instanceof ApiError) || err.status !== 401) toast(err.message, 'error');
    }
  }

  // -------------------------------------------------------------------
  // Games — listing, filters, polling
  // -------------------------------------------------------------------
  function buildGamesQuery() {
    const q = new URLSearchParams({ status: 'open' });
    const { wager, minWager, maxWager } = state.activeFilters;
    if (wager    !== null) q.set('wager',    wager);
    if (minWager !== null) q.set('minWager', minWager);
    if (maxWager !== null) q.set('maxWager', maxWager);
    return q.toString();
  }

  async function refreshGames() {
    els.gamesEmpty.hidden = true;
    els.gamesLoading.hidden = false;
    try {
      const { games } = await api('/api/games?' + buildGamesQuery());
      renderGames(games);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      els.gamesLoading.hidden = true;
    }
  }

  function renderGames(games) {
    els.gamesList.innerHTML = '';
    if (!games.length) { els.gamesEmpty.hidden = false; return; }
    els.gamesEmpty.hidden = true;

    for (const g of games) {
      const node = els.tplGameRow.content.firstElementChild.cloneNode(true);
      node.querySelector('.game-creator').textContent = g.creator_username;

      const pill = node.querySelector('.game-choice-pill');
      pill.textContent = g.creator_choice;
      if (g.creator_choice === 'tails') pill.classList.add('tails');

      node.querySelector('.game-wager').textContent = formatMoney(g.wager);
      node.querySelector('.game-time').textContent  = formatRelative(g.created_at);

      const joinBtn = node.querySelector('.game-join-btn');
      const isMine  = state.user && g.creator_id === state.user.id;
      const tooPoor = state.user && Number(state.user.balance) < Number(g.wager);

      if (isMine) {
        joinBtn.textContent = 'Your game';
        joinBtn.disabled = true;
      } else if (tooPoor) {
        joinBtn.textContent = 'Not enough $';
        joinBtn.disabled = true;
      } else {
        joinBtn.addEventListener('click', () => handleJoinGame(g.id, joinBtn));
      }

      els.gamesList.appendChild(node);
    }
  }

  function applyFilters() {
    const w  = els.filterWager.value.trim();
    const mn = els.filterMin.value.trim();
    const mx = els.filterMax.value.trim();
    state.activeFilters.wager    = w  === '' ? null : Number(w);
    state.activeFilters.minWager = mn === '' ? null : Number(mn);
    state.activeFilters.maxWager = mx === '' ? null : Number(mx);
    refreshGames();
  }

  function clearFilters() {
    els.filterWager.value = '';
    els.filterMin.value   = '';
    els.filterMax.value   = '';
    state.activeFilters   = { wager: null, minWager: null, maxWager: null };
    refreshGames();
  }

  function startPolling() {
    stopPolling();
    if (!CONFIG.POLLING_INTERVAL_MS || CONFIG.POLLING_INTERVAL_MS <= 0) return;
    state.pollTimer = setInterval(() => {
      // Don't poll mid-flip: it would replace the joined game's row.
      if (state.isFlipping || document.hidden) return;
      refreshGames();
    }, CONFIG.POLLING_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  // -------------------------------------------------------------------
  // Create game
  // -------------------------------------------------------------------
  async function handleCreateGame(ev) {
    ev.preventDefault();
    const form = ev.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const choice = form.elements.choice.value;
    const wager  = Number(form.elements.wager.value);

    if (!choice) { toast('Pick heads or tails.', 'error'); return; }
    if (!Number.isFinite(wager) || wager < CONFIG.MIN_WAGER || wager > CONFIG.MAX_WAGER) {
      toast(`Wager must be between $${CONFIG.MIN_WAGER} and $${CONFIG.MAX_WAGER}.`, 'error');
      return;
    }
    if (state.user && wager > Number(state.user.balance)) {
      toast('You don\'t have enough balance for that wager.', 'error');
      return;
    }

    setLoading(submitBtn, true);
    try {
      await api('/api/games', { method: 'POST', body: { choice, wager } });
      toast('Game created. Waiting for an opponent…', 'success');
      form.reset();
      await Promise.all([refreshGames(), refreshMe()]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(submitBtn, false);
    }
  }

  // -------------------------------------------------------------------
  // Join game (the animated flip lives here)
  // -------------------------------------------------------------------
  async function handleJoinGame(gameId, btn) {
    if (state.isFlipping) return;
    setLoading(btn, true);
    state.isFlipping = true;

    openFlipModal();

    // Start the request and the visual flip in parallel. We always
    // wait for the configured animation duration so the user sees a
    // satisfying flip even if the API responds instantly.
    const apiPromise = api(`/api/games/${gameId}/join`, { method: 'POST' });
    const minDelay   = new Promise(r => setTimeout(r, CONFIG.DEFAULT_FLIP_DURATION_MS));

    try {
      const [data] = await Promise.all([apiPromise, minDelay]);
      revealFlipResult(data);
      // Refresh underlying data so the dashboard is up to date.
      await Promise.all([refreshMe(), refreshGames(), refreshLeaderboard()]);
    } catch (err) {
      closeFlipModal();
      toast(err.message, 'error');
    } finally {
      state.isFlipping = false;
      setLoading(btn, false);
    }
  }

  // -------------------------------------------------------------------
  // Flip modal & animation
  // -------------------------------------------------------------------
  function openFlipModal() {
    els.flipResult.hidden = true;
    els.flipTitle.textContent = 'Flipping the coin…';
    els.flipSub.textContent   = 'Server is choosing the result…';

    // Reset coin to flipping state.
    els.flipCoin.classList.remove('show-heads', 'show-tails');
    els.flipCoin.style.setProperty('--tick-duration', `${CONFIG.COIN_FLIP_SPEED_MS}ms`);
    // Force reflow so the animation restarts cleanly.
    void els.flipCoin.offsetWidth;
    els.flipCoin.classList.add('is-flipping');

    els.flipModal.hidden = false;
    els.flipModal.setAttribute('aria-hidden', 'false');
  }

  function closeFlipModal() {
    els.flipModal.hidden = true;
    els.flipModal.setAttribute('aria-hidden', 'true');
    els.flipCoin.classList.remove('is-flipping', 'show-heads', 'show-tails');
  }

  function revealFlipResult(data) {
    const { game, balance } = data;
    const result   = game.result;                                  // 'heads' | 'tails'
    const youWon   = state.user && game.winner_id === state.user.id;
    const winName  = game.winner_username;
    const wager    = Number(game.wager);

    // Settle the coin to the final side.
    els.flipCoin.classList.remove('is-flipping');
    els.flipCoin.classList.add(result === 'heads' ? 'show-heads' : 'show-tails');

    els.flipTitle.textContent = youWon ? 'You won! 🎉' : 'You lost.';
    els.flipSub.textContent   = `The coin landed on ${result.toUpperCase()}.`;

    els.resultSide.textContent    = result.toUpperCase();
    els.resultWinner.textContent  = winName + (youWon ? ' (you)' : '');
    els.resultAmount.textContent  = (youWon ? '+' : '−') + formatMoney(wager);
    els.resultBalance.textContent = formatMoney(balance);

    // Color-code amount row for a clearer signal.
    const amountRow = els.resultAmount.closest('.result-row');
    amountRow.classList.remove('win', 'lose');
    amountRow.classList.add(youWon ? 'win' : 'lose');

    els.flipResult.hidden = false;
  }

  // -------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------
  async function refreshLeaderboard() {
    try {
      const { users } = await api('/api/leaderboard');
      renderLeaderboard(users);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderLeaderboard(users) {
    els.leaderboard.innerHTML = '';
    if (!users.length) { els.leaderboardEmpty.hidden = false; return; }
    els.leaderboardEmpty.hidden = true;

    for (const u of users) {
      const node = els.tplLbRow.content.firstElementChild.cloneNode(true);
      node.querySelector('.lb-rank').textContent    = '#' + u.rank;
      node.querySelector('.lb-name').textContent    = u.username;
      node.querySelector('.lb-balance').textContent = formatMoney(u.balance);
      if (state.user && u.id === state.user.id) node.classList.add('is-me');
      if (u.rank === 1) node.classList.add('top-1');
      if (u.rank === 2) node.classList.add('top-2');
      if (u.rank === 3) node.classList.add('top-3');
      els.leaderboard.appendChild(node);
    }
  }

  // -------------------------------------------------------------------
  // Wire up event listeners
  // -------------------------------------------------------------------
  function bindEvents() {
    // Landing → auth
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-action]');
      if (!t) return;
      ev.preventDefault();
      switch (t.getAttribute('data-action')) {
        case 'show-signup':  showAuthSignup();  break;
        case 'show-login':   showAuthLogin();   break;
        case 'show-landing': showView('landing'); break;
      }
    });

    // Auth tabs
    els.tabLogin.addEventListener('click',  () => switchAuthTab('login'));
    els.tabSignup.addEventListener('click', () => switchAuthTab('signup'));

    // Forms
    els.formLogin.addEventListener('submit',  handleLogin);
    els.formSignup.addEventListener('submit', handleSignup);
    els.formCreate.addEventListener('submit', handleCreateGame);

    // Refresh
    els.refreshGames.addEventListener('click', async () => {
      setLoading(els.refreshGames, true);
      try { await refreshGames(); } finally { setLoading(els.refreshGames, false); }
    });
    els.refreshLb.addEventListener('click', async () => {
      setLoading(els.refreshLb, true);
      try { await refreshLeaderboard(); } finally { setLoading(els.refreshLb, false); }
    });

    // Filters
    els.applyFilters.addEventListener('click', applyFilters);
    els.clearFilters.addEventListener('click', clearFilters);
    [els.filterWager, els.filterMin, els.filterMax].forEach(el => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
    });

    // Logout
    els.logoutBtn.addEventListener('click', handleLogout);

    // Flip modal close
    els.flipClose.addEventListener('click', closeFlipModal);
    els.flipModal.addEventListener('click', (ev) => {
      if (ev.target === els.flipModal && !els.flipResult.hidden) closeFlipModal();
    });

    // Pause polling when the tab is hidden, resume when visible.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.user && !state.isFlipping) refreshGames();
    });
  }

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------
  async function boot() {
    applyConfigToDOM();
    bindEvents();

    if (state.token) {
      // Try to restore the session.
      try {
        const { user } = await api('/api/me');
        state.user = user;
        renderUser();
        await enterDashboard();
        return;
      } catch {
        // Token bad/expired — fall through to landing.
        clearSession();
      }
    }
    showView('landing');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
