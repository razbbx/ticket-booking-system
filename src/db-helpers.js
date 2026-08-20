export const now = () => Date.now();

export function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

export function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function all(db, sql, ...params) {
  const res = await db.prepare(sql).bind(...params).all();
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.results)) return res.results;
  return [];
}

export function batch(db, statements) {
  return db.batch(statements);
}

export function changes(result) {
  return result && result.meta ? result.meta.changes || 0 : 0;
}

export function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}