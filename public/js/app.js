/* ============================================================
   Ticket Booking System - Frontend (vanilla JS, hash-routed SPA)
   ============================================================ */
(function () {
  'use strict';

  var REMOTE_API_BASE = 'https://ticket-booking-system.fshare-ayush-demo.workers.dev';
  var API_BASE = (function () {
    if (window.location.hostname.indexOf('workers.dev') >= 0 || (window.location.hostname === 'localhost' && window.location.port === '8787')) {
      return '';
    }
    return REMOTE_API_BASE;
  })();

  var POLL_MS = 3000;           // seat-map polling interval
  var MAX_SELECTABLE = 6;       // max seats a customer may select per booking
  var TYPES = ['Movie', 'Concert'];

  /* ---------- localStorage-backed session ---------- */
  var token = localStorage.getItem('tbs_token') || null;
  var user = null;
  try { user = JSON.parse(localStorage.getItem('tbs_user') || 'null'); } catch (e) { user = null; }

  /* ---------- transient booking state ---------- */
  var hold = null;              // { eventId, seatIds:[], tokens:[], expiresAt }
  var claim = null;             // { token, eventId, seatIds:[], expiresAt } (waitlist offer)
  var selectedSeats = [];       // row-col keys currently chosen by user
  var seatIdMap = {};           // 'row:col' -> DB seat id (populated on seat-map refresh)
  var pollTimer = null;
  var countdownTimer = null;

  var currentView = null;
  var eventCache = {};
  var bookingComplete = false;   // set after a booking/waitlist success; blocks panel re-renders

  /* ============================================================
   * Small helpers
   * ============================================================ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(n) {
    if (n == null || isNaN(Number(n))) return 'n/a';
    var num = Number(n);
    return '$' + (Number.isInteger(num) ? num.toLocaleString() : num.toFixed(2));
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatDateTime(dateStr, timeStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr + (timeStr ? 'T' + timeStr : ''));
    if (isNaN(d.getTime())) return esc(dateStr) + (timeStr ? ' ' + esc(timeStr) : '');
    var dd = pad(d.getDate()), mm = pad(d.getMonth() + 1), yy = d.getFullYear();
    if (timeStr) {
      var hh = pad(d.getHours()), mi = pad(d.getMinutes());
      return dd + '/' + mm + '/' + yy + ' at ' + hh + ':' + mi;
    }
    return dd + '/' + mm + '/' + yy;
  }

  function getQuery() {
    var idx = window.location.hash.indexOf('?');
    var qs = idx >= 0 ? window.location.hash.slice(idx + 1) : '';
    var out = {};
    new URLSearchParams(qs).forEach(function (v, k) { out[k] = v; });
    return out;
  }

  function pick(obj, keys) {
    if (!obj) return undefined;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }

  function seatKey(row, col) { return row + ':' + col; }

  function saveSession() {
    if (token && user) {
      localStorage.setItem('tbs_token', token);
      localStorage.setItem('tbs_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('tbs_token');
      localStorage.removeItem('tbs_user');
    }
  }

  function clearSession() {
    token = null;
    user = null;
    hold = null;
    claim = null;
    selectedSeats = [];
    stopPolling();
    stopCountdown();
    saveSession();
  }

  /* ============================================================
   * Toast + confirm modal
   * ============================================================ */
  function toast(message, type) {
    var region = $('#toastRegion');
    if (!region) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    region.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 4200);
  }

  function confirmDialog(title, message) {
    return new Promise(function (resolve) {
      $('#modalTitle').textContent = title || 'Confirm';
      $('#modalBody').textContent = message || '';
      $('#modalBackdrop').classList.remove('hidden');
      var ok = $('#modalOk'), cancel = $('#modalCancel');
      function cleanup(okValue) {
        $('#modalBackdrop').classList.add('hidden');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(okValue);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onKey(e) {
        if (e.key === 'Escape') cleanup(false);
        if (e.key === 'Enter') cleanup(true);
      }
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      $('#modalOk').focus();
    });
  }

  /* ============================================================
   * API client with auto-fallback to deployed Cloudflare Worker
   * ============================================================ */
  async function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var url = (API_BASE || '') + path;
    var res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      });
    } catch (err) {
      if (API_BASE !== REMOTE_API_BASE) {
        try {
          res = await fetch(REMOTE_API_BASE + path, {
            method: opts.method || 'GET',
            headers: headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
          });
        } catch (e2) {
          throw err;
        }
      } else {
        throw err;
      }
    }

    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    if (!res.ok) {
      var msg =
        (data && (data.error || data.message || data.msg)) ||
        'Request failed (' + res.status + ')';
      throw new Error(msg);
    }
    return data;
  }

  function extractList(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.seats)) return data.seats;
    if (data && Array.isArray(data.events)) return data.events;
    if (data && Array.isArray(data.venues)) return data.venues;
    if (data && Array.isArray(data.bookings)) return data.bookings;
    if (data && Array.isArray(data.items)) return data.items;
    return data && Array.isArray(data.data) ? data.data : [];
  }

  function extractBooking(b) {
    return (b && b.booking) ? b.booking : b;
  }

  function eventIdOf(ev) { return ev && (ev.id || ev._id || ev.eventId); }
  function eventIdOfBooking(b) {
    if (b.event && (b.event.id || b.event._id)) return b.event.id || b.event._id;
    return b.eventId || b.event_id;
  }

  function bookingRef(b) {
    return b.booking_ref || b.bookingRef || b.reference || b.ref || '';
  }

  function qrOf(b) {
    return b.qr_data_url || b.qrDataUrl || b.qr_data || b.qr || (b.qrCode && (b.qrCode.data_url || b.qrCode.url)) || null;
  }

  function pricingOf(ev) {
    var p = ev && (ev.pricing || ev.price);
    if (!p) return null;
    if (typeof p === 'number') return { min: p };
    if (typeof p.min === 'number' || typeof p.from === 'number') return p;
    return p;
  }

  function eventSoldOut(ev) {
    if (!ev) return false;
    if (ev.soldOut === true || ev.sold_out === true || ev.status === 'sold_out') return true;
    var av = ev.availableSeats !== undefined ? ev.availableSeats
      : (ev.seatsAvailable !== undefined ? ev.seatsAvailable
        : (ev.available_seats !== undefined ? ev.available_seats
          : (ev.seats_left !== undefined ? ev.seats_left
            : (ev.remaining !== undefined ? ev.remaining : null))));
    if (av !== null && av !== undefined && Number(av) === 0) return true;
    if (ev.totalSeats && ev.bookedSeats && Number(ev.totalSeats) <= Number(ev.bookedSeats)) return true;
    return false;
  }

  /* ============================================================
   * Router + nav
   * ============================================================ */
  function routeFor() {
    var hash = window.location.hash || '#/';
    var path = hash.split('?')[0].replace(/^#/, '') || '/';
    var parts = path.split('/').filter(Boolean);
    var first = parts[0] || '';

    if (first === 'event' && parts[1]) return { name: 'event', id: parts[1] };
    if (first === 'revenue' && parts[1]) return { name: 'revenue', id: parts[1] };
    if (first === 'events') return { name: 'events' };
    if (first === 'claim') return { name: 'claim' };
    if (first === 'login') return { name: 'login' };
    if (first === 'register') return { name: 'register' };
    if (first === 'bookings') return { name: 'bookings' };
    if (first === 'organiser') return { name: 'organiser' };
    if (first === 'admin') return { name: 'admin' };
    return { name: 'home' };
  }

  function navigate(path) {
    if (window.location.hash === '#' + path) render();
    else window.location.hash = path;
  }

  function renderNav() {
    var nav = $('#navLinks');
    var userBox = $('#navUser');
    if (!nav || !userBox) return;

    var active = routeFor().name;
    var links = [
      { href: '#/events', label: 'Browse Events', name: 'events' }
    ];

    if (user) {
      if (user.role === 'customer') {
        links.push({ href: '#/bookings', label: 'My Bookings', name: 'bookings' });
      } else if (user.role === 'organiser') {
        links.push({ href: '#/organiser', label: 'Organiser Dashboard', name: 'organiser' });
      } else if (user.role === 'admin') {
        links.push({ href: '#/admin', label: 'Admin Panel', name: 'admin' });
      }
    }

    var html = links.map(function (l) {
      return '<a href="' + l.href + '" class="nav-link' + (active === l.name ? ' active' : '') + '">' +
        esc(l.label) + '</a>';
    }).join('');

    if (!user) {
      html += '<a href="#/login" class="nav-link' + (active === 'login' ? ' active' : '') + '">Login</a>' +
              '<a href="#/register" class="btn btn-sm btn-primary" style="margin-left: 8px;">Register</a>';
    }

    nav.innerHTML = html;

    if (user) {
      userBox.innerHTML =
        '<div class="user-badge">' +
          '<span>' + esc(user.name || user.email || '') + '</span>' +
          '<span class="role-pill role-' + esc(user.role || 'customer') + '">' + esc(user.role || '') + '</span>' +
        '</div>' +
        '<button type="button" class="btn btn-sm btn-secondary" data-action="logout">Logout</button>';
    } else {
      userBox.innerHTML = '';
    }
  }

  function requireRole(role) {
    if (!user) {
      toast('Please log in first.', 'info');
      navigate('/login');
      return false;
    }
    if (role && user.role !== role) {
      toast('You do not have permission to access this page.', 'danger');
      navigate('/events');
      return false;
    }
    return true;
  }

  /* ============================================================
   * View lifecycle
   * ============================================================ */
  function render() {
    renderNav();
    stopPolling();
    stopCountdown();
    bookingComplete = false;
    var route = routeFor();

    switch (route.name) {
      case 'login': viewAuth('login'); break;
      case 'register': viewAuth('register'); break;
      case 'home': viewHome(); break;
      case 'events': viewBrowse(); break;
      case 'event': viewEvent(route.id); break;
      case 'bookings': viewBookings(); break;
      case 'organiser': viewOrganiser(); break;
      case 'revenue': viewRevenue(route.id); break;
      case 'admin': viewAdmin(); break;
      case 'claim': viewClaim(); break;
      default: viewHome();
    }
  }

  function viewHome() {
    if (!user) { navigate('/events'); return; }
    if (user.role === 'organiser') { navigate('/organiser'); return; }
    if (user.role === 'admin') { navigate('/admin'); return; }
    navigate('/events');
  }

  function setView(html) {
    var v = $('#view');
    if (v) v.innerHTML = html;
  }

  /* ============================================================
   * Auth views
   * ============================================================ */
  function viewAuth(mode) {
    var isLogin = mode === 'login';
    setView(
      '<div style="max-width: 440px; margin: 40px auto 0;" class="card">' +
        '<div style="display: flex; gap: 8px; margin-bottom: 24px; background: rgba(255,255,255,0.04); padding: 4px; border-radius: var(--radius-md);">' +
          '<button type="button" class="btn ' + (isLogin ? 'btn-primary' : 'btn-secondary') + '" style="flex: 1;" data-action="auth-tab" data-mode="login">Login</button>' +
          '<button type="button" class="btn ' + (!isLogin ? 'btn-primary' : 'btn-secondary') + '" style="flex: 1;" data-action="auth-tab" data-mode="register">Register</button>' +
        '</div>' +
        (isLogin ? loginFormHtml() : registerFormHtml()) +
      '</div>'
    );
  }

  function loginFormHtml() {
    return (
      '<form id="authForm" data-action="submit-auth" data-mode="login" novalidate>' +
        '<h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px;">Welcome Back</h2>' +
        '<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 24px;">Sign in to your account to manage bookings and events.</p>' +
        '<div class="form-group"><label for="email">Email Address</label>' +
          '<input id="email" name="email" type="email" class="form-control" placeholder="you@example.com" autocomplete="email" required></div>' +
        '<div class="form-group"><label for="password">Password</label>' +
          '<input id="password" name="password" type="password" class="form-control" autocomplete="current-password" required></div>' +
        '<button type="submit" class="btn btn-primary btn-lg" style="width: 100%; margin-top: 12px;">Sign In</button>' +
        '<div style="margin-top: 20px; font-size: 12px; color: var(--text-dim); text-align: center;">' +
          'Seeded Admin: <code>admin@example.com</code> / <code>admin123</code><br>' +
          'Seeded Organiser: <code>organiser@example.com</code> / <code>organiser123</code>' +
        '</div>' +
      '</form>'
    );
  }

  function registerFormHtml() {
    return (
      '<form id="authForm" data-action="submit-auth" data-mode="register" novalidate>' +
        '<h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px;">Create Account</h2>' +
        '<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 24px;">Join to reserve seats or host live events.</p>' +
        '<div class="form-group"><label for="name">Full Name</label>' +
          '<input id="name" name="name" type="text" class="form-control" placeholder="Jane Doe" autocomplete="name" required></div>' +
        '<div class="form-group"><label for="email">Email Address</label>' +
          '<input id="email" name="email" type="email" class="form-control" placeholder="you@example.com" autocomplete="email" required></div>' +
        '<div class="form-group"><label for="password">Password</label>' +
          '<input id="password" name="password" type="password" class="form-control" autocomplete="new-password" required></div>' +
        '<div class="form-group"><label>Account Role</label>' +
          '<div style="display: flex; gap: 16px; margin-top: 4px;">' +
            '<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px;"><input type="radio" name="role" value="customer" checked> Customer</label>' +
            '<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px;"><input type="radio" name="role" value="organiser"> Event Organiser</label>' +
          '</div></div>' +
        '<button type="submit" class="btn btn-primary btn-lg" style="width: 100%; margin-top: 12px;">Create Account</button>' +
      '</form>'
    );
  }

  async function submitAuth(form, mode) {
    var data = {
      email: form.email.value.trim(),
      password: form.password.value
    };
    if (mode === 'register') {
      data.name = form.name.value.trim();
      var roleEl = form.querySelector('input[name="role"]:checked');
      data.role = roleEl ? roleEl.value : 'customer';
      if (!data.name) return toast('Please enter your name.', 'warning');
    }
    if (!data.email || !data.password) return toast('Email and password are required.', 'warning');

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      var endpoint = mode === 'login' ? '/svc/auth/login' : '/svc/auth/register';
      var res = await api(endpoint, { method: 'POST', body: data });
      token = res.token;
      user = res.user;
      saveSession();
      toast('Welcome back, ' + (user.name || user.email) + '!', 'success');
      viewHome();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  /* ============================================================
   * Browse events
   * ============================================================ */
  async function viewBrowse() {
    setView('<div style="text-align:center; padding: 60px 0;"><p style="color: var(--text-muted);">Loading events...</p></div>');
    var q = getQuery().q || '';
    var type = (getQuery().type || '').toLowerCase();
    var date = getQuery().date || '';
    var params = new URLSearchParams();
    if (type) params.set('type', type);
    if (q) params.set('q', q);
    if (date) params.set('date', date);
    var qs = params.toString();

    var events = [];
    try {
      var data = await api('/svc/events' + (qs ? '?' + qs : ''));
      events = extractList(data);
    } catch (err) {
      setView('<div class="card" style="text-align:center; max-width: 500px; margin: 40px auto;"><h3 style="font-size: 20px; margin-bottom: 8px;">Could not load events</h3><p style="color: var(--text-muted); font-size: 14px;">' + esc(err.message) + '</p></div>');
      return;
    }

    var html =
      '<div class="hero">' +
        '<h1 class="hero-title">Experience Live Movies & Concerts</h1>' +
        '<p class="hero-subtitle">Select seats on real-time interactive maps, hold seats instantly with auto-TTL, and receive QR tickets straight to your inbox.</p>' +
      '</div>' +
      '<form id="filterForm" class="filter-bar" data-action="apply-filters">' +
        '<div class="search-box">' +
          '<span class="search-icon">🔍</span>' +
          '<input type="text" name="q" class="search-input" placeholder="Search events, movies, concerts, venues..." value="' + esc(q) + '">' +
        '</div>' +
        '<div class="type-pills">' +
          '<button type="button" class="pill' + (!type ? ' active' : '') + '" data-action="set-type" data-type="">All Events</button>' +
          '<button type="button" class="pill' + (type === 'movie' ? ' active' : '') + '" data-action="set-type" data-type="movie">Movies</button>' +
          '<button type="button" class="pill' + (type === 'concert' ? ' active' : '') + '" data-action="set-type" data-type="concert">Concerts</button>' +
        '</div>' +
      '</form>';

    if (!events.length) {
      html += '<div class="card" style="text-align:center; padding: 60px 20px;"><p style="color: var(--text-muted);">No events found matching your filter criteria.</p></div>';
    } else {
      html += '<div class="events-grid">' + events.map(eventCardHtml).join('') + '</div>';
    }
    setView(html);
  }

  function eventCardHtml(ev) {
    var price = pricingOf(ev);
    var priceText = 'Price on seat selection';
    if (price) {
      var min = price.min !== undefined ? price.min : price.from;
      if (min === undefined && typeof price === 'object') {
        var vals = Object.keys(price).map(function (k) { return Number(price[k]); })
          .filter(function (n) { return !isNaN(n); });
        if (vals.length) min = Math.min.apply(Math, vals);
      }
      if (min !== undefined && min !== null) priceText = 'From ' + money(min);
    }
    var venue = ev.venue;
    var venueName = venue ? (venue.name || venue) : (ev.venue_name || ev.venueName || 'Venue TBA');
    var soldOut = eventSoldOut(ev);
    var isMovie = (ev.type || '').toLowerCase() === 'movie';
    var badgeCls = isMovie ? 'badge-movie' : 'badge-concert';

    return (
      '<div class="card card-hover event-card">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">' +
          '<span class="event-type-badge ' + badgeCls + '">' + (isMovie ? '🎬 Movie' : '🎸 Concert') + '</span>' +
          (soldOut ? '<span class="role-pill" style="background:rgba(244,63,94,0.2); color:#f43f5e; border:1px solid rgba(244,63,94,0.3);">Sold Out</span>' : '') +
        '</div>' +
        '<h3 class="event-title">' + esc(ev.title || 'Untitled Event') + '</h3>' +
        '<p class="event-description">' + esc(ev.description || 'Join us for an unforgettable live experience.') + '</p>' +
        '<div class="event-meta">' +
          '<div class="event-meta-item"><span>📅</span> <span>' + esc(formatDateTime(ev.date, ev.time)) + '</span></div>' +
          '<div class="event-meta-item"><span>📍</span> <span>' + esc(venueName) + '</span></div>' +
        '</div>' +
        '<div class="event-footer">' +
          '<div class="pricing-preview">' +
            '<span class="pricing-label">Starting Price</span>' +
            '<span class="pricing-value">' + esc(priceText) + '</span>' +
          '</div>' +
          '<a class="btn ' + (soldOut ? 'btn-secondary' : 'btn-primary') + '" href="#/event/' + eventIdOf(ev) + '">' +
            (soldOut ? 'Waitlist' : 'Select Seats') + ' &rarr;</a>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================================================
   * Seat map + booking flow
   * ============================================================ */
  async function viewEvent(eventId) {
    setView('<div style="text-align:center; padding: 60px 0;"><p style="color: var(--text-muted);">Loading seat map...</p></div>');
    hold = null;
    selectedSeats = [];

    var query = getQuery();
    if (query.claim && claim && claim.token === query.claim) {
      selectedSeats = claim.seatIds || [];
    } else {
      claim = null;
    }

    var event = null;
    try {
      event = await api('/svc/events/' + eventId);
      if (event && event.event) event = event.event;
      eventCache[eventId] = event;
    } catch (err) {
      setView('<div class="card" style="text-align:center; max-width: 500px; margin: 40px auto;"><h3 style="font-size:20px; margin-bottom:8px;">Could not load event</h3><p style="color:var(--text-muted); font-size:14px;">' + esc(err.message) + '</p></div>');
      return;
    }

    var isMovie = (event.type || '').toLowerCase() === 'movie';
    var badgeCls = isMovie ? 'badge-movie' : 'badge-concert';

    var html = '<div id="eventView" data-event-id="' + esc(eventId) + '">' +
      '<div style="margin-bottom: 24px;">' +
        '<a href="#/events" style="font-weight: 600; font-size: 14px;">&larr; Back to Events</a>' +
      '</div>' +
      '<div class="card" style="margin-bottom: 32px;">' +
        '<div style="display:flex; gap: 12px; align-items: center; margin-bottom: 8px;">' +
          '<span class="event-type-badge ' + badgeCls + '">' + (isMovie ? '🎬 Movie' : '🎸 Concert') + '</span>' +
          '<span style="color: var(--text-muted); font-size: 14px;">📍 ' + esc((event.venue && (event.venue.name || event.venue)) || event.venue_name || 'Venue') + '</span>' +
        '</div>' +
        '<h1 style="font-size: 32px; font-weight: 800; letter-spacing: -0.8px; margin-bottom: 8px;">' + esc(event.title || 'Event') + '</h1>' +
        '<p style="color: var(--text-muted); font-size: 15px;">📅 ' + esc(formatDateTime(event.date, event.time)) + '</p>' +
      '</div>' +
      '<div class="seatmap-container">' +
        '<div class="card">' +
          '<div class="screen-bar"><span class="screen-label">STAGE / SCREEN</span></div>' +
          '<div id="seatMapRegion"></div>' +
        '</div>' +
        '<div>' +
          '<div id="bookingRegion"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
    setView(html);

    await refreshSeatMap(eventId, event);
    startPolling(eventId, event);
  }

  function startPolling(eventId, event) {
    stopPolling();
    pollTimer = setInterval(function () {
      if (!document.getElementById('seatMapRegion')) { stopPolling(); return; }
      refreshSeatMap(eventId, event, true);
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function seatLabel(key) {
    var p = key.split(':');
    var rowIdx = Number(p[0]);
    var rowLetter = String.fromCharCode(65 + rowIdx);
    var colNum = Number(p[1]) + 1;
    return rowLetter + colNum;
  }

  async function refreshSeatMap(eventId, event, isPoll) {
    var region = $('#seatMapRegion');
    if (!region) return;

    var seatsData = null;
    try {
      seatsData = await api('/svc/events/' + eventId + '/seats');
    } catch (e) { return; }

    var seats = extractList(seatsData);
    if (!seats.length) {
      region.innerHTML = '<p style="color:var(--text-muted); text-align:center;">No seat map configured for this venue.</p>';
      return;
    }

    var maxRow = 0, maxCol = 0;
    seatIdMap = {};
    var seatsByKey = {};
    var categoryCounts = {};
    var availableCount = 0;

    seats.forEach(function (s) {
      var r = Number(s.seat_row !== undefined ? s.seat_row : s.row);
      var c = Number(s.seat_col !== undefined ? s.seat_col : s.col);
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
      var key = seatKey(r, c);
      seatsByKey[key] = s;
      if (s.id) seatIdMap[key] = s.id;

      var cat = s.category_name || s.category || 'Standard';
      categoryCounts[cat] = categoryCounts[cat] || { total: 0, available: 0 };
      categoryCounts[cat].total++;

      var status = s.status || 'available';
      if (status === 'available') {
        categoryCounts[cat].available++;
        availableCount++;
      }
    });

    var soldOut = availableCount === 0;

    var gridHtml = '<div class="seat-grid-wrapper"><div class="seat-grid" style="grid-template-columns: repeat(' + (maxCol + 2) + ', min-content);">';
    for (var r = 0; r <= maxRow; r++) {
      var rowLetter = String.fromCharCode(65 + r);
      gridHtml += '<div class="seat-row">' + '<div class="row-label">' + rowLetter + '</div>';
      for (var c = 0; c <= maxCol; c++) {
        var key = seatKey(r, c);
        var s = seatsByKey[key];
        if (!s) {
          gridHtml += '<div class="seat" style="visibility:hidden;"></div>';
          continue;
        }

        var status = s.status || 'available';
        var isSelected = selectedSeats.indexOf(key) >= 0;
        var isHeldByMe = hold && Array.isArray(hold.seatIds) && hold.seatIds.indexOf(key) >= 0;

        var cls = 'seat';
        var cat = s.category_name || s.category || 'Standard';
        if (cat.toLowerCase().indexOf('premium') >= 0) cls += ' category-premium';

        if (isSelected) cls += ' selected';
        else if (isHeldByMe) cls += ' held-by-me';
        else if (status === 'held') cls += ' held';
        else if (status === 'booked') cls += ' booked';
        else cls += ' available';

        gridHtml += '<div class="' + cls + '" data-action="toggle-seat" data-key="' + key + '" title="Row ' + rowLetter + ', Seat ' + (c + 1) + ' (' + esc(cat) + ')">' +
          (isSelected ? '✓' : (c + 1)) +
          '</div>';
      }
      gridHtml += '</div>';
    }
    gridHtml += '</div></div>';

    gridHtml += '<div class="legend-bar">' +
      '<div class="legend-item"><div class="legend-swatch" style="background: rgba(16,185,129,0.25); border: 1px solid #10b981;"></div> Available</div>' +
      '<div class="legend-item"><div class="legend-swatch" style="background: var(--accent-gradient);"></div> Selected</div>' +
      '<div class="legend-item"><div class="legend-swatch" style="background: var(--amber-gradient);"></div> Held by You</div>' +
      '<div class="legend-item"><div class="legend-swatch" style="background: rgba(255,255,255,0.05);"></div> Booked</div>' +
    '</div>';

    region.innerHTML = gridHtml;

    if (!document.querySelector('#bookingRegion .success-box')) {
      renderBookingPanel(event, eventId, seats, availableCount, soldOut);
    }
  }

  function renderBookingPanel(event, eventId, seats, availableCount, soldOut) {
    var region = $('#bookingRegion');
    if (!region) return;
    if (bookingComplete) return;

    var hasHold = hold && String(hold.eventId) === String(eventId);
    var hasClaim = claim && String(claim.eventId) === String(eventId);
    var selectedCount = selectedSeats.length;
    var price = pricingOf(event);

    var html = '<div class="card">';

    if (hasClaim) {
      html += '<div class="countdown-box" style="background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.4);">' +
        '<h4 style="font-size: 16px; font-weight: 700; color: #a5b4fc; margin-bottom: 4px;">🎉 Waitlist Seat Offered!</h4>' +
        '<p style="font-size: 13px; color: var(--text-muted);">Complete checkout before the offer expires.</p>' +
      '</div>';
    } else if (hasHold) {
      html += '<div class="countdown-box">' +
        '<div style="font-size: 12px; font-weight: 700; color: var(--amber); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Seat Hold Expires In</div>' +
        '<div class="countdown-time" id="countdownTimer">10:00</div>' +
      '</div>';
      startHoldCountdown(hold.expiresAt);
    }

    if (soldOut && !hasHold && !hasClaim) {
      html += '<h3 style="font-size: 20px; font-weight: 700; margin-bottom: 8px;">Event Sold Out</h3>' +
        '<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;">Join the waitlist to receive an automated notification if seats become available.</p>' +
        '<form id="waitlistForm" data-action="submit-waitlist" data-event-id="' + esc(eventId) + '">' +
          '<div class="form-group"><label>Category</label>' +
            '<select name="category" class="form-control" required>' +
              Object.keys(price || { Standard: 0 }).map(function (cat) {
                return '<option value="' + esc(cat) + '">' + esc(cat) + '</option>';
              }).join('') +
            '</select></div>' +
          '<button type="submit" class="btn btn-emerald btn-lg" style="width: 100%;">Join Waitlist</button>' +
        '</form>';
    } else if (!hasHold && !hasClaim) {
      html += '<h3 style="font-size: 20px; font-weight: 700; margin-bottom: 8px;">Select Your Seats</h3>' +
        '<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;">Choose up to ' + MAX_SELECTABLE + ' seats on the grid to place a temporary 10-minute hold.</p>' +
        '<div style="margin-bottom: 20px;">' +
          '<div style="font-size: 13px; color: var(--text-muted);">Selected Seats: <strong>' + (selectedCount ? selectedSeats.map(seatLabel).join(', ') : 'None') + '</strong></div>' +
        '</div>' +
        '<button type="button" class="btn btn-primary btn-lg" style="width: 100%;" data-action="hold-seats" data-event-id="' + esc(eventId) + '"' + (!selectedCount ? ' disabled' : '') + '>' +
          'Hold Selected Seats (' + selectedCount + ')</button>';
    } else {
      var defaultName = user ? user.name || '' : '';
      var defaultEmail = user ? user.email || '' : '';
      html += '<h3 style="font-size: 20px; font-weight: 700; margin-bottom: 8px;">Complete Checkout</h3>' +
        '<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;">Seats: <strong>' + selectedSeats.map(seatLabel).join(', ') + '</strong></p>' +
        '<form id="checkoutForm" data-action="submit-booking" data-event-id="' + esc(eventId) + '">' +
          '<div class="form-group"><label for="customerName">Full Name</label>' +
            '<input id="customerName" name="customerName" type="text" class="form-control" value="' + esc(defaultName) + '" required></div>' +
          '<div class="form-group"><label for="customerEmail">Email Address (for QR Ticket)</label>' +
            '<input id="customerEmail" name="customerEmail" type="email" class="form-control" value="' + esc(defaultEmail) + '" required></div>' +
          '<button type="submit" class="btn btn-emerald btn-lg" style="width: 100%; margin-top: 12px;">Confirm & Book Now</button>' +
        '</form>';
    }

    html += '</div>';
    region.innerHTML = html;
  }

  function startHoldCountdown(expiresAt) {
    stopCountdown();
    var timerEl = $('#countdownTimer');
    if (!timerEl || !expiresAt) return;

    function update() {
      var rem = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      var m = Math.floor(rem / 60);
      var s = rem % 60;
      if (timerEl) timerEl.textContent = pad(m) + ':' + pad(s);
      if (rem <= 0) {
        stopCountdown();
        hold = null;
        selectedSeats = [];
        toast('Hold expired. Seats released.', 'warning');
        render();
      }
    }
    update();
    countdownTimer = setInterval(update, 1000);
  }

  /* ============================================================
   * Actions & Event Listeners
   * ============================================================ */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;

    if (action === 'auth-tab') {
      viewAuth(btn.dataset.mode);
    } else if (action === 'logout') {
      clearSession();
      toast('Logged out.', 'info');
      navigate('/events');
    } else if (action === 'set-type') {
      var t = btn.dataset.type || '';
      var params = new URLSearchParams(window.location.hash.split('?')[1] || '');
      if (t) params.set('type', t); else params.delete('type');
      navigate('/events' + (params.toString() ? '?' + params.toString() : ''));
    } else if (action === 'toggle-seat') {
      var key = btn.dataset.key;
      if (!key) return;
      var idx = selectedSeats.indexOf(key);
      if (idx >= 0) {
        selectedSeats.splice(idx, 1);
      } else {
        if (selectedSeats.length >= MAX_SELECTABLE) {
          toast('You can select at most ' + MAX_SELECTABLE + ' seats.', 'warning');
          return;
        }
        selectedSeats.push(key);
      }
      var evId = $('#eventView') ? $('#eventView').dataset.eventId : null;
      if (evId) refreshSeatMap(evId, eventCache[evId]);
    } else if (action === 'hold-seats') {
      holdSelectedSeats(btn.dataset.eventId);
    } else if (action === 'toggle-booking-detail') {
      toggleBookingDetail(btn.dataset.ref, btn);
    } else if (action === 'cancel-booking') {
      cancelBooking(btn.dataset.ref, btn.dataset.eventId);
    } else if (action === 'view-revenue') {
      navigate('/revenue/' + btn.dataset.eventId);
    }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-action]');
    if (!form) return;
    e.preventDefault();
    var action = form.dataset.action;

    if (action === 'submit-auth') {
      submitAuth(form, form.dataset.mode);
    } else if (action === 'apply-filters') {
      var q = form.q ? form.q.value.trim() : '';
      var type = form.type ? form.type.value : '';
      var date = form.date ? form.date.value : '';
      var params = new URLSearchParams();
      if (type) params.set('type', type);
      if (q) params.set('q', q);
      if (date) params.set('date', date);
      navigate('/events' + (params.toString() ? '?' + params.toString() : ''));
    } else if (action === 'submit-booking') {
      submitBooking(form, form.dataset.eventId);
    } else if (action === 'submit-waitlist') {
      submitWaitlist(form, form.dataset.eventId);
    } else if (action === 'create-event') {
      createEvent(form);
    } else if (action === 'create-venue') {
      createVenue(form);
    }
  });

  async function holdSelectedSeats(eventId) {
    if (!selectedSeats.length) return;
    if (!user) {
      toast('Please log in to reserve seats.', 'info');
      navigate('/login');
      return;
    }

    var ids = selectedSeats.map(function (k) { return seatIdMap[k]; }).filter(Boolean);
    if (ids.length !== selectedSeats.length) {
      return toast('Some selected seats are invalid.', 'danger');
    }

    try {
      var res = await api('/svc/events/' + eventId + '/hold', {
        method: 'POST',
        body: { seatIds: ids }
      });
      hold = {
        eventId: eventId,
        seatIds: selectedSeats.slice(),
        tokens: res.holdToken || res.tokens || [],
        expiresAt: res.expiresAt || (Date.now() + 10 * 60 * 1000)
      };
      toast('Seats held for 10 minutes.', 'success');
      await refreshSeatMap(eventId, eventCache[eventId]);
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function submitBooking(form, eventId) {
    var name = form.customerName.value.trim();
    var email = form.customerEmail.value.trim();
    if (!name || !email) return toast('Name and email are required.', 'warning');

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    bookingComplete = true;

    try {
      var payload = { customerName: name, customerEmail: email };
      if (hold && String(hold.eventId) === String(eventId)) {
        payload.holdToken = hold.tokens;
      } else if (claim && String(claim.eventId) === String(eventId)) {
        payload.claimToken = claim.token;
      } else {
        payload.seatIds = selectedSeats.map(function (k) { return seatIdMap[k]; }).filter(Boolean);
      }

      var res = await api('/svc/events/' + eventId + '/book', {
        method: 'POST',
        body: payload
      });

      var booking = extractBooking(res);
      if (res && Array.isArray(res.bookings) && res.bookings.length) booking = res.bookings[0];
      var ref = bookingRef(booking) || (res.booking_ref || res.bookingRef || res.reference || '');
      var qr = qrOf(booking) || qrOf(res);

      hold = null;
      selectedSeats = [];
      claim = null;
      stopCountdown();
      stopPolling();
      bookingComplete = true;

      $('#bookingRegion').innerHTML =
        '<div class="card success-box">' +
          '<div class="check-icon">✓</div>' +
          '<h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px;">Booking Confirmed!</h2>' +
          '<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;">Your ticket with QR code has been delivered to <strong>' + esc(email) + '</strong>.</p>' +
          (ref ? '<div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: var(--radius-md); font-family: monospace; font-size: 16px; margin-bottom: 20px;">Reference: <strong>' + esc(ref) + '</strong></div>' : '') +
          (qr ? '<div style="background: #fff; padding: 16px; border-radius: 12px; display: inline-block; margin-bottom: 20px;"><img src="' + esc(qr) + '" style="width: 160px; height: 160px;" alt="QR Ticket"></div>' : '') +
          '<div><a href="#/events" class="btn btn-primary btn-lg">Browse More Events</a></div>' +
        '</div>';
    } catch (err) {
      bookingComplete = false;
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  async function submitWaitlist(form, eventId) {
    var category = form.category.value;
    if (!category) return toast('Please select a seat category.', 'warning');
    if (!user) {
      toast('Please log in to join the waitlist.', 'info');
      navigate('/login');
      return;
    }

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/svc/events/' + eventId + '/waitlist', {
        method: 'POST',
        body: { category: category }
      });
      stopPolling();
      bookingComplete = true;
      toast('You joined the waitlist for ' + category + '.', 'success');
      $('#bookingRegion').innerHTML =
        '<div class="card success-box">' +
          '<div class="check-icon">📋</div>' +
          '<h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px;">Waitlist Joined</h2>' +
          '<p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;">Category: <strong>' + esc(category) + '</strong>. If a seat opens up, you will receive an email with a link to claim it.</p>' +
          '<div><a href="#/events" class="btn btn-primary">Browse Events</a></div>' +
        '</div>';
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  /* ============================================================
   * Customer Bookings View
   * ============================================================ */
  async function viewBookings() {
    if (!requireRole('customer')) return;
    setView('<div style="text-align:center; padding: 60px 0;"><p style="color: var(--text-muted);">Loading bookings...</p></div>');

    var bookings = [];
    try {
      bookings = extractList(await api('/svc/bookings'));
    } catch (err) {
      setView('<div class="card" style="text-align:center; max-width: 500px; margin: 40px auto;"><h3 style="font-size: 20px; margin-bottom: 8px;">Could not load bookings</h3><p style="color: var(--text-muted); font-size: 14px;">' + esc(err.message) + '</p></div>');
      return;
    }

    if (!bookings.length) {
      setView('<div class="hero"><h1 class="hero-title">My Bookings</h1><p class="hero-subtitle">You have no active or past ticket bookings.</p><a href="#/events" class="btn btn-primary btn-lg">Explore Events</a></div>');
      return;
    }

    var html = '<div class="section-head" style="margin-bottom: 24px;"><h1 style="font-size: 32px; font-weight: 800;">My Ticket Bookings</h1></div><div style="display: flex; flex-direction: column; gap: 20px;">' +
      bookings.map(function (b) {
        var ref = bookingRef(b);
        var evId = eventIdOfBooking(b);
        var eventTitle = (b.event && (b.event.title || b.event.name)) || b.event_title || b.eventTitle || 'Event';
        var status = b.status || b.state || 'active';
        var isCancelled = status === 'cancelled' || status === 'canceled';

        var seats = b.seats || b.seatIds || [];
        var seatText = '';
        if (Array.isArray(seats)) seatText = seats.map(function (s) {
          return typeof s === 'string' ? s : seatLabel(String(s.row) + ':' + String(s.col));
        }).join(', ');
        else if (seats) seatText = String(seats);
        if (!seatText && b.seat_row !== undefined && b.seat_col !== undefined) {
          seatText = seatLabel(String(b.seat_row) + ':' + String(b.seat_col));
        }

        return (
          '<div class="card" data-ref="' + esc(ref) + '" data-event-id="' + esc(evId || '') + '">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">' +
              '<div><strong style="font-size: 18px;">' + esc(eventTitle) + '</strong> ' +
                '<span class="role-pill" style="margin-left: 8px;' + (isCancelled ? 'background:rgba(244,63,94,0.2); color:#f43f5e;' : 'background:rgba(16,185,129,0.2); color:#34d399;') + '">' + esc(status) + '</span></div>' +
              '<span style="color: var(--text-dim); font-size: 13px;">Ref: ' + esc(ref || 'TB-REF') + '</span>' +
            '</div>' +
            '<div style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px;">' +
              'Seat(s): <strong>' + esc(seatText || 'Reserved') + '</strong> &middot; Date: ' + esc(formatDateTime(b.date || b.created_at || b.createdAt, '')) +
            '</div>' +
            '<div style="display:flex; gap: 12px;">' +
              '<button type="button" class="btn btn-secondary btn-sm" data-action="toggle-booking-detail" data-ref="' + esc(ref) + '">Show Ticket & QR Code</button>' +
              (!isCancelled && evId ? '<button type="button" class="btn btn-danger btn-sm" data-action="cancel-booking" data-ref="' + esc(ref) + '" data-event-id="' + esc(evId) + '">Cancel Booking</button>' : '') +
            '</div>' +
            '<div class="hidden" data-detail="' + esc(ref) + '" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.06); text-align:center;"></div>' +
          '</div>'
        );
      }).join('') + '</div>';
    setView(html);
  }

  async function toggleBookingDetail(ref, btn) {
    var body = document.querySelector('[data-detail="' + ref + '"]');
    if (!body) return;
    if (!body.classList.contains('hidden')) {
      body.classList.add('hidden');
      return;
    }
    body.classList.remove('hidden');
    body.innerHTML = '<p style="color:var(--text-muted); font-size:14px;">Loading ticket details...</p>';
    try {
      var res = await api('/svc/bookings/' + encodeURIComponent(ref));
      var booking = extractBooking(res);
      var qr = qrOf(booking) || qrOf(res);
      body.innerHTML =
        (qr
          ? '<div style="background:#ffffff; padding: 20px; border-radius: 16px; display: inline-block; margin-bottom: 16px;">' +
              '<img src="' + esc(qr) + '" style="width: 180px; height: 180px;" alt="Ticket QR code">' +
            '</div>'
          : '<p style="color:var(--text-muted); margin-bottom: 12px;">QR Code generated upon check-in.</p>') +
        '<p style="font-size:13px; color:var(--text-dim);">Present this ticket QR at venue entry.</p>';
    } catch (err) {
      body.innerHTML = '<p style="color:var(--text-muted);">Ticket detail ready. Reference: ' + esc(ref) + '</p>';
    }
  }

  async function cancelBooking(ref, eventId) {
    var ok = await confirmDialog(
      'Cancel Ticket Booking?',
      'Are you sure you want to cancel booking ' + ref + '? Released seats will automatically be offered to waitlisted customers.'
    );
    if (!ok) return;
    try {
      await api('/svc/events/' + encodeURIComponent(eventId) + '/cancel', {
        method: 'POST',
        body: { booking_ref: ref }
      });
      toast('Booking ' + ref + ' cancelled.', 'success');
      viewBookings();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /* ============================================================
   * Organiser & Admin Control Panels
   * ============================================================ */
  async function viewOrganiser() {
    if (!requireRole('organiser')) return;
    setView('<div style="text-align:center; padding: 60px 0;"><p style="color: var(--text-muted);">Loading organiser dashboard...</p></div>');

    var events = [];
    try {
      events = extractList(await api('/svc/organiser/events'));
    } catch (err) {
      setView('<div class="card" style="text-align:center; max-width: 500px; margin: 40px auto;"><h3 style="font-size:20px; margin-bottom:8px;">Could not load events</h3><p style="color:var(--text-muted); font-size:14px;">' + esc(err.message) + '</p></div>');
      return;
    }

    var html = '<div style="margin-bottom: 32px;"><h1 style="font-size: 32px; font-weight: 800; margin-bottom: 8px;">Organiser Dashboard</h1><p style="color:var(--text-muted);">Create live event listings and track seat reservations & revenue.</p></div>';

    html += '<div class="card" style="margin-bottom: 32px;"><h3 style="font-size: 20px; font-weight: 700; margin-bottom: 20px;">Create New Event Listing</h3>' +
      '<form id="createEventForm" data-action="create-event" novalidate>' +
        '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;">' +
          '<div class="form-group"><label>Venue</label><select name="venueId" id="venueSelect" class="form-control" required></select></div>' +
          '<div class="form-group"><label>Event Title</label><input name="title" class="form-control" type="text" placeholder="e.g. Rock Fest 2026" required></div>' +
          '<div class="form-group"><label>Event Type</label><select name="type" class="form-control" required>' +
            '<option value="movie">Movie</option><option value="concert">Concert</option></select></div>' +
          '<div class="form-group"><label>Date</label><input name="date" class="form-control" type="date" required></div>' +
          '<div class="form-group"><label>Time</label><input name="time" class="form-control" type="time" required></div>' +
        '</div>' +
        '<div class="form-group"><label>Description</label><textarea name="description" class="form-control" rows="2" placeholder="Brief event summary..."></textarea></div>' +
        '<div id="priceFields" style="margin-bottom: 20px;"><p style="color:var(--text-muted); font-size:13px;">Select a venue to configure category pricing.</p></div>' +
        '<button type="submit" class="btn btn-primary btn-lg">Publish Event</button>' +
      '</form></div>';

    html += '<h3 style="font-size: 22px; font-weight: 700; margin-bottom: 20px;">My Event Listings</h3>';
    if (!events.length) {
      html += '<div class="card" style="text-align:center; padding: 40px;"><p style="color:var(--text-muted);">No events published yet.</p></div>';
    } else {
      html += '<div style="display:flex; flex-direction:column; gap: 16px;">' + events.map(function (ev) {
        return (
          '<div class="card" data-event-id="' + esc(eventIdOf(ev)) + '">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">' +
              '<div><strong style="font-size: 18px;">' + esc(ev.title || 'Untitled') + '</strong> ' +
                '<span class="event-type-badge badge-' + esc((ev.type||'movie').toLowerCase()) + '" style="margin-left: 8px;">' + esc(ev.type || '') + '</span></div>' +
              '<span style="color:var(--text-muted); font-size:13px;">📅 ' + esc(formatDateTime(ev.date, ev.time)) + '</span>' +
            '</div>' +
            '<div style="display:flex; gap: 12px; margin-top: 16px;">' +
              '<a class="btn btn-sm btn-primary" href="#/event/' + eventIdOf(ev) + '">View Seat Map</a>' +
              '<button type="button" class="btn btn-sm btn-secondary" data-action="view-revenue" data-event-id="' + esc(eventIdOf(ev)) + '">Revenue Report</button>' +
            '</div>' +
          '</div>'
        );
      }).join('') + '</div>';
    }

    setView(html);
    loadVenueOptions();
  }

  async function loadVenueOptions() {
    var select = $('#venueSelect');
    if (!select) return;
    var venues = [];
    try {
      venues = extractList(await api('/svc/venues'));
    } catch (e1) {
      try { venues = extractList(await api('/svc/admin/venues')); } catch (e2) {}
    }
    if (!venues.length) {
      select.innerHTML = '<option value="">No venues available</option>';
      return;
    }
    select.innerHTML = venues.map(function (v) {
      var cats = v.categories || v.category || [];
      if (Array.isArray(cats)) cats = cats.map(function (c) {
        return (c && c.category_name) || (c && c.name) || c;
      });
      return '<option value="' + esc(eventIdOf(v)) + '" data-categories="' +
        esc(JSON.stringify(cats)) + '">' +
        esc(v.name || 'Venue') + (v.address ? ' - ' + esc(v.address) : '') + '</option>';
    }).join('');

    select.addEventListener('change', function () {
      if (select.selectedIndex >= 0) renderPriceFields(select.options[select.selectedIndex]);
    });
    if (venues.length) renderPriceFields(select.options[select.selectedIndex]);
  }

  function renderPriceFields(optionEl) {
    var box = $('#priceFields');
    if (!box || !optionEl) return;
    var cats = [];
    try { cats = JSON.parse(optionEl.dataset.categories || '[]'); } catch (e) { cats = []; }
    if (!cats.length) cats = ['Premium', 'Standard'];
    cats = cats.map(function (c) { return (c && c.category_name) || (c && c.name) || c; });
    box.innerHTML =
      '<label style="font-size: 13px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 8px;">Category Pricing ($)</label>' +
      '<div style="display:flex; gap: 16px; flex-wrap: wrap;">' +
      cats.map(function (c) {
        return '<div style="flex: 1; min-width: 140px;"><label style="font-size: 12px; color: var(--text-dim);">' + esc(c) + '</label>' +
          '<input type="number" name="price_' + esc(c) + '" class="form-control" min="0" step="0.01" placeholder="50.00"></div>';
      }).join('') + '</div>';
  }

  async function createEvent(form) {
    var venueId = form.venueId.value;
    var title = form.title.value.trim();
    var type = (form.type.value || '').toLowerCase();
    var date = form.date.value;
    var time = form.time.value;
    if (!venueId || !title || !date || !time) return toast('Please fill in venue, title, date and time.', 'warning');

    var pricing = {};
    $$('input[name^="price_"]', form).forEach(function (input) {
      if (input.value !== '') pricing[input.name.replace('price_', '')] = Number(input.value);
    });
    if (!Object.keys(pricing).length) pricing = { Premium: 50, Standard: 30 };

    var body = {
      venue_id: venueId,
      title: title,
      type: type,
      date: date,
      time: time,
      description: form.description.value.trim(),
      pricing: pricing
    };

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/svc/organiser/events', { method: 'POST', body: body });
      toast('Event created successfully.', 'success');
      viewOrganiser();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  async function viewRevenue(eventId) {
    if (!requireRole('organiser')) return;
    setView('<div style="text-align:center; padding: 60px 0;"><p style="color: var(--text-muted);">Loading revenue details...</p></div>');
    try {
      var data = await api('/svc/organiser/events/' + eventId + '/revenue');
      var cats = data.per_category || data.by_category || [];
      var total = data.total || { count: 0, revenue: 0 };

      var html = '<div style="margin-bottom: 24px;"><a href="#/organiser" style="font-weight:600;">&larr; Back to Organiser Dashboard</a></div>' +
        '<div class="card" style="margin-bottom: 32px;">' +
          '<h2 style="font-size: 28px; font-weight: 800; margin-bottom: 8px;">Revenue Report</h2>' +
          '<p style="color:var(--text-muted);">Active Bookings: <strong>' + (total.count || 0) + '</strong> &middot; Total Revenue: <strong>' + money(total.revenue || 0) + '</strong></p>' +
        '</div>' +
        '<div class="card"><h3 style="font-size: 18px; font-weight: 700; margin-bottom: 16px;">Breakdown by Category</h3>' +
          '<div class="table-responsive"><table class="table"><thead><tr><th>Category</th><th>Booked Seats</th><th>Revenue</th></tr></thead><tbody>' +
            cats.map(function (c) {
              return '<tr><td>' + esc(c.category || c.category_name || 'Standard') + '</td><td>' + (c.booked || c.count || 0) + '</td><td>' + money(c.revenue || 0) + '</td></tr>';
            }).join('') +
          '</tbody></table></div>' +
        '</div>';
      setView(html);
    } catch (err) {
      setView('<div class="card" style="text-align:center;"><p>Could not load revenue: ' + esc(err.message) + '</p></div>');
    }
  }

  async function viewAdmin() {
    if (!requireRole('admin')) return;
    setView('<div style="text-align:center; padding: 60px 0;"><p style="color: var(--text-muted);">Loading admin panel...</p></div>');

    var venues = [];
    try {
      venues = extractList(await api('/svc/admin/venues'));
    } catch (err) {
      setView('<div class="card" style="text-align:center;"><p>Could not load venues: ' + esc(err.message) + '</p></div>');
      return;
    }

    var html = '<div style="margin-bottom: 32px;"><h1 style="font-size: 32px; font-weight: 800; margin-bottom: 8px;">Admin Panel</h1><p style="color:var(--text-muted);">Configure venues, seat grid layouts, and categories.</p></div>';

    html += '<div class="card" style="margin-bottom: 32px;"><h3 style="font-size: 20px; font-weight: 700; margin-bottom: 20px;">Create Venue</h3>' +
      '<form id="createVenueForm" data-action="create-venue" novalidate>' +
        '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">' +
          '<div class="form-group"><label>Venue Name</label><input name="name" class="form-control" placeholder="Grand Cinemax" required></div>' +
          '<div class="form-group"><label>Address</label><input name="address" class="form-control" placeholder="12 Downtown Ave"></div>' +
          '<div class="form-group"><label>Rows</label><input name="rows" class="form-control" type="number" min="1" max="20" value="8" required></div>' +
          '<div class="form-group"><label>Columns</label><input name="cols" class="form-control" type="number" min="1" max="20" value="10" required></div>' +
        '</div>' +
        '<div class="form-group"><label>Categories (comma separated)</label><input name="categories" class="form-control" value="Premium, Standard"></div>' +
        '<button type="submit" class="btn btn-primary btn-lg">Save Venue</button>' +
      '</form></div>';

    html += '<h3 style="font-size: 22px; font-weight: 700; margin-bottom: 20px;">Configured Venues</h3>';
    if (!venues.length) {
      html += '<div class="card" style="text-align:center; padding: 40px;"><p style="color:var(--text-muted);">No venues configured yet.</p></div>';
    } else {
      html += '<div style="display:flex; flex-direction:column; gap: 16px;">' + venues.map(function (v) {
        return (
          '<div class="card">' +
            '<h4 style="font-size: 18px; font-weight: 700; margin-bottom: 4px;">' + esc(v.name || 'Venue') + '</h4>' +
            '<p style="color:var(--text-muted); font-size:14px;">Address: ' + esc(v.address || 'N/A') + ' &middot; Grid: ' + v.rows + 'x' + v.cols + ' (' + (v.rows * v.cols) + ' total seats)</p>' +
          '</div>'
        );
      }).join('') + '</div>';
    }

    setView(html);
  }

  async function createVenue(form) {
    var name = form.name.value.trim();
    var address = form.address.value.trim();
    var rows = Number(form.rows.value);
    var cols = Number(form.cols.value);
    var catsStr = form.categories.value.trim();
    if (!name || !rows || !cols) return toast('Name, rows, and columns are required.', 'warning');

    var categories = catsStr ? catsStr.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : ['Standard'];

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/svc/admin/venues', {
        method: 'POST',
        body: { name: name, address: address, rows: rows, cols: cols, categories: categories }
      });
      toast('Venue created successfully.', 'success');
      viewAdmin();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  /* ============================================================
   * Waitlist Claim Offer View
   * ============================================================ */
  async function viewClaim() {
    var token = getQuery().token;
    if (!token) {
      setView('<div class="card" style="text-align:center;"><p>Invalid claim token.</p></div>');
      return;
    }

    setView('<div style="text-align:center; padding: 60px 0;"><p style="color: var(--text-muted);">Validating waitlist offer...</p></div>');

    try {
      var res = await api('/svc/waitlist/offer/' + encodeURIComponent(token), { method: 'POST' });
      claim = {
        token: token,
        eventId: res.event_id || res.eventId,
        seatIds: res.seat ? [seatKey(res.seat.row || res.seat.seat_row, res.seat.col || res.seat.seat_col)] : [],
        expiresAt: res.expiresAt
      };
      toast('Waitlist seat claim valid! Complete checkout below.', 'success');
      navigate('/event/' + claim.eventId + '?claim=' + encodeURIComponent(token));
    } catch (err) {
      setView('<div class="card" style="text-align:center; max-width: 500px; margin: 40px auto;"><h3 style="font-size:20px; margin-bottom:8px;">Offer Expired or Invalid</h3><p style="color:var(--text-muted); font-size:14px;">' + esc(err.message) + '</p><a href="#/events" class="btn btn-primary mt" style="margin-top:16px;">Browse Events</a></div>');
    }
  }

  /* ============================================================
   * Initial entry
   * ============================================================ */
  window.addEventListener('hashchange', render);
  document.addEventListener('DOMContentLoaded', render);
})();