import { requireRole, HttpError } from '../auth.js';
import { first, run, batch } from '../db-helpers.js';
import { json } from '../http.js';
import { normalizeCategories, distributeRows, listVenues } from '../services/venue-layout.js';

export function register(router) {
  router.get('/api/admin/venues', async (c) => {
    await requireRole(c, 'admin');
    return json(await listVenues(c.db));
  });

  router.post('/api/admin/venues', async (c) => {
    await requireRole(c, 'admin');
    const { name, address, rows, cols, categories } = c.body || {};
    const r = Number(rows);
    const col = Number(cols);
    if (!name) throw new HttpError(400, 'name is required');
    if (!Number.isInteger(r) || r < 1 || !Number.isInteger(col) || col < 1) {
      throw new HttpError(400, 'rows and cols must be positive integers');
    }
    let cats = normalizeCategories(categories);
    const seen = new Set();
    for (const cat of cats) {
      if (!cat.name) throw new HttpError(400, 'each category needs a name');
      if (seen.has(cat.name)) throw new HttpError(400, `duplicate category "${cat.name}"`);
      seen.add(cat.name);
      if (!Number.isInteger(cat.rows) || cat.rows < 0) {
        throw new HttpError(400, `rows for category "${cat.name}" must be a non-negative integer`);
      }
    }
    const dist = distributeRows(r, cats);
    const info = await run(
      c.db,
      'INSERT INTO venues (name, address, rows, cols) VALUES (?,?,?,?)',
      name,
      address || null,
      r,
      col
    );
    const vid = info.meta.last_row_id;
    const stmts = dist.map((cat) =>
      c.db.prepare('INSERT INTO venue_categories (venue_id, category_name, row_count) VALUES (?,?,?)').bind(vid, cat.name, cat.rows)
    );
    await batch(c.db, stmts);
    const venue = await first(c.db, 'SELECT * FROM venues WHERE id = ?', vid);
    return json({ ...venue, categories: dist.map((cat) => ({ category_name: cat.name, row_count: cat.rows })) }, 201);
  });

  router.delete('/api/admin/venues/:id', async (c, params) => {
    await requireRole(c, 'admin');
    const vid = Number(params.id);
    const venue = await first(c.db, 'SELECT * FROM venues WHERE id = ?', vid);
    if (!venue) throw new HttpError(404, 'venue not found');
    const evCount = await first(c.db, 'SELECT COUNT(*) AS c FROM events WHERE venue_id = ?', vid);
    if ((evCount.c || 0) > 0) {
      throw new HttpError(409, 'venue has events and cannot be deleted');
    }
    await batch(c.db, [
      c.db.prepare('DELETE FROM venue_categories WHERE venue_id = ?').bind(vid),
      c.db.prepare('DELETE FROM venues WHERE id = ?').bind(vid),
    ]);
    return json({ ok: true, deleted: vid });
  });
}