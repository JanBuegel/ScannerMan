import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'crypto';

// ── password hashing (scrypt) ─────────────────────────────────────────────────
/** Returns "saltHex:hashHex" for storage in .env (never store plaintext). */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time verify of a plaintext password against a stored "salt:hash". */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  let salt, expected, actual;
  try {
    salt     = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
    actual   = scryptSync(password, salt, expected.length);
  } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── stateless signed session token ────────────────────────────────────────────
// Token = "<exp>.<HMAC_SHA256(exp, secret)>". No server-side store needed; the
// signature can't be forged without the secret, and the embedded expiry is checked.
export function createSessionToken(secret, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac('sha256', secret).update(String(exp)).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifySessionToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const idx     = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig     = token.slice(idx + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Math.floor(Date.now() / 1000);
}

// ── cookie helpers ────────────────────────────────────────────────────────────
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Build a Set-Cookie value. maxAge 0 clears the cookie. */
export function serializeCookie(name, value, maxAgeSeconds) {
  return [
    `${name}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Secure',                       // internet-facing over HTTPS
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}
