import { offerTtl } from './holds.js';
import { all, first, batch } from '../db-helpers.js';
import { sendOfferEmail } from './email.js';

export function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
}

// Expires `offered` waitlist entries whose offer time has passed, releases the
// seat held for them, and returns the affected (event_id, category_name) pairs
// so the caller can re-offer the seat to the next customer in line.
export async function expireStaleOffers(db, env, now = Date.now()) {
  const expired = await all(
    db,
    `SELECT id, event_id, category_name, offer_token FROM waitlist
     WHERE status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at < ?`,
    now
  );
  if (expired.length === 0) return [];

  const stmts = [];
  for (const e of expired) {
    stmts.push(
      db.prepare(`UPDATE waitlist SET status = 'expired' WHERE id = ? AND status = 'offered'`).bind(e.id)
    );
    if (e.offer_token) {
      stmts.push(
        db.prepare(
          `UPDATE show_seats SET status = 'available', hold_token = NULL, hold_expires_at = NULL
           WHERE hold_token = ? AND status = 'held'`
        ).bind(e.offer_token)
      );
    }
  }
  await batch(db, stmts);

  return expired.map((e) => ({ event_id: e.event_id, category_name: e.category_name }));
}

// FIFO: takes the oldest still-waiting customer for (event, category), holds the
// first free seat for them (guarded UPDATE), and emails a time-limited claim link.
export async function offerNextInLine(db, env, eventId, categoryName) {
  const now = Date.now();
  const ttl = offerTtl(env);

  const entry = await first(
    db,
    `SELECT * FROM waitlist
     WHERE event_id = ? AND category_name = ? AND status = 'waiting'
     ORDER BY created_at, id LIMIT 1`,
    eventId,
    categoryName
  );
  if (!entry) return null;

  const token = randomToken();
  const expiresAt = now + ttl;

  const res = await batch(db, [
    db.prepare(
      `UPDATE waitlist SET status = 'offered', offer_token = ?, offer_expires_at = ?
       WHERE id = ? AND status = 'waiting'`
    ).bind(token, expiresAt, entry.id),
    db.prepare(
      `UPDATE show_seats SET status = 'held', hold_token = ?, hold_expires_at = ?
       WHERE id IN (SELECT id FROM show_seats WHERE event_id = ? AND category_name = ?
                    AND (status = 'available' OR (status = 'held' AND hold_expires_at < ?))
                    ORDER BY id LIMIT 1)`
    ).bind(token, expiresAt, eventId, categoryName, now),
  ]);

  if (!res || res[0].meta.changes !== 1 || res[1].meta.changes !== 1) {
    return null;
  }

  const seat = await first(
    db,
    `SELECT id, seat_row, seat_col, category_name FROM show_seats WHERE hold_token = ? AND event_id = ?`,
    token,
    eventId
  );

  const customer = await first(db, `SELECT email, name FROM users WHERE id = ?`, entry.customer_id);
  if (customer) {
    const base = env.APP_URL || 'http://localhost:8787';
    const claimUrl = `${base}/#/claim?token=${encodeURIComponent(token)}`;
    await sendOfferEmail(env, {
      to: customer.email,
      category: categoryName,
      claimUrl,
      ttlMinutes: Math.round(ttl / 60000),
    });
  }

  return {
    seat: seat ? { id: seat.id, row: seat.seat_row, col: seat.seat_col, category: seat.category_name } : null,
    token,
    expiresAt,
  };
}