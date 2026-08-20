import { all } from '../db-helpers.js';
import { HttpError } from '../auth.js';

export function normalizeCategories(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'categories must be a non-empty array');
  }
  return raw.map((cat) =>
    typeof cat === 'string'
      ? { name: cat, rows: 0 }
      : { name: cat && cat.name, rows: cat && cat.rows ? Number(cat.rows) : 0 }
  );
}

// Distributes the venue's rows across categories. Explicit row_count values are
// honored top-down; the final category absorbs the leftover rows. When no
// category declares explicit rows the floor is split as evenly as possible.
export function distributeRows(totalRows, cats) {
  const hasExplicit = cats.some((c) => c.rows > 0);
  if (!hasExplicit) {
    if (totalRows < cats.length) {
      throw new HttpError(400, 'venue must have at least as many rows as categories');
    }
    const base = Math.floor(totalRows / cats.length);
    let remaining = totalRows;
    return cats.map((c, i) => {
      if (i === cats.length - 1) return { name: c.name, rows: remaining };
      const rows = base;
      remaining -= base;
      return { name: c.name, rows };
    });
  }
  let used = 0;
  const out = [];
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    if (i === cats.length - 1) {
      out.push({ name: c.name, rows: Math.max(totalRows - used, 0) });
    } else {
      if (used + c.rows > totalRows) {
        throw new HttpError(400, `category "${c.name}" needs more rows than the venue has left`);
      }
      out.push({ name: c.name, rows: c.rows });
      used += c.rows;
    }
  }
  return out;
}

// Turns a category distribution into explicit [start, end] row ranges used when
// seeding show_seats rows for an event.
export function buildAssignments(totalRows, cats) {
  const dist = distributeRows(totalRows, cats);
  let start = 1;
  return dist.map((c) => {
    const assignment = { name: c.name, rows: c.rows, start, end: start + c.rows - 1 };
    start += c.rows;
    return assignment;
  });
}

export function categoryForRow(row, assignments) {
  for (const a of assignments) {
    if (row >= a.start && row <= a.end) return a.name;
  }
  return assignments.length ? assignments[assignments.length - 1].name : null;
}

export async function listVenues(db) {
  const venues = await all(db, 'SELECT * FROM venues ORDER BY id');
  const cats = await all(db, 'SELECT * FROM venue_categories ORDER BY venue_id, id');
  const byVenue = {};
  for (const c of cats) {
    (byVenue[c.venue_id] = byVenue[c.venue_id] || []).push({
      id: c.id,
      category_name: c.category_name,
      row_count: c.row_count,
    });
  }
  return venues.map((v) => ({ ...v, categories: byVenue[v.id] || [] }));
}