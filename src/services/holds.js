'use strict';

const db = require('../db');
const { offerNextInLine, expireStaleOffers } = require('./waitlist');

const HOLD_TTL = parseInt(process.env.HOLD_TTL, 10) || 10 * 60 * 1000; // ms, default 10 minutes
const OFFER_TTL = parseInt(process.env.OFFER_TTL, 10) || 10 * 60 * 1000; // ms, default 10 minutes
const SWEEP_INTERVAL = parseInt(process.env.HOLD_SWEEP_INTERVAL, 10) || 30 * 1000; // ms, default 30 seconds

// Lazy expiry: an expired hold reads as available without needing the sweep.
function effectiveStatus(row) {
  if (row.status === 'held' && row.hold_expires_at && row.hold_expires_at <= Date.now()) {
    return 'available';
  }
  return row.status;
}

// Releases all expired holds in one transaction and returns the released seats
// so the caller can re-offer them to the waitlist.
function releaseExpiredHolds() {
  const now = Date.now();
  const released = db
    .prepare(
      `SELECT id, event_id, category_name FROM show_seats
       WHERE status = 'held' AND hold_expires_at <= ?`
    )
    .all(now);
  if (released.length === 0) return [];

  const release = db.prepare(
    `UPDATE show_seats
     SET status = 'available', held_by = NULL, hold_token = NULL, hold_expires_at = NULL
     WHERE id = ? AND status = 'held' AND hold_expires_at <= ?`
  );
  db.transaction(() => {
    for (const s of released) release.run(s.id, now);
  })();

  return released;
}

// Periodic sweep: releases expired holds/offers, then hands the freed seats to
// the next customer in line on that category's waitlist.
function startHoldSweep() {
  const timer = setInterval(() => {
    try {
      const released = releaseExpiredHolds();
      const expiredOffers = expireStaleOffers();
      for (const s of released) offerNextInLine(s.event_id, s.category_name);
      for (const s of expiredOffers) offerNextInLine(s.event_id, s.category_name);
    } catch (err) {
      console.error('[HOLD SWEEP]', err.message);
    }
  }, SWEEP_INTERVAL);
  timer.unref();
  return timer;
}

module.exports = { HOLD_TTL, OFFER_TTL, SWEEP_INTERVAL, effectiveStatus, releaseExpiredHolds, startHoldSweep };