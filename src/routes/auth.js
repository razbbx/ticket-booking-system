import { hashPassword, verifyPassword, signToken, HttpError } from '../auth.js';
import { first, run } from '../db-helpers.js';
import { json } from '../http.js';

const ALLOWED_ROLES = ['customer', 'organiser'];

export function register(router) {
  router.post('/api/auth/register', async (c) => {
    const { name, email, password, role = 'customer' } = c.body || {};
    if (!name || !email || !password) {
      throw new HttpError(400, 'name, email and password are required');
    }
    if (String(password).length < 6) {
      throw new HttpError(400, 'password must be at least 6 characters');
    }
    if (!ALLOWED_ROLES.includes(role)) {
      throw new HttpError(400, 'role must be customer or organiser (admin is provisioned via seed)');
    }
    const existing = await first(c.db, 'SELECT id FROM users WHERE email = ?', email);
    if (existing) throw new HttpError(409, 'email already registered');

    const passwordHash = await hashPassword(password);
    const info = await run(
      c.db,
      'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
      name,
      email,
      passwordHash,
      role
    );
    const user = await first(c.db, 'SELECT id, name, email, role FROM users WHERE id = ?', info.meta.last_row_id);
    return json({ token: await signToken(user.id, user.role, c.env.SECRET || ''), user }, 201);
  });

  router.post('/api/auth/login', async (c) => {
    const { email, password } = c.body || {};
    const user = await first(c.db, 'SELECT * FROM users WHERE email = ?', email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, 'invalid credentials');
    }
    const safe = { id: user.id, name: user.name, email: user.email, role: user.role };
    return json({ token: await signToken(user.id, user.role, c.env.SECRET || ''), user: safe });
  });
}