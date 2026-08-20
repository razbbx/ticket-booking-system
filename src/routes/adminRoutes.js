'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

// Every route in this router requires an admin token.
router.use(requireAuth, requireRole('admin'));

// Validates a venue body and returns a cleaned copy or throws an Error with a
// .status field for the route to map to an HTTP code.
function validateVenue(body) {
  const { name, address, rows, cols, categories } = body || {};
  const r = Number(rows);
  const c = Number(cols);
  if (!name) {
    const e = new Error('name is required');
    e.status = 400;
    throw e;
  }
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(c) || c < 1) {
    const e = new Error('rows and cols must be positive integers');
    e.status = 400;
    throw e;
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    const e = new Error('categories must be a non-empty array');
    e.status = 400;
    throw e;
  }
  // Accept both plain names (["Premium", "Standard"]) and full objects
  // ({ name, rows }); the UI submits names, the API contract prefers objects.
  const normalized = categories.map((cat) => (typeof cat === 'string' ? { name: cat } : cat));
  const seen = new Set();
  let rowBudget = r;
  for (const cat of normalized) {
    if (!cat || !cat.name) {
      const e = new Error('each category needs a name');
      e.status = 400;
      throw e;
    }
    if (seen.has(cat.name)) {
      const e = new Error(`duplicate category "${cat.name}"`);
      e.status = 400;
      throw e;
    }
    seen.add(cat.name);
    const rc = cat.rows ? Number(cat.rows) : 0;
    if (!Number.isInteger(rc) || rc < 0) {
      const e = new Error(`rows for category "${cat.name}" must be a non-negative integer`);
      e.status = 400;
      throw e;
    }
    if (rc > rowBudget) {
      const e = new Error(`category "${cat.name}" needs more rows than the venue has left`);
      e.status = 400;
      throw e;
    }
    rowBudget -= rc;
  }
  // When no category declares explicit rows, split the venue evenly so a plain
  // name list (["Premium", "Standard"]) maps across the whole floor instead of
  // the first category absorbing every row (see categoryForRow).
  const anyExplicitRows = normalized.some((cat) => cat.rows != null && Number(cat.rows) > 0);
  if (!anyExplicitRows) {
    if (r < normalized.length) {
      const e = new Error('venue must have at least as many rows as categories');
      e.status = 400;
      throw e;
    }
    const base = Math.floor(r / normalized.length);
    let remaining = r;
    normalized.forEach((cat, i) => {
      if (i === normalized.length - 1) cat.rows = remaining;
      else {
        cat.rows = base;
        remaining -= base;
      }
    });
  } else {
    for (const cat of normalized) cat.rows = cat.rows ? Number(cat.rows) : 0;
  }
  // Categories whose rows is 0/omitted absorb the remaining rows (see categoryForRow).
  return { name, address, rows: r, cols: c, categories: normalized };
}

router.post('/venues', (req, res) => {
  let data;
  try {
    data = validateVenue(req.body);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  let venueId;
  try {
    venueId = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO venues (name, address, rows, cols, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(data.name, data.address || null, data.rows, data.cols, req.user.id, Date.now());
      const vid = info.lastInsertRowid;
      const insertCat = db.prepare(
        'INSERT INTO venue_categories (venue_id, category_name, description, row_count) VALUES (?,?,?,?)'
      );
      for (const cat of data.categories) {
        insertCat.run(vid, cat.name, cat.description || null, cat.rows ? Number(cat.rows) : 0);
      }
      return vid;
    })();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.status(201).json(db.prepare('SELECT * FROM venues WHERE id = ?').get(venueId));
});

router.get('/venues', (req, res) => {
  const venues = db.prepare('SELECT * FROM venues ORDER BY id').all();
  const catStmt = db.prepare(
    'SELECT id, category_name, description, row_count FROM venue_categories WHERE venue_id = ? ORDER BY id'
  );
  for (const v of venues) v.categories = catStmt.all(v.id);
  res.json(venues);
});

router.delete('/venues/:id', (req, res) => {
  const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id);
  if (!venue) return res.status(404).json({ error: 'venue not found' });

  const eventCount = db.prepare('SELECT COUNT(*) AS c FROM events WHERE venue_id = ?').get(venue.id).c;
  if (eventCount > 0) {
    return res.status(409).json({ error: 'venue has events and cannot be deleted' });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM venue_categories WHERE venue_id = ?').run(venue.id);
    db.prepare('DELETE FROM venues WHERE id = ?').run(venue.id);
  })();
  res.json({ ok: true, deleted: venue.id });
});

module.exports = router;