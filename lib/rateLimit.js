// lib/rateLimit.js
// ============================================================
// Rate limiting using Upstash Redis (REST-based, works great
// with serverless functions — no persistent connections needed).
// ============================================================

const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');

let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// Different limiters for different risk levels.
const limiters = redis
  ? {
      // Auth endpoints: strict, prevents brute force / spam signups
      auth: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'rl:auth' }),
      // Messaging: generous but bounded, prevents flooding
      message: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '10 s'), prefix: 'rl:msg' }),
      // General API: loose ceiling for everything else
      general: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m'), prefix: 'rl:gen' }),
    }
  : null;

/**
 * Check rate limit for a given key (usually IP or userId).
 * Returns { success: boolean, remaining: number }.
 * If Redis isn't configured, fails OPEN (allows request) so local
 * dev doesn't break — but logs a warning so it's not missed in prod.
 */
async function checkRateLimit(type, identifier) {
  if (!limiters) {
    console.warn('[rateLimit] Upstash not configured — rate limiting is DISABLED.');
    return { success: true, remaining: 999 };
  }
  const limiter = limiters[type] || limiters.general;
  const result = await limiter.limit(identifier);
  return { success: result.success, remaining: result.remaining };
}

/** Get the best-effort client IP from a Vercel request. */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = { checkRateLimit, getClientIp };
