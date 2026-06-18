// lib/auth.js
// ============================================================
// Authentication helpers: password hashing, JWT issuing/verifying,
// and role-elevation logic for the founder/owner account.
// ============================================================

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase().trim();

if (!JWT_SECRET) {
  console.error('[auth] JWT_SECRET is not set. Set a long random string in env vars.');
}

/** Hash a plaintext password for storage. */
async function hashPassword(password) {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(password, salt);
}

/** Compare plaintext password against stored hash. */
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Determine the role a newly-registering email should receive.
 * The founder email always becomes 'owner' — this is the ONLY
 * place role elevation happens, so it can't be triggered any other way.
 */
function resolveRoleForEmail(email) {
  if (!OWNER_EMAIL) return 'user';
  return email.toLowerCase().trim() === OWNER_EMAIL ? 'owner' : 'user';
}

/** Issue a signed JWT for an authenticated user. */
function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/** Verify and decode a JWT. Throws if invalid/expired. */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/** Extract bearer token from an Authorization header. */
function extractToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

/**
 * Middleware-style helper for API routes: verifies the request is
 * authenticated. Returns the decoded payload, or null if not authenticated.
 */
function getAuthUser(req) {
  try {
    const token = extractToken(req);
    if (!token) return null;
    return verifyToken(token);
  } catch (err) {
    return null;
  }
}

/**
 * Require admin or owner role. Returns true/false.
 * Always re-check the role against the DB for sensitive actions —
 * the JWT role is a convenience, not the sole source of truth for
 * high-risk operations like bans (see api/admin/*.js).
 */
function isAdminRole(role) {
  return role === 'admin' || role === 'owner';
}

/** Generate a secure random token for email verification / password reset. */
function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Hash a raw token before storing it (so DB leaks don't expose usable tokens). */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

module.exports = {
  hashPassword,
  comparePassword,
  resolveRoleForEmail,
  signToken,
  verifyToken,
  extractToken,
  getAuthUser,
  isAdminRole,
  generateRawToken,
  hashToken,
  OWNER_EMAIL,
};
