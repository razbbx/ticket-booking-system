const DEFAULT_HOLD_TTL = 10 * 60 * 1000; // 10 minutes

function minutesToMs(env, name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v * 60 * 1000 : fallback;
}

export function holdTtl(env) {
  return minutesToMs(env, 'HOLD_TTL_MINUTES', DEFAULT_HOLD_TTL);
}

export function offerTtl(env) {
  return minutesToMs(env, 'OFFER_TTL_MINUTES', DEFAULT_HOLD_TTL);
}

// Lazy expiry: an expired hold reads as available without needing a sweep.
export function effectiveStatus(row, now = Date.now()) {
  if (row.status === 'held' && row.hold_expires_at && row.hold_expires_at <= now) {
    return 'available';
  }
  return row.status;
}

// SQL fragment used anywhere availability is computed; the single `?` binds
// the current time in ms. Expired holds are treated as available.
export const AVAILABLE_SQL =
  "(status = 'available' OR (status = 'held' AND hold_expires_at < ?))";

export async function releaseExpiredHolds(db, now = Date.now()) {
  const res = await db
    .prepare(
      `UPDATE show_seats
       SET status = 'available', hold_token = NULL, hold_expires_at = NULL
       WHERE status = 'held' AND hold_expires_at < ?`
    )
    .bind(now)
    .run();
  return res.meta.changes || 0;
}

export async function runSweep(db, env) {
  const now = Date.now();
  const released = await db
    .prepare(
      `SELECT event_id, category_name FROM show_seats
       WHERE status = 'held' AND hold_expires_at < ?`
    )
    .bind(now)
    .all();
  const releasedCount = await releaseExpiredHolds(db, now);

  const { expireStaleOffers, offerNextInLine } = await import('./waitlist-service.js');
  const expiredOffers = await expireStaleOffers(db, env, now);

  const categories = new Set();
  for (const r of released.results || []) {
    categories.add(`${r.event_id}:${r.category_name}`);
  }
  for (const f of expiredOffers) {
    categories.add(`${f.event_id}:${f.category_name}`);
  }
  for (const key of categories) {
    const [eventId, categoryName] = key.split(':');
    await offerNextInLine(db, env, Number(eventId), categoryName);
  }
  return { released: releasedCount, expiredOffers: expiredOffers.length };
}