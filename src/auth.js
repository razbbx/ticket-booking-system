const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_BITS = 256;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Constant-time byte comparison (Web Crypto has no timingSafeEqual).
export function timingSafeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2Bytes(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    PBKDF2_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const hash = await pbkdf2Bytes(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = b64urlToBytes(parts[2]);
  const expected = b64urlToBytes(parts[3]);
  const candidate = await pbkdf2Bytes(password, salt, iterations);
  return timingSafeEqualBytes(candidate, expected);
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return new Uint8Array(sig);
}

// Token format: base64url(payload).base64url(exp).base64url(sig)
// payload = { uid, role }, exp = epoch seconds, sig = HMAC(secret, `${payload}.${exp}`)
export async function signToken(uid, role, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const payloadStr = JSON.stringify({ uid, role });
  const exp = nowSec + TOKEN_TTL_SECONDS;
  const payloadB64 = bytesToB64url(enc.encode(payloadStr));
  const expB64 = bytesToB64url(enc.encode(String(exp)));
  const sig = await hmacSha256(secret, `${payloadB64}.${expB64}`);
  return `${payloadB64}.${expB64}.${bytesToB64url(sig)}`;
}

export async function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payloadB64, expB64, sigB64] = parts;
  const expectedSig = await hmacSha256(secret, `${payloadB64}.${expB64}`);
  const givenSig = b64urlToBytes(sigB64);
  if (!timingSafeEqualBytes(givenSig, expectedSig)) return null;
  let payload;
  let exp;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(payloadB64)));
    exp = Number(dec.decode(b64urlToBytes(expB64)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid === 'undefined' || !Number.isFinite(exp)) return null;
  if (exp <= Math.floor(Date.now() / 1000)) return null;
  return { uid: payload.uid, role: payload.role, exp };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function extractToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export async function requireAuth(c) {
  const token = extractToken(c.request);
  const payload = token ? await verifyToken(token, c.env.SECRET || '') : null;
  if (!payload) throw new HttpError(401, 'authentication required');
  return payload;
}

export async function requireRole(c, ...roles) {
  const payload = await requireAuth(c);
  if (!roles.includes(payload.role)) {
    throw new HttpError(403, 'forbidden: insufficient role');
  }
  return payload;
}