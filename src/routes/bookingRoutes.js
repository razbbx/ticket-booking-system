'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

// Customer booking history.
router.get('/api/bookings', requireAuth, requireRole('customer'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*, e.title AS event_title, s.venue_row AS seat_row, s.venue_col AS seat_col
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       JOIN show_seats s ON s.id = b.seat_id
       WHERE b.customer_id = ?
       ORDER BY b.created_at DESC`
    )
    .all(req.user.id);
  res.json(rows);
});

// Booking detail including the QR data URL.
router.get('/api/bookings/:ref', requireAuth, requireRole('customer'), (req, res) => {
  const row = db
    .prepare(
      `SELECT b.*, e.title AS event_title, e.date AS event_date, e.time AS event_time, e.type AS event_type,
              v.name AS venue_name, s.venue_row AS seat_row, s.venue_col AS seat_col
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       JOIN venues v ON v.id = e.venue_id
       JOIN show_seats s ON s.id = b.seat_id
       WHERE b.booking_ref = ? AND b.customer_id = ?`
    )
    .get(req.params.ref, req.user.id);
  if (!row) return res.status(404).json({ error: 'booking not found' });
  res.json(row);
});

module.exports = router;