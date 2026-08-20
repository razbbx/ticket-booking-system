'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { HOLD_TTL } = require('../services/holds');

// Join the FIFO waitlist for a seat category of an event. Only allowed once
// the category is actually sold out.
router.post('/api/events/:id/waitlist', requireAuth, requireRole('customer'), (req, res) => {
  const eventId = Number(req.params.id);
  const { category } = req.body || {};

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'event not found' });

  const pricing = db.prepare('SELECT category_name FROM event_pricing WHERE event_id = ? AND category_name = ?').get(eventId, category);
  if (!pricing) return res.status(400).json({ error: 'invalid category for this event' });

  const available = db
    .prepare(`SELECT COUNT(*) AS c FROM show_seats WHERE event_id = ? AND category_name = ? AND status = 'available'`)
    .get(eventId, category).c;
  if (available > 0) {
    return res.status(400).json({ error: `seats still available (${available}) in "${category}"; no need to join the waitlist` });
  }

  const existing = db
    .prepare(`SELECT * FROM waitlist WHERE event_id = ? AND customer_id = ? AND category_name = ? AND status IN ('waiting', 'offered')`)
    .get(eventId, req.user.id, category);
  if (existing) return res.status(200).json({ waitlist: existing, message: 'already on the waitlist' });

  const info = db
    .prepare(`INSERT INTO waitlist (event_id, customer_id, category_name, status, created_at) VALUES (?,?,?,?,?)`)
    .run(eventId, req.user.id, category, 'waiting', Date.now());
  const entry = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ waitlist: entry });
});

// Claim a time-limited seat offer. Validates the token and the claiming user,
// marks the entry claimed and extends the hold so the customer can book.
router.post('/api/waitlist/offer/:token', requireAuth, requireRole('customer'), (req, res) => {
  const now = Date.now();
  const entry = db.prepare(`SELECT * FROM waitlist WHERE offer_token = ? AND status = 'offered'`).get(req.params.token);
  if (!entry || entry.offer_expires_at <= now) {
    return res.status(410).json({ error: 'offer expired or invalid' });
  }
  if (entry.customer_id !== req.user.id) {
    return res.status(403).json({ error: 'this offer belongs to another user' });
  }
  const seat = db
    .prepare(`SELECT * FROM show_seats WHERE event_id = ? AND category_name = ? AND hold_token = ? AND status = 'held'`)
    .get(entry.event_id, entry.category_name, req.params.token);
  if (!seat) {
    return res.status(410).json({ error: 'seat is no longer held; please re-join the waitlist' });
  }

  const expiresAt = now + HOLD_TTL;
  db.transaction(() => {
    db.prepare(`UPDATE waitlist SET status = 'claimed', offer_expires_at = ? WHERE id = ?`).run(expiresAt, entry.id);
    db.prepare(`UPDATE show_seats SET hold_expires_at = ? WHERE id = ?`).run(expiresAt, seat.id);
  })();

  res.json({
    event_id: entry.event_id,
    holdToken: req.params.token,
    expiresAt,
    seat: { id: seat.id, row: seat.venue_row, col: seat.venue_col, category: seat.category_name },
  });
});

module.exports = router;