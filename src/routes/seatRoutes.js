'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { HOLD_TTL, effectiveStatus } = require('../services/holds');
const { bookingQr } = require('../services/qr');
const { sendTicket } = require('../services/email');
const { offerNextInLine } = require('../services/waitlist');

// --- Public seat map for an event (expired holds read as available) ---
router.get('/api/events/:id/seats', (req, res) => {
  const evt = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!evt) return res.status(404).json({ error: 'event not found' });
  const venue = db.prepare('SELECT rows, cols FROM venues WHERE id = ?').get(evt.venue_id);
  const seats = db
    .prepare('SELECT id, venue_row, venue_col, category_name, status, hold_expires_at FROM show_seats WHERE event_id = ? ORDER BY venue_row, venue_col')
    .all(evt.id)
    .map((s) => ({ id: s.id, row: s.venue_row, col: s.venue_col, category: s.category_name, status: effectiveStatus(s) }));
  res.json({ event_id: evt.id, rows: venue.rows, cols: venue.cols, seats });
});

// --- Hold seats. Atomic guarded UPDATEs inside BEGIN IMMEDIATE; an expired
// hold is treated as available in the same statement (lazy expiry). ---
router.post('/api/events/:id/hold', requireAuth, requireRole('customer'), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'event not found' });

  const { seatIds } = req.body || {};
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }

  const holdToken = crypto.randomBytes(16).toString('base64url');
  const now = Date.now();
  const expiresAt = now + HOLD_TTL;
  const update = db.prepare(
    `UPDATE show_seats
     SET status = 'held', held_by = ?, hold_token = ?, hold_expires_at = ?
     WHERE id = ? AND event_id = ?
       AND (status = 'available' OR (status = 'held' AND hold_expires_at <= ?))`
  );

  try {
    const held = db.transaction(() => {
      const result = [];
      for (const seatId of seatIds) {
        const info = update.run(req.user.id, holdToken, expiresAt, seatId, eventId, now);
        if (info.changes === 0) {
          const seat = db.prepare('SELECT * FROM show_seats WHERE id = ? AND event_id = ?').get(seatId, eventId);
          if (!seat) {
            const e = new Error(`seat ${seatId} does not belong to this event`);
            e.status = 400;
            throw e;
          }
          const e = new Error(`Seat row ${seat.venue_row}, col ${seat.venue_col} is not available (held or booked)`);
          e.status = 409;
          throw e;
        }
        const seat = db.prepare('SELECT id, venue_row, venue_col, category_name FROM show_seats WHERE id = ?').get(seatId);
        result.push({ id: seat.id, row: seat.venue_row, col: seat.venue_col, category: seat.category_name });
      }
      return result;
    })();
    res.json({ holdToken, expiresAt, seats: held });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// --- Abandon a hold: release every seat tagged with this hold token. ---
router.delete('/api/events/:id/hold/:holdToken', requireAuth, requireRole('customer'), (req, res) => {
  const info = db
    .prepare(
      `UPDATE show_seats SET status = 'available', held_by = NULL, hold_token = NULL, hold_expires_at = NULL
       WHERE event_id = ? AND hold_token = ? AND status = 'held' AND held_by = ?`
    )
    .run(req.params.id, req.params.holdToken, req.user.id);
  res.json({ ok: true, released: info.changes });
});

// --- Book held seats in one transaction: verify hold, convert to booked,
// create bookings with unique references. QR codes and emails happen after
// commit (they need async I/O and don't affect seat state). ---
router.post('/api/events/:id/book', requireAuth, requireRole('customer'), async (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'event not found' });

  const { holdToken } = req.body || {};
  if (!holdToken) return res.status(400).json({ error: 'holdToken is required' });

  const now = Date.now();
  let bookings;
  try {
    bookings = db.transaction(() => {
      const seats = db
        .prepare(
          `SELECT * FROM show_seats
           WHERE event_id = ? AND hold_token = ? AND status = 'held' AND held_by = ? AND hold_expires_at > ?`
        )
        .all(eventId, holdToken, req.user.id, now);
      if (seats.length === 0) {
        const e = new Error('no valid hold found for this token (expired, released or belongs to someone else)');
        e.status = 410;
        throw e;
      }

      const priceStmt = db.prepare('SELECT price FROM event_pricing WHERE event_id = ? AND category_name = ?');
      const toBook = db.prepare(`UPDATE show_seats SET status = 'booked' WHERE id = ? AND status = 'held' AND hold_token = ?`);
      const insertBooking = db.prepare(
        `INSERT INTO bookings (booking_ref, event_id, customer_id, seat_id, category_name, price, status, created_at)
         VALUES (?,?,?,?,?,?,'active',?)`
      );

      const result = [];
      for (const seat of seats) {
        const upd = toBook.run(seat.id, holdToken);
        if (upd.changes !== 1) {
          const e = new Error(`seat ${seat.id} was lost concurrently`);
          e.status = 409;
          throw e;
        }
        const priceRow = priceStmt.get(eventId, seat.category_name);
        const ref = 'TB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        insertBooking.run(ref, eventId, req.user.id, seat.id, seat.category_name, priceRow ? priceRow.price : 0, now);
        result.push({
          booking_ref: ref,
          seat_id: seat.id,
          row: seat.venue_row,
          col: seat.venue_col,
          category: seat.category_name,
          price: priceRow ? priceRow.price : 0,
        });
      }
      return result;
    })();
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  for (const b of bookings) {
    const qr = await bookingQr(b.booking_ref).catch(() => null);
    db.prepare('UPDATE bookings SET qr_data = ? WHERE booking_ref = ?').run(qr || null, b.booking_ref);
    b.qr = qr;
  }

  const customer = db.prepare('SELECT email, name FROM users WHERE id = ?').get(req.user.id);
  await sendTicket({ to: customer.email, name: customer.name, event, bookings });
  res.status(201).json({ bookings });
});

// --- Cancel a booking: mark cancelled, free the seat, then hand it to the
// next customer on that category's waitlist (FIFO, time-limited offer). ---
router.post('/api/events/:id/cancel', requireAuth, requireRole('customer'), (req, res) => {
  const eventId = Number(req.params.id);
  const { booking_ref } = req.body || {};
  if (!booking_ref) return res.status(400).json({ error: 'booking_ref is required' });

  const now = Date.now();
  let cancelled;
  try {
    cancelled = db.transaction(() => {
      const b = db
        .prepare(
          `SELECT b.* FROM bookings b
           JOIN show_seats s ON s.id = b.seat_id
           WHERE b.booking_ref = ? AND b.customer_id = ? AND b.status = 'active' AND s.event_id = ?`
        )
        .get(booking_ref, req.user.id, eventId);
      if (!b) {
        const e = new Error('active booking not found');
        e.status = 404;
        throw e;
      }
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(now, b.id);
      db.prepare(
        `UPDATE show_seats SET status = 'available', held_by = NULL, hold_token = NULL, hold_expires_at = NULL WHERE id = ?`
      ).run(b.seat_id);
      return { event_id: b.event_id, category: b.category_name, booking_ref: b.booking_ref };
    })();
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  offerNextInLine(cancelled.event_id, cancelled.category);
  res.json({ ok: true, ...cancelled });
});

module.exports = router;