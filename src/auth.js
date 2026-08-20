'use strict';

const crypto = require('crypto');

// HMAC signing secret. Falls back to a random per-process secret so the app
// still works when SECRET is not configured (tokens just reset on restart).
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const actual = Buffer.from(hash, 'hex');
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}

function issueToken(user) {
  const body = Buffer.from(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      role: user.role,
      iat: Date.now(),
      exp: Date.now() + TOKEN_TTL,
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'authentication required' });
  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden: insufficient role' });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, requireAuth, requireRole };
