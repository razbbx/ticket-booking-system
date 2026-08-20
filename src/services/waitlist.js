'use strict';

const crypto = require('crypto');
const db = require('../db');
const { sendMail } = require('./email');

const OFFER_TTL = parseInt(process.env.OFFER_TTL, 10) || 10 * 60 * 1000; // ms, default 10 minutes
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Expires offers that were not claimed in time, releasing the seat they held.
// Returns the freed seats so the sweep can re-offer them to the next in line.
function expireStaleOffers() {
  const now = Date.now();
  const expired = db
    .prepare(
      `SELECT w.id AS waitlist_id, w.event_id, w.category_name, s.id AS seat_id, w.offer_token
       FROM waitlist w
       JOIN show_seats s ON s.event_id = w.event_id AND s.hold_token = w.offer_token AND s.status = 'held'
       WHERE w.status = 'offered' AND w.offer_expires_at <= ?`
    )
    .all(now);
  if (expired.length === 0) return [];

  const markExpired = db.prepare(`UPDATE waitlist SET status = 'expired' WHERE id = ?`);
  const releaseSeat = db.prepare(
    `UPDATE show_seats SET status = 'available', held_by = NULL, hold_token = NULL, hold_expires_at = NULL
     WHERE id = ? AND hold_token = ? AND status = 'held'`
  );
  db.transaction(() => {
    for (const e of expired) {
      markExpired.run(e.waitlist_id);
      releaseSeat.run(e.seat_id, e.offer_token);
    }
  })();

  return expired.map((e) => ({ event_id: e.event_id, category_name: e.category_name }));
}

// FIFO: takes the oldest still-waiting customer for (event, category), holds the
// first free seat for them, and emails a time-limited claim link.
function offerNextInLine(eventId, categoryName) {
  const now = Date.now();
  const seat = db
    .prepare(
      `SELECT * FROM show_seats
       WHERE event_id = ? AND category_name = ? AND status = 'available'
       ORDER BY id LIMIT 1`
    )
    .get(eventId, categoryName);
  if (!seat) return null;

  const entry = db
    .prepare(
      `SELECT * FROM waitlist
       WHERE event_id = ? AND category_name = ? AND status = 'waiting'
       ORDER BY created_at, id LIMIT 1`
    )
    .get(eventId, categoryName);
  if (!entry) return null;

  const token = crypto.randomBytes(16).toString('base64url');
  const expiresAt = now + OFFER_TTL;

  try {
    db.transaction(() => {
      const upd = db
        .prepare(
          `UPDATE show_seats SET status = 'held', held_by = ?, hold_token = ?, hold_expires_at = ?
           WHERE id = ? AND status = 'available'`
        )
        .run(entry.customer_id, token, expiresAt, seat.id);
      if (upd.changes !== 1) throw new Error('seat taken concurrently');

      const marked = db
        .prepare(
          `UPDATE waitlist SET status = 'offered', offer_token = ?, offer_expires_at = ?
           WHERE id = ? AND status = 'waiting'`
        )
        .run(token, expiresAt, entry.id);
      if (marked.changes !== 1) throw new Error('waitlist entry taken concurrently');
    })();
  } catch (err) {
    console.error('[WAITLIST]', err.message);
    return null;
  }

  const customer = db.prepare('SELECT email FROM users WHERE id = ?').get(entry.customer_id);
  if (customer) {
    const claimUrl = `${APP_URL}/#/claim?token=${encodeURIComponent(token)}`;
    const subject = `A seat just opened up for your waitlisted event`;
    const text = `Good news! A seat in category "${categoryName}" is now available.\nClaim it within ${Math.round(
      OFFER_TTL / 60000
    )} minutes:\n${claimUrl}`;
    sendMail({ to: customer.email, subject, text });
  }

  return {
    waitlist: { ...entry, status: 'offered', offer_token: token, offer_expires_at: expiresAt },
    seat: { id: seat.id, row: seat.venue_row, col: seat.venue_col, category: seat.category_name },
  };
}

module.exports = { offerNextInLine, expireStaleOffers };