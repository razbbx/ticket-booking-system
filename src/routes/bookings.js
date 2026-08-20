import { requireRole, HttpError } from '../auth.js';
import { first, all } from '../db-helpers.js';
import { json } from '../http.js';

const SELECT_FIELDS = `
  b.booking_ref,
  b.category_name AS category,
  b.price,
  b.status,
  b.qr,
  b.created_at,
  e.title AS event_title,
  e.date AS event_date,
  e.time AS event_time,
  e.type AS event_type,
  v.name AS venue_name,
  s.seat_row,
  s.seat_col
`;

const FROM_JOINS = `
  FROM bookings b
  JOIN events e ON e.id = b.event_id
  JOIN venues v ON v.id = e.venue_id
  JOIN show_seats s ON s.id = b.seat_id
`;

export function register(router) {
  router.get('/api/bookings', async (c) => {
    const user = await requireRole(c, 'customer');
    const rows = await all(
      c.db,
      `SELECT ${SELECT_FIELDS} ${FROM_JOINS} WHERE b.customer_id = ? ORDER BY b.created_at DESC`,
      user.uid
    );
    return json(rows);
  });

  router.get('/api/bookings/:ref', async (c, params) => {
    const user = await requireRole(c, 'customer');
    const row = await first(
      c.db,
      `SELECT ${SELECT_FIELDS} ${FROM_JOINS} WHERE b.booking_ref = ? AND b.customer_id = ?`,
      params.ref,
      user.uid
    );
    if (!row) throw new HttpError(404, 'booking not found');
    return json(row);
  });
}