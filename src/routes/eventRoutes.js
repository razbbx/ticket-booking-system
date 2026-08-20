'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { effectiveStatus } = require('../services/holds');

// Categories are ordered by id; row_count declares how many top rows each one
// owns, and 0 (or the final entry) absorbs the remaining rows.
function categoryForRow(row, cats) {
  let start = 1;
  for (const cat of cats) {
    const count = cat.row_count || 0;
    if (count > 0) {
      if (row >= start && row < start + count) return cat.category_name;
      start += count;
    } else {
      return cat.category_name;
    }
  }
  const last = cats[cats.length - 1];
  return last ? last.category_name : null;
}

// Creates the event, its per-category pricing and one show_seats row for every
// cell of the venue grid. Runs in a single transaction.
function createEventListing({ organiser_id, venue_id, title, type, date, time, description, image_url, pricing }) {
  const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(venue_id);
  if (!venue) {
    const e = new Error('venue not found');
    e.status = 404;
    throw e;
  }
  if (!['movie', 'concert'].includes(type)) {
    const e = new Error('type must be movie or concert');
    e.status = 400;
    throw e;
  }
  if (!pricing || Object.keys(pricing).length === 0) {
    const e = new Error('pricing is required');
    e.status = 400;
    throw e;
  }
  const validCategories = new Set(
    db.prepare('SELECT category_name FROM venue_categories WHERE venue_id = ?').all(venue_id).map((x) => x.category_name)
  );
  for (const [cat, price] of Object.entries(pricing)) {
    if (!validCategories.has(cat)) {
      const e = new Error(`pricing category "${cat}" is not defined for this venue`);
      e.status = 400;
      throw e;
    }
    if (!Number.isFinite(Number(price)) || Number(price) < 0) {
      const e = new Error(`invalid price for category "${cat}"`);
      e.status = 400;
      throw e;
    }
  }

  return db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO events (organiser_id, venue_id, title, type, date, time, description, image_url, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(organiser_id, venue_id, title, type, date, time, description || null, image_url || null, Date.now());
    const eventId = info.lastInsertRowid;

    const pricingStmt = db.prepare('INSERT INTO event_pricing (event_id, category_name, price) VALUES (?,?,?)');
    for (const [cat, price] of Object.entries(pricing)) {
      pricingStmt.run(eventId, cat, Number(price));
    }

    const vcats = db.prepare('SELECT * FROM venue_categories WHERE venue_id = ? ORDER BY id').all(venue_id);
    const seatStmt = db.prepare(
      'INSERT INTO show_seats (event_id, venue_row, venue_col, category_name, status) VALUES (?,?,?,?,?)'
    );
    for (let r = 1; r <= venue.rows; r++) {
      const cat = categoryForRow(r, vcats);
      for (let c = 1; c <= venue.cols; c++) {
        seatStmt.run(eventId, r, c, cat, 'available');
      }
    }
    return eventId;
  })();
}

// Builds the seat map for an event, applying lazy hold expiry on read.
function seatMap(eventId) {
  const rows = db
    .prepare('SELECT id, venue_row, venue_col, category_name, status, hold_expires_at FROM show_seats WHERE event_id = ? ORDER BY venue_row, venue_col')
    .all(eventId);
  return rows.map((s) => ({
    id: s.id,
    row: s.venue_row,
    col: s.venue_col,
    category: s.category_name,
    status: effectiveStatus(s),
  }));
}

function attachPricing(eventRow) {
  const pricingRows = db.prepare('SELECT category_name, price FROM event_pricing WHERE event_id = ?').all(eventRow.id);
  return { ...eventRow, pricing: Object.fromEntries(pricingRows.map((p) => [p.category_name, p.price])) };
}

// --- Public: browse events with optional filters, view event detail + seat map ---
router.get('/api/venues', (req, res) => {
  const venues = db.prepare('SELECT * FROM venues ORDER BY id').all();
  const catStmt = db.prepare(
    'SELECT id, category_name, description, row_count FROM venue_categories WHERE venue_id = ? ORDER BY id'
  );
  for (const v of venues) v.categories = catStmt.all(v.id);
  res.json(venues);
});

router.get('/api/events', (req, res) => {
  const { type, q, date } = req.query;
  const clauses = [];
  const params = [];
  if (type) {
    clauses.push('e.type = ?');
    params.push(type);
  }
  if (date) {
    clauses.push('e.date = ?');
    params.push(date);
  }
  if (q) {
    clauses.push('(e.title LIKE ? OR e.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT e.*, v.name AS venue_name FROM events e JOIN venues v ON v.id = e.venue_id ${where} ORDER BY e.created_at DESC`)
    .all(...params);
  res.json(rows.map(attachPricing));
});

router.get('/api/events/:id', (req, res) => {
  const evt = db
    .prepare(
      'SELECT e.*, v.name AS venue_name, v.rows AS venue_rows, v.cols AS venue_cols FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ?'
    )
    .get(req.params.id);
  if (!evt) return res.status(404).json({ error: 'event not found' });
  const seats = seatMap(evt.id);
  res.json({ ...attachPricing(evt), seats: { rows: evt.venue_rows, cols: evt.venue_cols, seats } });
});

// --- Organiser: create events, list own events, revenue summary ---
router.post('/api/organiser/events', requireAuth, requireRole('organiser'), (req, res) => {
  const { venue_id, title, type, date, time, description, image_url, pricing } = req.body || {};
  if (!title || !type || !date || !time) {
    return res.status(400).json({ error: 'title, type, date and time are required' });
  }
  try {
    const id = createEventListing({
      organiser_id: req.user.id,
      venue_id,
      title,
      type,
      date,
      time,
      description,
      image_url,
      pricing,
    });
    res.status(201).json(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/api/organiser/events', requireAuth, requireRole('organiser'), (req, res) => {
  const rows = db
    .prepare(
      'SELECT e.*, v.name AS venue_name FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.organiser_id = ? ORDER BY e.created_at DESC'
    )
    .all(req.user.id);
  res.json(rows);
});

router.get('/api/organiser/events/:id/revenue', requireAuth, requireRole('organiser'), (req, res) => {
  const evt = db.prepare('SELECT * FROM events WHERE id = ? AND organiser_id = ?').get(req.params.id, req.user.id);
  if (!evt) return res.status(404).json({ error: 'event not found' });

  const categories = db
    .prepare(
      `SELECT s.category_name AS category,
              COUNT(b.id) AS count,
              COALESCE(SUM(b.price), 0) AS revenue
       FROM show_seats s
       JOIN bookings b ON b.seat_id = s.id
       WHERE s.event_id = ? AND b.status = 'active'
       GROUP BY s.category_name`
    )
    .all(evt.id);
  const total = categories.reduce(
    (acc, r) => ({ count: acc.count + r.count, revenue: acc.revenue + r.revenue }),
    { count: 0, revenue: 0 }
  );
  res.json({ event_id: evt.id, title: evt.title, categories, total });
});

module.exports = { router, createEventListing, seatMap, categoryForRow };