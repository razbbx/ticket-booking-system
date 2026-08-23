import { requireRole, HttpError } from '../auth.js';
import { first, all, run, batch, placeholders, changes } from '../db-helpers.js';
import { json } from '../http.js';
import { effectiveStatus, holdTtl } from '../services/holds.js';
import { bookingQr } from '../services/qr.js';
import { sendTicket } from '../services/email.js';
import { offerNextInLine } from '../services/waitlist-service.js';

export function register(router) {
  router.get('/svc/events/:id/seats', async (c, params) => {
    const eventId = Number(params.id);
    const evt = await first(c.db, 'SELECT id, venue_id FROM events WHERE id = ?', eventId);
    if (!evt) throw new HttpError(404, 'event not found');
    const venue = await first(c.db, 'SELECT rows, cols FROM venues WHERE id = ?', evt.venue_id);
    const now = Date.now();
    const seats = await all(
      c.db,
      `SELECT id, seat_row, seat_col, category_name, status, hold_expires_at
       FROM show_seats WHERE event_id = ? ORDER BY seat_row, seat_col`,
      eventId
    );
    return json({
      event_id: eventId,
      rows: venue.rows,
      cols: venue.cols,
      seats: seats.map((s) => ({
        id: s.id,
        row: s.seat_row,
        col: s.seat_col,
        category: s.category_name,
        status: effectiveStatus(s, now),
      })),
    });
  });

  router.post('/svc/events/:id/hold', async (c, params) => {
    await requireRole(c, 'customer');
    const eventId = Number(params.id);
    const evt = await first(c.db, 'SELECT id FROM events WHERE id = ?', eventId);
    if (!evt) throw new HttpError(404, 'event not found');

    const { seatIds } = c.body || {};
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      throw new HttpError(400, 'seatIds must be a non-empty array');
    }
    const ids = seatIds.map(Number);
    if (ids.some((n) => !Number.isInteger(n) || n < 1)) {
      throw new HttpError(400, 'invalid seat ids');
    }

    const holdToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    const now = Date.now();
    const expiresAt = now + holdTtl(c.env);
    const res = await run(
      c.db,
      `UPDATE show_seats SET status = 'held', hold_token = ?, hold_expires_at = ?
       WHERE event_id = ? AND id IN (${placeholders(ids.length)})
         AND (status = 'available' OR (status = 'held' AND hold_expires_at < ?))`,
      holdToken,
      expiresAt,
      eventId,
      ...ids,
      now
    );
    if (changes(res) < ids.length) throw new HttpError(409, 'Seat already taken');

    const held = await all(
      c.db,
      'SELECT id, seat_row, seat_col, category_name FROM show_seats WHERE hold_token = ?',
      holdToken
    );
    return json({
      holdToken,
      expiresAt,
      seats: held.map((s) => ({ id: s.id, row: s.seat_row, col: s.seat_col, category: s.category_name })),
    });
  });

  router.delete('/svc/events/:id/hold/:holdToken', async (c, params) => {
    await requireRole(c, 'customer');
    await run(
      c.db,
      `UPDATE show_seats SET status = 'available', hold_token = NULL, hold_expires_at = NULL
       WHERE event_id = ? AND hold_token = ? AND status = 'held'`,
      Number(params.id),
      params.holdToken
    );
    return json({ released: true });
  });

  router.post('/svc/events/:id/book', async (c, params) => {
    const user = await requireRole(c, 'customer');
    const eventId = Number(params.id);
    const evt = await first(c.db, 'SELECT * FROM events WHERE id = ?', eventId);
    if (!evt) throw new HttpError(404, 'event not found');

    const { holdToken, customerName, customerEmail } = c.body || {};
    if (!holdToken) throw new HttpError(400, 'holdToken is required');

    const now = Date.now();
    const seats = await all(
      c.db,
      `SELECT * FROM show_seats
       WHERE event_id = ? AND hold_token = ? AND status = 'held' AND hold_expires_at > ?`,
      eventId,
      holdToken,
      now
    );
    if (seats.length === 0) {
      throw new HttpError(409, 'no valid hold found for this token (expired, released or belongs to someone else)');
    }

    const prices = await all(c.db, 'SELECT category_name, price FROM event_pricing WHERE event_id = ?', eventId);
    const priceMap = Object.fromEntries(prices.map((p) => [p.category_name, p.price]));

    const refs = [];
    const qrs = [];
    for (const seat of seats) {
      const ref = 'TB-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      refs.push(ref);
      qrs.push(await bookingQr(ref).catch(() => null));
    }

    const ids = seats.map((s) => s.id);
    const idPh = placeholders(ids.length);
    const stmts = [
      c.db.prepare(
        `UPDATE show_seats SET status = 'booked'
         WHERE id IN (${idPh}) AND event_id = ? AND hold_token = ? AND status = 'held' AND hold_expires_at > ?`
      ).bind(...ids, eventId, holdToken, now),
    ];
    seats.forEach((seat, i) => {
      const price = priceMap[seat.category_name] ?? 0;
      stmts.push(
        c.db.prepare(
          `INSERT INTO bookings (booking_ref, event_id, customer_id, seat_id, category_name, price, qr, status)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'active'
           WHERE EXISTS (
             SELECT 1 FROM show_seats WHERE id = ? AND status = 'booked' AND hold_token = ?
           )`
        ).bind(refs[i], eventId, user.uid, seat.id, seat.category_name, price, qrs[i], seat.id, holdToken)
      );
    });
    stmts.push(
      c.db.prepare(
        `UPDATE show_seats SET hold_token = NULL, hold_expires_at = NULL
         WHERE id IN (${idPh}) AND status = 'booked' AND hold_token = ?`
      ).bind(...ids, holdToken)
    );

    const results = await batch(c.db, stmts);
    if (changes(results[0]) === 0) {
      throw new HttpError(409, 'no valid hold found for this token (expired, released or belongs to someone else)');
    }

    const refPh = placeholders(refs.length);
    const booked = await all(
      c.db,
      `SELECT b.booking_ref, b.seat_id, s.seat_row AS row, s.seat_col AS col,
              b.category_name AS category, b.price, b.qr
       FROM bookings b JOIN show_seats s ON s.id = b.seat_id
       WHERE b.booking_ref IN (${refPh})`,
      ...refs
    );
    const bookings = booked.map((b) => ({
      booking_ref: b.booking_ref,
      seat_id: b.seat_id,
      row: b.row,
      col: b.col,
      category: b.category,
      price: b.price,
      qr: b.qr,
    }));

    const customer = await first(c.db, 'SELECT id, name, email FROM users WHERE id = ?', user.uid);
    c.ctx.waitUntil(
      sendTicket(c.env, {
        to: customerEmail || (customer && customer.email) || '',
        name: customerName || (customer && customer.name) || '',
        event: evt,
        bookings,
      }).catch((err) => console.error('[EMAIL] ticket send failed', err && err.message))
    );

    return json({ bookings }, 200);
  });

  router.post('/svc/events/:id/cancel', async (c, params) => {
    const user = await requireRole(c, 'customer');
    const eventId = Number(params.id);
    const { booking_ref } = c.body || {};
    if (!booking_ref) throw new HttpError(400, 'booking_ref is required');

    const b = await first(
      c.db,
      `SELECT b.* FROM bookings b JOIN show_seats s ON s.id = b.seat_id
       WHERE b.booking_ref = ? AND b.customer_id = ? AND b.status = 'active' AND s.event_id = ?`,
      booking_ref,
      user.uid,
      eventId
    );
    if (!b) throw new HttpError(404, 'active booking not found');

    const results = await batch(c.db, [
      c.db.prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'active'`
      ).bind(b.id),
      c.db.prepare(
        `UPDATE show_seats SET status = 'available', hold_token = NULL, hold_expires_at = NULL WHERE id = ? AND status = 'booked'`
      ).bind(b.seat_id),
    ]);
    if (changes(results[0]) !== 1) throw new HttpError(404, 'active booking not found');

    await offerNextInLine(c.db, c.env, eventId, b.category_name);

    return json({ ok: true, booking_ref, event_id: eventId, category: b.category_name });
  });
}