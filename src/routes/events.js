import { requireRole, HttpError } from '../auth.js';
import { first, all, run, batch } from '../db-helpers.js';
import { json } from '../http.js';
import { AVAILABLE_SQL } from '../services/holds.js';
import {
  buildAssignments,
  categoryForRow,
  listVenues,
} from '../services/venue-layout.js';

export function register(router) {
  router.get('/api/venues', async (c) => {
    return json(await listVenues(c.db));
  });

  router.get('/api/events', async (c) => {
    const type = c.url.searchParams.get('type');
    const q = c.url.searchParams.get('q');
    const date = c.url.searchParams.get('date');
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push('e.type = ?');
      params.push(String(type).toLowerCase());
    }
    if (date) {
      clauses.push('e.date = ?');
      params.push(date);
    }
    if (q) {
      clauses.push('(e.title LIKE ? OR e.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await all(
      c.db,
      `SELECT e.id, e.title, e.type, e.date, e.time, e.description, v.name AS venue_name
       FROM events e JOIN venues v ON v.id = e.venue_id
       ${where} ORDER BY e.created_at DESC`,
      ...params
    );
    const now = Date.now();
    const out = [];
    for (const row of rows) {
      const pricing = await all(c.db, 'SELECT category_name, price FROM event_pricing WHERE event_id = ?', row.id);
      const avail = await first(
        c.db,
        `SELECT COUNT(*) AS c FROM show_seats WHERE event_id = ? AND ${AVAILABLE_SQL}`,
        row.id,
        now
      );
      out.push({
        ...row,
        pricing: Object.fromEntries(pricing.map((p) => [p.category_name, p.price])),
        soldOut: (avail.c || 0) === 0,
      });
    }
    return json(out);
  });

  router.get('/api/events/:id', async (c, params) => {
    const evt = await first(
      c.db,
      `SELECT e.*, v.name AS venue_name, v.rows AS venue_rows, v.cols AS venue_cols
       FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.id = ?`,
      Number(params.id)
    );
    if (!evt) throw new HttpError(404, 'event not found');
    const pricing = await all(c.db, 'SELECT category_name, price FROM event_pricing WHERE event_id = ?', evt.id);
    const now = Date.now();
    const byCat = await all(
      c.db,
      `SELECT category_name, COUNT(*) AS c FROM show_seats WHERE event_id = ? AND ${AVAILABLE_SQL} GROUP BY category_name`,
      evt.id,
      now
    );
    const { venue_rows, venue_cols, ...rest } = evt;
    return json({
      ...rest,
      pricing: Object.fromEntries(pricing.map((p) => [p.category_name, p.price])),
      seats: {
        rows: venue_rows,
        cols: venue_cols,
        availableByCategory: Object.fromEntries(byCat.map((r) => [r.category_name, r.c])),
      },
    });
  });

  router.post('/api/organiser/events', async (c) => {
    const user = await requireRole(c, 'organiser');
    const { venue_id, title, type, date, time, description, pricing } = c.body || {};
    if (!title || !type || !date || !time) {
      throw new HttpError(400, 'title, type, date and time are required');
    }
    const venue = await first(c.db, 'SELECT * FROM venues WHERE id = ?', Number(venue_id));
    if (!venue) throw new HttpError(404, 'venue not found');
    if (!['movie', 'concert'].includes(type)) throw new HttpError(400, 'type must be movie or concert');
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing) || Object.keys(pricing).length === 0) {
      throw new HttpError(400, 'pricing is required');
    }
    const vcats = await all(c.db, 'SELECT * FROM venue_categories WHERE venue_id = ? ORDER BY id', venue.id);
    const validCategories = new Set(vcats.map((v) => v.category_name));
    for (const [cat, price] of Object.entries(pricing)) {
      if (!validCategories.has(cat)) {
        throw new HttpError(400, `pricing category "${cat}" is not defined for this venue`);
      }
      if (!Number.isFinite(Number(price)) || Number(price) < 0) {
        throw new HttpError(400, `invalid price for category "${cat}"`);
      }
    }
    const assignments = buildAssignments(venue.rows, vcats.map((v) => ({ name: v.category_name, rows: v.row_count })));
    const info = await run(
      c.db,
      'INSERT INTO events (organiser_id, venue_id, title, type, date, time, description) VALUES (?,?,?,?,?,?,?)',
      user.uid,
      venue.id,
      title,
      type,
      date,
      time,
      description || null
    );
    const eventId = info.meta.last_row_id;
    const stmts = [];
    for (const [cat, price] of Object.entries(pricing)) {
      stmts.push(
        c.db.prepare('INSERT INTO event_pricing (event_id, category_name, price) VALUES (?,?,?)').bind(eventId, cat, Number(price))
      );
    }
    const seatStmt = c.db.prepare('INSERT INTO show_seats (event_id, seat_row, seat_col, category_name) VALUES (?,?,?,?)');
    for (let r = 1; r <= venue.rows; r++) {
      const cat = categoryForRow(r, assignments);
      for (let col = 1; col <= venue.cols; col++) {
        stmts.push(seatStmt.bind(eventId, r, col, cat));
      }
    }
    try {
      await batch(c.db, stmts);
    } catch (err) {
      await run(c.db, 'DELETE FROM events WHERE id = ?', eventId).catch(() => {});
      throw err;
    }
    const evt = await first(c.db, 'SELECT * FROM events WHERE id = ?', eventId);
    return json(evt, 201);
  });

  router.get('/api/organiser/events', async (c) => {
    const user = await requireRole(c, 'organiser');
    const rows = await all(
      c.db,
      `SELECT e.*, v.name AS venue_name FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.organiser_id = ? ORDER BY e.created_at DESC`,
      user.uid
    );
    return json(rows);
  });

  router.get('/api/organiser/events/:id/revenue', async (c, params) => {
    const user = await requireRole(c, 'organiser');
    const evt = await first(
      c.db,
      'SELECT * FROM events WHERE id = ? AND organiser_id = ?',
      Number(params.id),
      user.uid
    );
    if (!evt) throw new HttpError(404, 'event not found');
    const categories = await all(
      c.db,
      `SELECT s.category_name AS category,
              COUNT(b.id) AS count,
              COALESCE(SUM(b.price), 0) AS revenue
       FROM show_seats s
       JOIN bookings b ON b.seat_id = s.id
       WHERE s.event_id = ? AND b.status = 'active'
       GROUP BY s.category_name`,
      evt.id
    );
    const total = categories.reduce(
      (acc, r) => ({ count: acc.count + r.count, revenue: acc.revenue + r.revenue }),
      { count: 0, revenue: 0 }
    );
    return json({ event_id: evt.id, title: evt.title, categories, total });
  });
}