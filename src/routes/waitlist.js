import { requireRole, HttpError } from '../auth.js';
import { first, run, all } from '../db-helpers.js';
import { json } from '../http.js';
import { holdTtl, AVAILABLE_SQL } from '../services/holds.js';

function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
}

export function register(router) {
  router.post('/api/events/:id/waitlist', async (c, params) => {
    const user = await requireRole(c, 'customer');
    const eventId = Number(params.id);
    const evt = await first(c.db, 'SELECT id FROM events WHERE id = ?', eventId);
    if (!evt) throw new HttpError(404, 'event not found');

    const { category } = c.body || {};
    const pricing = await first(
      c.db,
      'SELECT category_name FROM event_pricing WHERE event_id = ? AND category_name = ?',
      eventId,
      category
    );
    if (!pricing) throw new HttpError(400, 'invalid category for this event');

    const now = Date.now();
    const avail = await first(
      c.db,
      `SELECT COUNT(*) AS c FROM show_seats WHERE event_id = ? AND category_name = ? AND ${AVAILABLE_SQL}`,
      eventId,
      category,
      now
    );
    if ((avail.c || 0) > 0) {
      throw new HttpError(409, `seats still available (${avail.c}) in "${category}"; no need to join the waitlist`);
    }

    const existing = await first(
      c.db,
      `SELECT * FROM waitlist
       WHERE event_id = ? AND customer_id = ? AND category_name = ? AND status IN ('waiting', 'offered')`,
      eventId,
      user.uid,
      category
    );
    if (existing) throw new HttpError(409, 'already on the waitlist for this category');

    const info = await run(
      c.db,
      'INSERT INTO waitlist (event_id, customer_id, category_name, status) VALUES (?,?,?,?)',
      eventId,
      user.uid,
      category,
      'waiting'
    );
    const entry = await first(c.db, 'SELECT * FROM waitlist WHERE id = ?', info.meta.last_row_id);
    return json({ waitlist: entry }, 201);
  });

  router.post('/api/waitlist/offer/:token', async (c, params) => {
    const user = await requireRole(c, 'customer');
    const token = params.token;
    const now = Date.now();

    const entry = await first(
      c.db,
      `SELECT * FROM waitlist WHERE offer_token = ? AND status = 'offered'`,
      token
    );
    if (!entry || !entry.offer_expires_at || entry.offer_expires_at <= now) {
      throw new HttpError(410, 'offer expired or invalid');
    }
    if (entry.customer_id !== user.uid) {
      throw new HttpError(403, 'this offer belongs to another user');
    }

    const expiresAt = now + holdTtl(c.env);
    const newToken = randomToken();

    const claimed = await run(
      c.db,
      `UPDATE waitlist SET status = 'claimed', offer_token = NULL, offer_expires_at = ?
       WHERE id = ? AND status = 'offered'`,
      expiresAt,
      entry.id
    );
    if ((claimed.meta.changes || 0) !== 1) throw new HttpError(410, 'offer expired or invalid');

    // Take the freed seat (still held under the offer token), else any
    // available seat of the category. Both are guarded single updates.
    let res = await run(
      c.db,
      `UPDATE show_seats SET status = 'held', hold_token = ?, hold_expires_at = ?
       WHERE event_id = ? AND category_name = ? AND hold_token = ? AND status = 'held'`,
      newToken,
      expiresAt,
      entry.event_id,
      entry.category_name,
      token
    );
    if ((res.meta.changes || 0) !== 1) {
      res = await run(
        c.db,
        `UPDATE show_seats SET status = 'held', hold_token = ?, hold_expires_at = ?
         WHERE id IN (SELECT id FROM show_seats WHERE event_id = ? AND category_name = ?
                      AND ${AVAILABLE_SQL} ORDER BY id LIMIT 1)`,
        newToken,
        expiresAt,
        entry.event_id,
        entry.category_name,
        now
      );
    }
    if ((res.meta.changes || 0) !== 1) {
      throw new HttpError(409, 'no seats currently available in this category');
    }

    const seat = await first(
      c.db,
      'SELECT id, seat_row, seat_col, category_name FROM show_seats WHERE hold_token = ?',
      newToken
    );
    return json({
      event_id: entry.event_id,
      seat: seat ? { id: seat.id, row: seat.seat_row, col: seat.seat_col, category: seat.category_name } : null,
      holdToken: newToken,
      expiresAt,
    });
  });
}