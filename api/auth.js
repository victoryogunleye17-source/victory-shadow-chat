// api/auth.js
// ============================================================
// All authentication routes in a single serverless function.
// Route is determined by the ?action= query parameter.
//
// Actions:
//   POST register          — create account
//   POST login             — sign in, get JWT
//   POST logout            — mark offline
//   GET  me                — get current user profile
//   PUT  profile           — update profile
//   POST verify-email      — confirm email with token
//   POST forgot-password   — request reset email
//   POST reset-password    — set new password with token
//   POST resend-verification — send new verification email
// ============================================================

const { sql } = require('../lib/db');
const {
  hashPassword, comparePassword, resolveRoleForEmail,
  signToken, getAuthUser, generateRawToken, hashToken, OWNER_EMAIL,
} = require('../lib/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../lib/email');
const { checkRateLimit, getClientIp } = require('../lib/rateLimit');
const { logSecurityEvent } = require('../lib/security');
const { handlePreflight, ok, fail } = require('../lib/respond');

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const action = req.query.action;

  switch (action) {
    case 'register':     return register(req, res);
    case 'login':        return login(req, res);
    case 'logout':       return logout(req, res);
    case 'me':           return me(req, res);
    case 'profile':      return profile(req, res);
    case 'verify-email': return verifyEmail(req, res);
    case 'forgot-password': return forgotPassword(req, res);
    case 'reset-password':  return resetPassword(req, res);
    case 'resend-verification': return resendVerification(req, res);
    default: return fail(res, 'Unknown action.', 400);
  }
};

// ---------- register ----------
async function register(req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const ip = getClientIp(req);
  const { success } = await checkRateLimit('auth', ip);
  if (!success) return fail(res, 'Too many attempts. Please wait a moment.', 429);

  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) return fail(res, 'Username, email, and password are required.');
    if (!USERNAME_RE.test(username)) return fail(res, 'Username must be 3-32 chars: letters, numbers, underscore or period.');
    if (!EMAIL_RE.test(email)) return fail(res, 'Please enter a valid email address.');
    if (password.length < 8) return fail(res, 'Password must be at least 8 characters.');

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} OR username = ${username} LIMIT 1`;
    if (existing.length > 0) return fail(res, 'An account with that email or username already exists.', 409);

    const passwordHash = await hashPassword(password);
    const role = resolveRoleForEmail(normalizedEmail);
    const [user] = await sql`
      INSERT INTO users (username, email, password_hash, role)
      VALUES (${username}, ${normalizedEmail}, ${passwordHash}, ${role})
      RETURNING id, username, email, role
    `;

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await sql`INSERT INTO auth_tokens (user_id, token_hash, type, expires_at) VALUES (${user.id}, ${tokenHash}, 'verify_email', ${expiresAt.toISOString()})`;
    await sendVerificationEmail(normalizedEmail, username, rawToken);
    await logSecurityEvent('account_created', { userId: user.id, ip });

    return ok(res, { message: 'Account created. Check your email to verify your account.', user: { id: user.id, username: user.username, email: user.email } }, 201);
  } catch (err) {
    console.error('[register]', err);
    return fail(res, 'Something went wrong creating your account.', 500);
  }
}

// ---------- login ----------
async function login(req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const ip = getClientIp(req);
  const { success } = await checkRateLimit('auth', ip);
  if (!success) return fail(res, 'Too many login attempts. Please wait.', 429);

  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 'Email and password are required.');
    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await sql`SELECT id, username, email, password_hash, role, is_verified, is_banned, is_suspended, suspended_until, avatar_url FROM users WHERE email = ${normalizedEmail} LIMIT 1`;

    if (!user) { await logSecurityEvent('failed_login', { ip, metadata: { email: normalizedEmail } }); return fail(res, 'Invalid email or password.', 401); }
    if (!await comparePassword(password, user.password_hash)) { await logSecurityEvent('failed_login', { userId: user.id, ip }); return fail(res, 'Invalid email or password.', 401); }
    if (user.is_banned) return fail(res, 'This account has been banned.', 403, { banned: true });
    if (user.is_suspended && (!user.suspended_until || new Date(user.suspended_until) > new Date())) {
      return fail(res, 'This account is temporarily suspended.', 403, { suspended: true, suspendedUntil: user.suspended_until });
    }
    if (!user.is_verified) return fail(res, 'Please verify your email before logging in.', 403, { needsVerification: true });

    const token = signToken(user);
    await sql`UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE id = ${user.id}`;
    await logSecurityEvent('login_success', { userId: user.id, ip });

    return ok(res, { token, user: { id: user.id, username: user.username, email: user.email, role: user.role, avatarUrl: user.avatar_url } });
  } catch (err) {
    console.error('[login]', err);
    return fail(res, 'Something went wrong logging you in.', 500);
  }
}

// ---------- logout ----------
async function logout(req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const auth = getAuthUser(req);
  if (!auth) return fail(res, 'Not authenticated.', 401);
  try {
    await sql`UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE id = ${auth.sub}`;
    return ok(res, { message: 'Logged out.' });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- me ----------
async function me(req, res) {
  if (req.method !== 'GET') return fail(res, 'Method not allowed', 405);
  const auth = getAuthUser(req);
  if (!auth) return fail(res, 'Not authenticated.', 401);
  try {
    const [user] = await sql`SELECT id, username, email, avatar_url, bio, status_message, role, share_location, is_online, last_seen, created_at FROM users WHERE id = ${auth.sub} LIMIT 1`;
    if (!user) return fail(res, 'User not found.', 404);
    return ok(res, { user: { id: user.id, username: user.username, email: user.email, avatarUrl: user.avatar_url, bio: user.bio, statusMessage: user.status_message, role: user.role, shareLocation: user.share_location, isOnline: user.is_online, lastSeen: user.last_seen, createdAt: user.created_at } });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- profile ----------
async function profile(req, res) {
  if (req.method !== 'PUT' && req.method !== 'PATCH') return fail(res, 'Method not allowed', 405);
  const auth = getAuthUser(req);
  if (!auth) return fail(res, 'Not authenticated.', 401);
  try {
    const { bio, statusMessage, avatarUrl, shareLocation, location } = req.body || {};
    if (bio !== undefined && bio.length > 280) return fail(res, 'Bio must be 280 characters or fewer.');
    if (statusMessage !== undefined && statusMessage.length > 100) return fail(res, 'Status message must be 100 characters or fewer.');

    const [current] = await sql`SELECT bio, status_message, avatar_url, share_location, last_location FROM users WHERE id = ${auth.sub}`;
    if (!current) return fail(res, 'User not found.', 404);

    const nextBio = bio !== undefined ? bio : current.bio;
    const nextStatus = statusMessage !== undefined ? statusMessage : current.status_message;
    const nextAvatar = avatarUrl !== undefined ? avatarUrl : current.avatar_url;
    const nextShare = shareLocation !== undefined ? !!shareLocation : current.share_location;
    let nextLocation = current.last_location;
    if (nextShare && location && typeof location.lat === 'number') {
      nextLocation = { lat: location.lat, lng: location.lng, updatedAt: new Date().toISOString() };
    } else if (!nextShare) { nextLocation = null; }

    await sql`UPDATE users SET bio = ${nextBio}, status_message = ${nextStatus}, avatar_url = ${nextAvatar}, share_location = ${nextShare}, last_location = ${nextLocation ? JSON.stringify(nextLocation) : null}, updated_at = NOW() WHERE id = ${auth.sub}`;
    return ok(res, { message: 'Profile updated.' });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- verify-email ----------
async function verifyEmail(req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  try {
    const { email, token } = req.body || {};
    if (!email || !token) return fail(res, 'Missing email or token.');
    const normalizedEmail = email.toLowerCase().trim();
    const tokenHash = hashToken(token);
    const [user] = await sql`SELECT id, is_verified FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
    if (!user) return fail(res, 'Invalid verification link.', 404);
    if (user.is_verified) return ok(res, { message: 'Your email is already verified. You can log in.' });
    const [record] = await sql`SELECT id, expires_at, used FROM auth_tokens WHERE user_id = ${user.id} AND token_hash = ${tokenHash} AND type = 'verify_email' ORDER BY created_at DESC LIMIT 1`;
    if (!record || record.used) return fail(res, 'Invalid or already-used verification link.', 400);
    if (new Date(record.expires_at) < new Date()) return fail(res, 'This link has expired. Please request a new one.', 400);
    await sql`UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE id = ${user.id}`;
    await sql`UPDATE auth_tokens SET used = TRUE WHERE id = ${record.id}`;
    return ok(res, { message: 'Email verified! You can now log in.' });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- forgot-password ----------
async function forgotPassword(req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const ip = getClientIp(req);
  const { success } = await checkRateLimit('auth', ip);
  if (!success) return fail(res, 'Too many requests. Please wait.', 429);
  const GENERIC = 'If an account with that email exists, a password reset link has been sent.';
  try {
    const { email } = req.body || {};
    if (!email) return fail(res, 'Email is required.');
    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await sql`SELECT id, username FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
    if (user) {
      const rawToken = generateRawToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await sql`INSERT INTO auth_tokens (user_id, token_hash, type, expires_at) VALUES (${user.id}, ${tokenHash}, 'reset_password', ${expiresAt.toISOString()})`;
      await sendPasswordResetEmail(normalizedEmail, user.username, rawToken);
    }
    return ok(res, { message: GENERIC });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- reset-password ----------
async function resetPassword(req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  try {
    const { email, token, newPassword } = req.body || {};
    if (!email || !token || !newPassword) return fail(res, 'Email, token, and new password are required.');
    if (newPassword.length < 8) return fail(res, 'Password must be at least 8 characters.');
    const normalizedEmail = email.toLowerCase().trim();
    const tokenHash = hashToken(token);
    const [user] = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
    if (!user) return fail(res, 'Invalid or expired reset link.', 400);
    const [record] = await sql`SELECT id, expires_at, used FROM auth_tokens WHERE user_id = ${user.id} AND token_hash = ${tokenHash} AND type = 'reset_password' ORDER BY created_at DESC LIMIT 1`;
    if (!record || record.used) return fail(res, 'Invalid or already-used reset link.', 400);
    if (new Date(record.expires_at) < new Date()) return fail(res, 'This reset link has expired.', 400);
    const passwordHash = await hashPassword(newPassword);
    await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = NOW() WHERE id = ${user.id}`;
    await sql`UPDATE auth_tokens SET used = TRUE WHERE id = ${record.id}`;
    return ok(res, { message: 'Password updated. You can now log in.' });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- resend-verification ----------
async function resendVerification(req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const ip = getClientIp(req);
  const { success } = await checkRateLimit('auth', ip);
  if (!success) return fail(res, 'Too many requests. Please wait.', 429);
  try {
    const { email } = req.body || {};
    if (!email) return fail(res, 'Email is required.');
    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await sql`SELECT id, username, is_verified FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
    if (user && !user.is_verified) {
      const rawToken = generateRawToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await sql`INSERT INTO auth_tokens (user_id, token_hash, type, expires_at) VALUES (${user.id}, ${tokenHash}, 'verify_email', ${expiresAt.toISOString()})`;
      await sendVerificationEmail(normalizedEmail, user.username, rawToken);
    }
    return ok(res, { message: 'If that account exists and is unverified, a new verification email has been sent.' });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}
