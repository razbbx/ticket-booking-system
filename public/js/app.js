/* ============================================================
 * Ticket Booking System - Frontend (vanilla JS, hash-routed SPA)
 * ============================================================ */
(function () {
  'use strict';

  var API_BASE = '';            // same origin; backend serves public/ + /api/*
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
   * API client
   * ============================================================ */
  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var res = await fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });

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
    var html = '';
    var active = routeFor().name;

    var links = [];
    links.push({ href: '#/events', label: 'Browse Events', name: 'events' });

    if (user) {
      if (user.role === 'customer') {
        links.push({ href: '#/bookings', label: 'My Bookings', name: 'bookings' });
      } else if (user.role === 'organiser') {
        links.push({ href: '#/organiser', label: 'Dashboard', name: 'organiser' });
      } else if (user.role === 'admin') {
        links.push({ href: '#/admin', label: 'Admin Panel', name: 'admin' });
      }
    }

    html = links.map(function (l) {
      return '<a href="' + l.href + '"' + (active === l.name ? ' class="active"' : '') + '>' +
        esc(l.label) + '</a>';
    }).join('');

    if (!user) {
      html += '<a href="#/login">Login</a><a href="#/register">Register</a>';
    }

    nav.innerHTML = html;

    if (user) {
      userBox.innerHTML =
        '<span class="badge-role">' + esc(user.role || '') + '</span>' +
        '<span>' + esc(user.name || user.email || '') + '</span>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-action="logout">Logout</button>';
    } else {
      userBox.innerHTML = '';
    }
  }

  function requireRole(role) {
    if (!user) {
      toast('Please log in first.', 'error');
      navigate('/login');
      return false;
    }
    if (role && user.role !== role) {
      toast('You do not have permission to access this page.', 'error');
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
    $('#view').innerHTML = html;
  }

  /* ============================================================
   * Auth views
   * ============================================================ */
  function viewAuth(mode) {
    var isLogin = mode === 'login';
    setView(
      '<div class="auth-wrap card">' +
        '<div class="auth-tabs">' +
          '<button type="button" class="tab' + (isLogin ? ' active' : '') + '" data-action="auth-tab" data-mode="login">Login</button>' +
          '<button type="button" class="tab' + (!isLogin ? ' active' : '') + '" data-action="auth-tab" data-mode="register">Register</button>' +
        '</div>' +
        (isLogin ? loginFormHtml() : registerFormHtml()) +
      '</div>'
    );
  }

  function loginFormHtml() {
    return (
      '<form id="authForm" data-action="submit-auth" data-mode="login" novalidate>' +
        '<div class="field mb"><label for="email">Email</label>' +
          '<input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required></div>' +
        '<div class="field mb"><label for="password">Password</label>' +
          '<input id="password" name="password" type="password" autocomplete="current-password" required></div>' +
        '<button type="submit" class="btn btn-primary btn-block mt">Login</button>' +
        '<p class="hint center mt">Customers and organisers register an account. ' +
          'Admins sign in with the seeded admin credentials created by the backend seed script.</p>' +
      '</form>'
    );
  }

  function registerFormHtml() {
    return (
      '<form id="authForm" data-action="submit-auth" data-mode="register" novalidate>' +
        '<div class="field mb"><label for="name">Full name</label>' +
          '<input id="name" name="name" type="text" placeholder="Your name" autocomplete="name" required></div>' +
        '<div class="field mb"><label for="email">Email</label>' +
          '<input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required></div>' +
        '<div class="field mb"><label for="password">Password</label>' +
          '<input id="password" name="password" type="password" autocomplete="new-password" required></div>' +
        '<div class="field mb"><label>Role</label>' +
          '<div class="role-select" id="roleSelect">' +
            '<label data-role="customer" class="sel"><input type="radio" name="role" value="customer" checked> Customer</label>' +
            '<label data-role="organiser"><input type="radio" name="role" value="organiser"> Organiser</label>' +
          '</div></div>' +
        '<button type="submit" class="btn btn-primary btn-block mt">Create account</button>' +
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
      if (!data.name) return toast('Please enter your name.', 'error');
    }
    if (!data.email || !data.password) return toast('Email and password are required.', 'error');

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      var res = await api('/api/auth/' + mode, { method: 'POST', body: data });
      token = res.token;
      user = res.user;
      saveSession();
      toast(mode === 'register' ? 'Account created. Welcome!' : 'Logged in. Welcome back!', 'success');
      navigate('/');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ============================================================
   * Browse events
   * ============================================================ */
  async function viewBrowse() {
    setView('<div class="center"><p class="muted">Loading events...</p></div>');
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
      var data = await api('/api/events' + (qs ? '?' + qs : ''));
      events = extractList(data);
    } catch (err) {
      setView('<div class="card center"><p>Could not load events.</p><p class="muted">' + esc(err.message) + '</p></div>');
      return;
    }

    var typeOptions = TYPES.map(function (t) {
      var v = t.toLowerCase();
      return '<option value="' + v + '"' + (type === v ? ' selected' : '') + '>' + t + '</option>';
    }).join('');

    var html =
      '<div class="section-head"><h2>Upcoming Events</h2></div>' +
      '<form id="filterForm" class="filters card" data-action="apply-filters">' +
        '<div class="field"><label>Type</label>' +
          '<select name="type"><option value="">All types</option>' + typeOptions + '</select></div>' +
        '<div class="field"><label>Search</label>' +
          '<input type="text" name="q" placeholder="Title, venue..." value="' + esc(q) + '"></div>' +
        '<div class="field"><label>Date</label>' +
          '<input type="date" name="date" value="' + esc(date) + '"></div>' +
        '<button type="submit" class="btn btn-primary">Filter</button>' +
        '<button type="button" class="btn btn-ghost" data-action="clear-filters">Reset</button>' +
      '</form>';

    if (!events.length) {
      html += '<div class="card center mt"><p class="muted">No events match your filters.</p></div>';
    } else {
      html += '<div class="card-grid mt">' + events.map(eventCardHtml).join('') + '</div>';
    }
    setView(html);
  }

  function eventCardHtml(ev) {
    var price = pricingOf(ev);
    var priceText = 'Price on selection';
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
    var badge = '<span class="badge badge-type">' + esc(ev.type || 'Event') + '</span>';
    if (soldOut) badge += ' <span class="badge badge-soldout">Sold out</span>';

    return (
      '<div class="event-card">' +
        '<div>' + badge + '</div>' +
        '<h3>' + esc(ev.title || 'Untitled') + '</h3>' +
        '<div class="meta">' +
          '<span>' + esc(formatDateTime(ev.date, ev.time)) + '</span>' +
          '<span>' + esc(venueName) + '</span>' +
        '</div>' +
        '<div class="price">' + esc(priceText) + '</div>' +
        '<div class="actions">' +
          '<a class="btn btn-primary btn-sm" href="#/event/' + eventIdOf(ev) + '">' +
            (soldOut ? 'View / Waitlist' : 'Select seats') + '</a>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================================================
   * Seat map + booking flow
   * ============================================================ */
  async function viewEvent(eventId) {
    setView('<div class="center"><p class="muted">Loading event...</p></div>');
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
      event = await api('/api/events/' + eventId);
      if (event && event.event) event = event.event;
      eventCache[eventId] = event;
    } catch (err) {
      setView('<div class="card center"><p>Could not load event.</p><p class="muted">' + esc(err.message) + '</p></div>');
      return;
    }

    var html = '<div id="eventView" data-event-id="' + esc(eventId) + '">' +
      '<a href="#/events" class="muted">&larr; Back to events</a>' +
      '<div class="section-head"><h2>' + esc(event.title || 'Event') + '</h2></div>' +
      '<div class="meta mb muted">' +
        '<span class="badge badge-type">' + esc(event.type || 'Event') + '</span> ' +
        esc(formatDateTime(event.date, event.time)) + ' &middot; ' +
        esc((event.venue && (event.venue.name || event.venue)) || event.venue_name || '') +
      '</div>' +
      '<div id="seatMapRegion"></div>' +
      '<div id="bookingRegion"></div>' +
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

  function seatListOf(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.seats)) return data.seats;
    if (Array.isArray(data.grid)) {
      // 2D grid: [[{row,col,category,status},...], ...]
      var out = [];
      data.grid.forEach(function (rowArr, r) {
        if (Array.isArray(rowArr)) {
          rowArr.forEach(function (seat) { if (seat) out.push(seat); });
        } else if (rowArr && typeof rowArr === 'object') {
          // grid may also be keyed by row index -> array of seats
          Object.keys(rowArr).forEach(function (k) {
            var s = rowArr[k];
            if (Array.isArray(s)) s.forEach(function (x) { if (x) out.push(x); });
            else if (s) out.push(s);
          });
        }
      });
      return out;
    }
    if (data.rows) {
      var out2 = [];
      Object.keys(data.rows).forEach(function (rowKey) {
        var seats = data.rows[rowKey];
        if (Array.isArray(seats)) seats.forEach(function (s) { if (s) out2.push(s); });
      });
      return out2;
    }
    return [];
  }

  async function refreshSeatMap(eventId, event, silent) {
    var region = $('#seatMapRegion');
    if (!region) return;
    var seatsData;
    try {
      seatsData = await api('/api/events/' + eventId + '/seats');
    } catch (err) {
      if (!silent) {
        region.innerHTML = '<div class="card center"><p class="muted">Could not load seat map.</p>' +
          '<p class="muted">' + esc(err.message) + '</p></div>';
      }
      return;
    }

    var seats = seatListOf(seatsData);
    var categories = [];
    var seatsByKey = {};
    var availableCount = 0;

    seats.forEach(function (s) {
      var key = seatKey(s.row, s.col);
      seatsByKey[key] = s;
      seatIdMap[key] = s.id;
      if (s.category && categories.indexOf(s.category) === -1) categories.push(s.category);
      if (s.status === 'available' || s.status === 'free' || s.status === 'open') availableCount++;
    });

    var soldOut = availableCount === 0 && seats.length > 0;

    // Drop selections that are no longer available (unless they are our hold / claim)
    var mine = {};
    if (hold && String(hold.eventId) === String(eventId)) {
      hold.seatIds.forEach(function (k) { mine[k] = true; });
    }
    if (claim && String(claim.eventId) === String(eventId)) {
      (claim.seatIds || []).forEach(function (k) { mine[k] = true; });
    }
    var stillValid = selectedSeats.filter(function (k) {
      if (mine[k]) return true;
      var s = seatsByKey[k];
      return s && (s.status === 'available' || s.status === 'free' || s.status === 'open');
    });
    var dropped = selectedSeats.filter(function (k) { return stillValid.indexOf(k) === -1; });
    if (dropped.length) {
      selectedSeats = stillValid;
      toast('One or more selected seats were taken. Please reselect.', 'error');
    }

    var cols = seats.reduce(function (m, s) { return Math.max(m, Number(s.col) || 0); }, 0);
    var colLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    var gridHtml = '<div class="seat-screen">SCREEN</div>';
    if (!seats.length) {
      gridHtml += '<div class="card center"><p class="muted">No seat map available for this event yet.</p></div>';
    } else {
      var rowsMap = {};
      seats.forEach(function (s) {
        var r = Number(s.row);
        if (!rowsMap[r]) rowsMap[r] = [];
        rowsMap[r].push(s);
      });
      var sortedRows = Object.keys(rowsMap).map(Number).sort(function (a, b) { return a - b; });

      gridHtml += '<div class="seat-grid" style="grid-template-columns: repeat(' + cols + ', 30px);">';
      sortedRows.forEach(function (r) {
        var rowSeats = rowsMap[r].sort(function (a, b) { return Number(a.col) - Number(b.col); });
        rowSeats.forEach(function (s) {
          var key = seatKey(s.row, s.col);
          var status = s.status || 'available';
          var cls = status === 'booked' ? 'booked' : (status === 'held' ? 'held' : 'available');
          if (mine[key]) cls = 'mine';
          if (selectedSeats.indexOf(key) !== -1 && cls !== 'mine') cls = 'selected';
          var label = (colLetters[Number(s.col) - 1] || s.col) + (Number(s.row) || s.row);
          var title = 'Row ' + s.row + ' Col ' + (colLetters[Number(s.col) - 1] || s.col) +
            (s.category ? ' - ' + s.category : '');
          gridHtml +=
            '<button type="button" class="seat ' + cls + '" data-seat="' + key + '" ' +
            'title="' + esc(title) + '"' +
            (cls === 'available' || cls === 'selected' ? ' data-action="toggle-seat"' : ' disabled') + '>' +
            '<span class="seat-tag">' + label + '</span></button>';
        });
      });
      gridHtml += '</div>';
    }

    gridHtml += '<div class="legend">' +
      '<span class="item"><span class="swatch available"></span> Available</span>' +
      '<span class="item"><span class="swatch held"></span> Held</span>' +
      '<span class="item"><span class="swatch booked"></span> Booked</span>' +
      '<span class="item"><span class="swatch mine"></span> Reserved for you</span>' +
      '<span class="item"><span class="swatch selected"></span> Selected</span>' +
      '</div>';

    if (categories.length) {
      var price = pricingOf(event);
      gridHtml += '<div class="legend">' + categories.map(function (c) {
        var p = price && price[c] !== undefined ? ' - ' + money(price[c]) : '';
        return '<span class="item muted">' + esc(c) + esc(p) + '</span>';
      }).join('') + '</div>';
    }

    gridHtml += '<div class="mb"><strong>' + availableCount + '</strong> seats available</div>';

    region.innerHTML = gridHtml;
    // Never clobber a booking-confirmation success box with the idle booking panel
    // (an in-flight poll may still be running even after stopPolling()).
    if (!document.querySelector('#bookingRegion .success-box')) {
      renderBookingPanel(event, eventId, seats, availableCount, soldOut);
    }
  }

  function renderBookingPanel(event, eventId, seats, availableCount, soldOut) {
    var region = $('#bookingRegion');
    if (!region) return;
    // After a successful booking/waitlist join the success box is final:
    // don't let seat-map polling or refreshes replace it.
    if (bookingComplete) return;

    var hasHold = hold && String(hold.eventId) === String(eventId);
    var hasClaim = claim && String(claim.eventId) === String(eventId);
    var selectedCount = selectedSeats.length;

    var html = '';

    if (hasHold || hasClaim) {
      var remaining = Math.max(0, (claim ? claim.expiresAt : hold.expiresAt) - Date.now());
      var seatCount = claim ? (claim.seatIds || []).length : hold.seatIds.length;
      html += '<div class="card">' +
        '<div class="section-head"><h2>Complete your booking</h2></div>' +
        '<div class="countdown" id="holdCountdown">' +
          (claim ? 'Seat offer held for ' : 'Seats held for ') + fmtRemaining(remaining) + '</div>' +
        '<p class="muted">' + seatCount + ' seat(s) reserved for you. ' +
          'If you take too long, the hold will expire and the seats will be released.</p>' +
        checkoutFormHtml(seatCount) +
        '<div class="mt"><button type="button" class="btn btn-ghost" data-action="release-hold">Release hold and reselect</button></div>' +
      '</div>';
      startCountdown('holdCountdown', remaining, claim ? 'offer' : 'hold');
    } else if (selectedCount > 0) {
      html += '<div class="card">' +
        '<div class="section-head"><h2>Selected seats</h2></div>' +
        '<p>' + selectedSeats.map(seatLabel).join(', ') + '</p>' +
        '<button type="button" class="btn btn-primary" data-action="hold-seats">Hold seats for booking</button>' +
        '<p class="hint mt">Selected ' + selectedCount + ' of max ' + MAX_SELECTABLE +
          '. Holding seats reserves them for a limited time.</p>' +
      '</div>';
    } else if (soldOut) {
      html += waitlistCardHtml(event, eventId);
    } else {
      html += '<div class="card center"><p class="muted">Select up to ' + MAX_SELECTABLE +
        ' available seats above to begin booking.</p></div>';
    }

    region.innerHTML = html;
  }

  function seatLabel(key) {
    var parts = key.split(':');
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return (letters[Number(parts[1]) - 1] || parts[1]) + (parts[0] || '');
  }

  function fmtRemaining(ms) {
    var totalSec = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return pad(m) + ':' + pad(s);
  }

  function checkoutFormHtml(count) {
    return (
      '<form id="checkoutForm" class="form-grid mt" data-action="submit-booking" novalidate>' +
        '<div class="field"><label for="customerName">Full name</label>' +
          '<input id="customerName" name="customerName" type="text" required autocomplete="name" value="' +
            esc(user ? (user.name || '') : '') + '"></div>' +
        '<div class="field"><label for="customerEmail">Email (ticket + QR sent here)</label>' +
          '<input id="customerEmail" name="customerEmail" type="email" required autocomplete="email" value="' +
            esc(user ? (user.email || '') : '') + '"></div>' +
        '<div class="full"><button type="submit" class="btn btn-success btn-block">Book ' +
          count + ' seat(s)</button></div>' +
      '</form>'
    );
  }

  function waitlistCardHtml(event, eventId) {
    var categories = [];
    var price = pricingOf(event);
    if (price) Object.keys(price).forEach(function (k) {
      if (k !== 'min' && k !== 'from') categories.push(k);
    });
    var cats = Object.keys(event.categories || {}).length ? Object.keys(event.categories) : categories;
    if (!cats.length) cats = ['Standard'];

    var opts = cats.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');

    return (
      '<div class="card">' +
        '<div class="section-head"><h2>Event sold out</h2></div>' +
        '<p class="muted">This event has no available seats right now. ' +
          'Join the waitlist for a seat category and we will email you a time-limited offer ' +
          'if a seat becomes available.</p>' +
        (user && user.role === 'customer'
          ? '<form id="waitlistForm" class="form-grid" data-action="join-waitlist" novalidate>' +
              '<div class="field"><label for="wlCategory">Seat category</label>' +
                '<select id="wlCategory" name="category">' + opts + '</select></div>' +
              '<div class="full"><button type="submit" class="btn btn-primary">Join waitlist</button></div>' +
            '</form>'
          : '<p><a href="#/login">Log in</a> as a customer to join the waitlist.</p>') +
      '</div>'
    );
  }

  /* ---------- booking actions ---------- */

  async function holdSelectedSeats(eventId) {
    if (!requireRole('customer')) return;
    if (!selectedSeats.length) return toast('Select at least one seat first.', 'error');

    var btn = document.querySelector('[data-action="hold-seats"]');
    if (btn) btn.disabled = true;
    try {
      var ids = selectedSeats.map(function (k) { return seatIdMap[k]; }).filter(Boolean);
      if (!ids.length) {
        toast('Could not resolve the selected seats. Please reselect them.', 'error');
        return;
      }
      var res = await api('/api/events/' + eventId + '/hold', {
        method: 'POST',
        body: { seatIds: ids }
      });
      var tokens = holdTokens(res);
      var expiresAt = holdExpiry(res);
      if (!tokens.length) throw new Error('Hold succeeded but no hold token was returned.');

      hold = { eventId: eventId, seatIds: selectedSeats.slice(), tokens: tokens, expiresAt: expiresAt };
      toast('Seats held! Complete checkout before the timer runs out.', 'success');

      // Re-render so the held seats show as reserved-for-you and checkout appears.
      await refreshSeatMap(eventId, eventCache[eventId]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function holdTokens(res) {
    if (res && Array.isArray(res.holdTokens) && res.holdTokens.length) return res.holdTokens;
    if (res && res.holdToken) return Array.isArray(res.holdToken) ? res.holdToken : [res.holdToken];
    if (res && res.hold && res.hold.tokens) return Array.isArray(res.hold.tokens) ? res.hold.tokens : [res.hold.tokens];
    if (res && res.hold && res.hold.holdToken) return [res.hold.holdToken];
    if (res && Array.isArray(res.tokens) && res.tokens.length) return res.tokens;
    return [];
  }

  function holdExpiry(res) {
    var base = res && res.hold ? res.hold : res;
    if (base.expiresAt || base.expires_at) {
      var d = new Date(base.expiresAt || base.expires_at).getTime();
      if (!isNaN(d)) return d;
    }
    var ttl = base.ttl || base.ttlMs || base.expiresIn || base.holdTtlMs || base.holdTtl || 600000;
    return Date.now() + Number(ttl);
  }

  async function submitBooking(eventId, form) {
    if (!requireRole('customer')) return;
    var name = form.customerName.value.trim();
    var email = form.customerEmail.value.trim();
    if (!name || !email) return toast('Name and email are required.', 'error');

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    bookingComplete = true;   // prevent any in-flight polls from clobbering the booking region
    try {
      var payload = { customerName: name, customerEmail: email };
      if (hold && String(hold.eventId) === String(eventId)) {
        payload.holdToken = hold.tokens.length === 1 ? hold.tokens[0] : hold.tokens;
      }
      if (claim && String(claim.eventId) === String(eventId)) {
        payload.holdToken = claim.holdToken || claim.token;
      }

      var res = await api('/api/events/' + eventId + '/book', { method: 'POST', body: payload });
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
          '<div class="check">&#10003;</div>' +
          '<h2>Booking confirmed</h2>' +
          '<p class="muted">Your tickets have been booked. A copy with the QR code has been emailed to ' +
            esc(email) + '.</p>' +
          (ref ? '<p>Booking reference: <strong>' + esc(ref) + '</strong></p>' : '') +
          (qr
            ? '<div class="qr-box" style="margin:16px auto 0;"><img src="' + esc(qr) + '" alt="Ticket QR code">' +
              '<span class="qr-ref">' + esc(ref || '') + '</span></div>' +
              '<p class="hint">Present this QR code at the venue for entry.</p>'
            : '') +
          '<div class="mt"><a class="btn btn-primary" href="#/bookings">View my bookings</a></div>' +
        '</div>';
      toast('Booking successful! Ticket emailed.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function releaseHold() {
    var evId = $('#eventView') ? $('#eventView').dataset.eventId : null;
    var releaseToken = hold ? (hold.tokens.length ? hold.tokens[0] : null)
      : (claim ? (claim.holdToken || claim.token) : null);
    hold = null;
    claim = null;
    selectedSeats = [];
    stopCountdown();
    if (evId) refreshSeatMap(evId, eventCache[evId]);
    if (releaseToken && evId) {
      api('/api/events/' + evId + '/hold/' + encodeURIComponent(releaseToken), { method: 'DELETE' })
        .catch(function () { /* seat will be released automatically when the hold expires */ });
    }
    toast('Hold released. Seats will be available again for others shortly.', 'info');
  }

  async function joinWaitlist(eventId, form) {
    if (!requireRole('customer')) return;
    var category = form.category.value;
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      var res = await api('/api/events/' + eventId + '/waitlist', {
        method: 'POST',
        body: { category: category }
      });
      stopPolling();
      bookingComplete = true;
      toast('You are on the waitlist for ' + category + '. We will email you if a seat opens up.', 'success');
      $('#bookingRegion').innerHTML =
        '<div class="card success-box">' +
          '<div class="check">&#10003;</div>' +
          '<h2>Waitlist joined</h2>' +
          '<p class="muted">Category: <strong>' + esc(category) + '</strong>. ' +
            'If a seat becomes available you will receive a time-limited offer by email.</p>' +
          '<p class="hint mt">Check your inbox for a link to claim the seat.</p>' +
        '</div>';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ============================================================
   * My bookings
   * ============================================================ */
  async function viewBookings() {
    if (!requireRole('customer')) return;
    setView('<div class="center"><p class="muted">Loading bookings...</p></div>');

    var bookings = [];
    try {
      bookings = extractList(await api('/api/bookings'));
    } catch (err) {
      setView('<div class="card center"><p>Could not load bookings.</p><p class="muted">' + esc(err.message) + '</p></div>');
      return;
    }

    if (!bookings.length) {
      setView('<div class="section-head"><h2>My bookings</h2></div>' +
        '<div class="card center"><p class="muted">You have no bookings yet. ' +
        '<a href="#/events">Browse events</a> to get started.</p></div>');
      return;
    }

    var html = '<div class="section-head"><h2>My bookings</h2></div><div class="list-stack">' +
      bookings.map(function (b) {
        var ref = bookingRef(b);
        var evId = eventIdOfBooking(b);
        var eventTitle = (b.event && (b.event.title || b.event.name)) || b.event_title || b.eventTitle || 'Event';
        var status = b.status || b.state || 'confirmed';
        var badgeCls = status === 'cancelled' || status === 'canceled' ? 'badge-cancelled' : 'badge-booked';
        var seats = b.seats || b.seatIds || [];
        var seatText = '';
        if (Array.isArray(seats)) seatText = seats.map(function (s) {
          return typeof s === 'string' ? s : seatLabel(String(s.row) + ':' + String(s.col));
        }).join(', ');
        else if (seats) seatText = String(seats);
        if (!seatText && b.seat_row && b.seat_col) {
          seatText = seatLabel(String(b.seat_row) + ':' + String(b.seat_col));
        }

        return (
          '<div class="card booking-item" data-ref="' + esc(ref) + '" data-event-id="' + esc(evId || '') + '">' +
            '<div class="b-head">' +
              '<div><strong>' + esc(ref || 'Booking') + '</strong>' +
                ' <span class="badge ' + badgeCls + '">' + esc(status) + '</span></div>' +
              '<span class="muted">' + esc(formatDateTime(b.date || b.created_at || b.createdAt, '')) + '</span>' +
            '</div>' +
            '<div class="b-meta">' + esc(eventTitle) + (seatText ? ' &middot; Seats: ' + esc(seatText) : '') + '</div>' +
            '<div class="b-actions mt">' +
              '<button type="button" class="btn btn-sm btn-ghost" data-action="toggle-booking-detail" data-ref="' + esc(ref) + '">Show ticket / QR</button>' +
              (status !== 'cancelled' && status !== 'canceled' && evId
                ? '<button type="button" class="btn btn-sm btn-danger" data-action="cancel-booking" data-ref="' + esc(ref) + '" data-event-id="' + esc(evId) + '">Cancel booking</button>'
                : '') +
            '</div>' +
            '<div class="b-body hidden" data-detail="' + esc(ref) + '"><p class="muted">Loading ticket...</p></div>' +
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
    body.innerHTML = '<p class="muted">Loading ticket...</p>';
    try {
      var res = await api('/api/bookings/' + encodeURIComponent(ref));
      var booking = extractBooking(res);
      var qr = qrOf(booking) || qrOf(res);
      var data = {
        qr: qr,
        ref: bookingRef(booking) || ref,
        seats: booking.seats || booking.seatIds || [],
        status: booking.status || booking.state || ''
      };
      var seatText = '';
      if (Array.isArray(data.seats)) {
        seatText = data.seats.map(function (s) {
          return typeof s === 'string' ? s : seatLabel(String(s.row) + ':' + String(s.col));
        }).join(', ');
      }
      if (!seatText && booking.seat_row && booking.seat_col) {
        seatText = seatLabel(String(booking.seat_row) + ':' + String(booking.seat_col));
      }
      body.innerHTML =
        (data.qr
          ? '<div class="qr-box"><img src="' + esc(data.qr) + '" alt="Ticket QR code">' +
            '<span class="qr-ref">' + esc(data.ref) + '</span></div>'
          : '<p class="muted">No QR image available for this booking.</p>') +
        '<p class="muted mb">Reference: ' + esc(data.ref) +
        (seatText ? ' &middot; Seats: ' + esc(seatText) : '') + '</p>' +
        '<p class="hint">Present this QR code at the venue for entry.</p>';
    } catch (err) {
      body.innerHTML = '<p class="muted">Could not load ticket: ' + esc(err.message) + '</p>';
    }
  }

  async function cancelBooking(ref, eventId) {
    var ok = await confirmDialog(
      'Cancel booking?',
      'Are you sure you want to cancel booking ' + ref + '? If seats are released, the next waitlisted customer may be offered them.'
    );
    if (!ok) return;
    try {
      var res = await api('/api/events/' + encodeURIComponent(eventId) + '/cancel', {
        method: 'POST',
        body: { booking_ref: ref }
      });
      toast('Booking ' + ref + ' cancelled.', 'success');
      viewBookings();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ============================================================
   * Organiser dashboard
   * ============================================================ */
  async function viewOrganiser() {
    if (!requireRole('organiser')) return;
    setView('<div class="center"><p class="muted">Loading dashboard...</p></div>');

    var events = [];
    try {
      events = extractList(await api('/api/organiser/events'));
    } catch (err) {
      setView('<div class="card center"><p>Could not load your events.</p><p class="muted">' + esc(err.message) + '</p></div>');
      return;
    }

    var html = '<div class="section-head"><h2>Organiser dashboard</h2></div>';

    html += '<div class="card mb"><div class="section-head"><h3>Create event</h3></div>' +
      '<form id="createEventForm" class="form-grid" data-action="create-event" novalidate>' +
        '<div class="field"><label>Venue</label><select name="venueId" id="venueSelect" required></select></div>' +
        '<div class="field"><label>Title</label><input name="title" type="text" required></div>' +
        '<div class="field"><label>Type</label><select name="type" required>' +
          '<option value="movie">Movie</option><option value="concert">Concert</option></select></div>' +
        '<div class="field"><label>Date</label><input name="date" type="date" required></div>' +
        '<div class="field"><label>Time</label><input name="time" type="time" required></div>' +
        '<div class="field full"><label>Description</label><textarea name="description" rows="3"></textarea></div>' +
        '<div class="full" id="priceFields"><p class="muted">Select a venue to configure per-category pricing.</p></div>' +
        '<div class="full"><button type="submit" class="btn btn-primary">Create event</button></div>' +
      '</form></div>';

    html += '<div class="section-head"><h3>My events</h3></div>';
    if (!events.length) {
      html += '<div class="card center"><p class="muted">You have not created any events yet.</p></div>';
    } else {
      html += '<div class="list-stack">' + events.map(function (ev) {
        return (
          '<div class="card" data-event-id="' + esc(eventIdOf(ev)) + '">' +
            '<div class="b-head">' +
              '<div><strong>' + esc(ev.title || 'Untitled') + '</strong> ' +
                '<span class="badge badge-type">' + esc(ev.type || '') + '</span></div>' +
              '<span class="muted">' + esc(formatDateTime(ev.date, ev.time)) + '</span>' +
            '</div>' +
            '<div class="b-meta">' +
              esc((ev.venue && (ev.venue.name || ev.venue)) || ev.venue_name || '') +
              (ev.pricing && ev.pricing.min ? ' &middot; from ' + money(ev.pricing.min) : '') +
            '</div>' +
            '<div class="b-actions mt">' +
              '<a class="btn btn-sm btn-primary" href="#/event/' + eventIdOf(ev) + '">View seat map</a> ' +
              '<button type="button" class="btn btn-sm btn-ghost" data-action="view-revenue" data-event-id="' + esc(eventIdOf(ev)) + '">Revenue</button>' +
            '</div>' +
          '</div>'
        );
      }).join('') + '</div>';
    }

    setView(html);

    // Populate venue dropdown (public endpoint if available, fallback to admin endpoint)
    loadVenueOptions();
  }

  async function loadVenueOptions() {
    var select = $('#venueSelect');
    if (!select) return;
    var venues = [];
    try {
      venues = extractList(await api('/api/venues'));
    } catch (e1) {
      try {
        venues = extractList(await api('/api/admin/venues'));
      } catch (e2) { /* no venues accessible */ }
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
    if (venues.length) renderPriceFields(select.options[select.selectedIndex]);
  }

  function renderPriceFields(optionEl) {
    var box = $('#priceFields');
    if (!box) return;
    var cats = [];
    try { cats = JSON.parse(optionEl.dataset.categories || '[]'); } catch (e) { cats = []; }
    if (!cats.length) cats = ['Standard'];
    cats = cats.map(function (c) { return (c && c.category_name) || (c && c.name) || c; });
    box.innerHTML =
      '<div class="full"><label>Per-category pricing</label></div>' +
      cats.map(function (c) {
        return '<div class="field"><label>' + esc(c) + ' price</label>' +
          '<input type="number" name="price_' + esc(c) + '" min="0" step="0.01" placeholder="0.00"></div>';
      }).join('');
  }

  async function createEvent(form) {
    var venueId = form.venueId.value;
    var title = form.title.value.trim();
    var type = (form.type.value || '').toLowerCase();
    var date = form.date.value;
    var time = form.time.value;
    if (!venueId || !title || !date || !time) return toast('Please fill in venue, title, date and time.', 'error');

    var pricing = {};
    $$('input[name^="price_"]', form).forEach(function (input) {
      if (input.value !== '') pricing[input.name.replace('price_', '')] = Number(input.value);
    });
    if (!Object.keys(pricing).length) return toast('Enter at least one category price.', 'error');

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
      await api('/api/organiser/events', { method: 'POST', body: body });
      toast('Event created successfully.', 'success');
      viewOrganiser();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function viewRevenue(eventId) {
    if (!requireRole('organiser')) return;
    setView('<div class="center"><p class="muted">Loading revenue...</p></div>');
    try {
      var res = await api('/api/organiser/events/' + eventId + '/revenue');
      var cats = res.categories || res.revenueByCategory || res.byCategory || res.breakdown || [];
      var totalRes = res.total || res.totalRevenue || res.revenue;
      var total = (totalRes && typeof totalRes === 'object')
        ? (totalRes.revenue || totalRes.amount || 0)
        : (totalRes || 0);

      var catRows = '';
      if (Array.isArray(cats)) {
        catRows = cats.map(function (c) {
          var name = c.category || c.name || 'All';
          var count = c.count || c.seats || c.seatsBooked || 0;
          var rev = c.revenue || c.amount || 0;
          return '<div class="revenue-row"><span>' + esc(name) +
            ' <span class="muted">(' + count + ' seat' + (count === 1 ? '' : 's') + ')</span></span>' +
            '<strong>' + money(rev) + '</strong></div>';
        }).join('');
      } else if (cats && typeof cats === 'object') {
        catRows = Object.keys(cats).map(function (name) {
          var c = cats[name] || {};
          var count = typeof c === 'number' ? c : (c.count || c.seats || 0);
          var rev = typeof c === 'number' ? 0 : (c.revenue || c.amount || 0);
          return '<div class="revenue-row"><span>' + esc(name) + '</span><strong>' + money(rev) + '</strong></div>';
        }).join('');
      }
      if (!catRows) catRows = '<p class="muted">No revenue data yet.</p>';

      setView(
        '<a href="#/organiser" class="muted">&larr; Back to dashboard</a>' +
        '<div class="section-head"><h2>Revenue</h2></div>' +
        '<div class="card">' + catRows +
          '<div class="revenue-total"><span>Total revenue</span><span>' + money(total) + '</span></div>' +
        '</div>'
      );
    } catch (err) {
      setView('<div class="card center"><p>Could not load revenue.</p><p class="muted">' + esc(err.message) + '</p></div>');
    }
  }

  /* ============================================================
   * Admin dashboard
   * ============================================================ */
  async function viewAdmin() {
    if (!requireRole('admin')) return;
    setView('<div class="center"><p class="muted">Loading admin panel...</p></div>');

    var venues = [];
    try {
      venues = extractList(await api('/api/admin/venues'));
    } catch (err) {
      setView('<div class="card center"><p>Could not load venues.</p><p class="muted">' + esc(err.message) + '</p></div>');
      return;
    }

    var html = '<div class="section-head"><h2>Admin panel</h2></div>';

    html += '<div class="card mb"><div class="section-head"><h3>Create venue</h3></div>' +
      '<form id="createVenueForm" class="form-grid" data-action="create-venue" novalidate>' +
        '<div class="field"><label>Venue name</label><input name="name" type="text" required></div>' +
        '<div class="field"><label>Address</label><input name="address" type="text" required></div>' +
        '<div class="field"><label>Rows</label><input name="rows" type="number" min="1" required></div>' +
        '<div class="field"><label>Columns</label><input name="cols" type="number" min="1" required></div>' +
        '<div class="field full"><label>Seat categories (comma-separated)</label>' +
          '<input name="categories" type="text" value="Premium, Standard" required>' +
          '<span class="hint">e.g. Premium, Standard. Categories map to seat groups on the venue floor.</span></div>' +
        '<div class="full"><button type="submit" class="btn btn-primary">Create venue</button></div>' +
      '</form></div>';

    html += '<div class="section-head"><h3>Venues</h3></div>';
    if (!venues.length) {
      html += '<div class="card center"><p class="muted">No venues created yet.</p></div>';
    } else {
      html += '<div class="list-stack">' + venues.map(function (v) {
        var cats = v.categories || v.category || [];
        var catText = Array.isArray(cats)
          ? cats.map(function (c) { return (c && c.category_name) || (c && c.name) || c; }).join(', ')
          : String(cats || '');
        return (
          '<div class="card" data-venue-id="' + esc(eventIdOf(v)) + '">' +
            '<div class="b-head">' +
              '<div><strong>' + esc(v.name || 'Venue') + '</strong></div>' +
              '<button type="button" class="btn btn-sm btn-danger" data-action="delete-venue" data-venue-id="' + esc(eventIdOf(v)) + '">Delete</button>' +
            '</div>' +
            '<div class="b-meta">' +
              esc(v.address || '') + ' &middot; ' + (v.rows || 0) + ' x ' + (v.cols || 0) + ' layout' +
              (catText ? ' &middot; Categories: ' + esc(catText) : '') +
            '</div>' +
          '</div>'
        );
      }).join('') + '</div>';
    }

    setView(html);
  }

  async function createVenue(form) {
    var cats = form.categories.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var rows = Number(form.rows.value);
    var cols = Number(form.cols.value);
    var body = {
      name: form.name.value.trim(),
      address: form.address.value.trim(),
      rows: rows,
      cols: cols,
      categories: cats
    };
    if (!body.name || !body.address || !rows || !cols) return toast('Please fill in all venue details.', 'error');
    if (!cats.length) return toast('Enter at least one seat category.', 'error');

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/api/admin/venues', { method: 'POST', body: body });
      toast('Venue created.', 'success');
      viewAdmin();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteVenue(venueId) {
    var ok = await confirmDialog('Delete venue?', 'This will delete the venue and its layout. Existing events may be affected.');
    if (!ok) return;
    try {
      await api('/api/admin/venues/' + encodeURIComponent(venueId), { method: 'DELETE' });
      toast('Venue deleted.', 'success');
      viewAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ============================================================
   * Waitlist claim flow
   * ============================================================ */
  async function viewClaim() {
    var tokenParam = getQuery().token;
    setView('<div class="center"><p class="muted">Claiming your seat offer...</p></div>');
    if (!tokenParam) {
      setView('<div class="card center"><p>Missing offer token. Please open the link from your email.</p></div>');
      return;
    }
    try {
      var res = await api('/api/waitlist/offer/' + encodeURIComponent(tokenParam));
      var offer = res.offer || res;
      var eventId = offer.eventId || offer.event_id || (offer.event && (offer.event.id || offer.event._id));
      var seats = offer.seats || offer.seatIds || (offer.seat ? [offer.seat] : []);
      var expiresAt = new Date(offer.expiresAt || offer.expires_at || offer.expiry || offer.ttl).getTime();
      if (isNaN(expiresAt)) expiresAt = Date.now() + 300000;

      if (!eventId) throw new Error('Offer response did not include an event.');

      claim = {
        token: tokenParam,
        holdToken: offer.holdToken || tokenParam,
        eventId: String(eventId),
        seatIds: seats.map(function (s) {
          if (typeof s === 'string') return s;
          return seatKey(s.row, s.col);
        }),
        expiresAt: expiresAt
      };

      toast('Seat offer claimed! Complete the booking before the offer expires.', 'success');
      navigate('/event/' + eventId + '?claim=' + encodeURIComponent(tokenParam));
    } catch (err) {
      setView('<div class="card center"><p>This offer is no longer valid.</p><p class="muted">' + esc(err.message) +
        '</p><div class="mt"><a class="btn btn-primary" href="#/events">Browse events</a></div></div>');
    }
  }

  /* ============================================================
   * Countdown (hold / offer)
   * ============================================================ */
  function startCountdown(elId, remainingMs, kind) {
    stopCountdown();
    var deadline = Date.now() + remainingMs;
    var el = document.getElementById(elId);
    if (!el) return;
    function tick() {
      var left = deadline - Date.now();
      if (left <= 0) {
        el.textContent = kind === 'offer' ? 'Offer expired' : 'Hold expired';
        stopCountdown();
        if (kind === 'offer') {
          claim = null;
          selectedSeats = [];
          toast('The seat offer has expired. It has been offered to the next customer on the waitlist.', 'info');
        } else if (hold) {
          hold = null;
          selectedSeats = [];
          var evId = $('#eventView') ? $('#eventView').dataset.eventId : null;
          if (evId) {
            refreshSeatMap(evId, eventCache[evId]);
            toast('Seat hold expired. The seats have been released.', 'info');
          }
        }
        return;
      }
      el.textContent = (kind === 'offer' ? 'Seat offer expires in ' : 'Seats held for ') + fmtRemaining(left);
    }
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  /* ============================================================
   * Global event delegation
   * ============================================================ */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.dataset.action;

    switch (action) {
      case 'logout':
        clearSession();
        toast('Logged out.', 'info');
        navigate('/login');
        break;

      case 'auth-tab':
        navigate('/' + el.dataset.mode);
        break;

      case 'toggle-seat': {
        var evId = $('#eventView') ? $('#eventView').dataset.eventId : null;
        if (!requireRole('customer')) break;
        if (hold) { toast('Release your current hold before changing seats.', 'error'); break; }
        var key = el.dataset.seat;
        var idx = selectedSeats.indexOf(key);
        if (idx >= 0) selectedSeats.splice(idx, 1);
        else {
          if (selectedSeats.length >= MAX_SELECTABLE) {
            toast('You can select a maximum of ' + MAX_SELECTABLE + ' seats.', 'error');
            break;
          }
          selectedSeats.push(key);
        }
        refreshSeatMap(evId, eventCache[evId]);
        break;
      }

      case 'hold-seats': {
        var evId2 = $('#eventView') ? $('#eventView').dataset.eventId : null;
        if (evId2) holdSelectedSeats(evId2);
        break;
      }

      case 'release-hold':
        releaseHold();
        break;

      case 'view-revenue':
        navigate('/revenue/' + el.dataset.eventId);
        break;

      case 'toggle-booking-detail':
        toggleBookingDetail(el.dataset.ref, el);
        break;

      case 'cancel-booking':
        cancelBooking(el.dataset.ref, el.dataset.eventId);
        break;

      case 'delete-venue':
        deleteVenue(el.dataset.venueId);
        break;

      case 'clear-filters':
        navigate('/events');
        break;
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'venueSelect') {
      var opt = e.target.options[e.target.selectedIndex];
      renderPriceFields(opt);
    }
    if (e.target && e.target.closest('#roleSelect')) {
      var role = e.target.value;
      $$('#roleSelect label').forEach(function (l) {
        l.classList.toggle('sel', l.dataset.role === role);
      });
    }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    var action = form.dataset.action;

    if (action === 'submit-auth') {
      e.preventDefault();
      submitAuth(form, form.dataset.mode);
    } else if (action === 'apply-filters') {
      e.preventDefault();
      var p = new URLSearchParams();
      if (form.type.value) p.set('type', form.type.value.toLowerCase());
      if (form.q.value.trim()) p.set('q', form.q.value.trim());
      if (form.date.value) p.set('date', form.date.value);
      var qs = p.toString();
      navigate('/events' + (qs ? '?' + qs : ''));
    } else if (action === 'submit-booking') {
      e.preventDefault();
      var evId3 = $('#eventView') ? $('#eventView').dataset.eventId : null;
      if (evId3) submitBooking(evId3, form);
    } else if (action === 'join-waitlist') {
      e.preventDefault();
      var evId4 = $('#eventView') ? $('#eventView').dataset.eventId : null;
      if (evId4) joinWaitlist(evId4, form);
    } else if (action === 'create-event') {
      e.preventDefault();
      createEvent(form);
    } else if (action === 'create-venue') {
      e.preventDefault();
      createVenue(form);
    }
  });

  // 'clear-filters' is handled in the click delegation switch above.

  /* ============================================================
   * Boot
   * ============================================================ */
  window.addEventListener('hashchange', render);
  render();
})();