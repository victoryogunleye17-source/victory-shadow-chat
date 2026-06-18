// lib/db.js
// ============================================================
// Neon Postgres connection helper.
// Using the serverless driver — works over HTTP, perfect for
// Vercel serverless functions (no connection pool exhaustion).
// ============================================================

const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL is not set. Add it in your environment variables.');
}

// `sql` is a tagged-template query function: sql`SELECT * FROM users WHERE id = ${id}`
const sql = neon(process.env.DATABASE_URL);

module.exports = { sql };
