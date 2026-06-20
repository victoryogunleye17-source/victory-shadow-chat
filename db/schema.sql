-- ============================================================
-- SHADOW CHAT — Database Schema (Postgres / Neon / Vercel Postgres)
-- ============================================================
-- Run this once against your Neon/Vercel Postgres database.
-- Uses gen_random_uuid() — available by default on Neon & Vercel Postgres.

-- ---------- USERS ----------
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        VARCHAR(32) UNIQUE NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  avatar_url      TEXT DEFAULT NULL,
  bio             VARCHAR(280) DEFAULT '',
  status_message  VARCHAR(100) DEFAULT '',
  role            VARCHAR(20) NOT NULL DEFAULT 'user',     -- 'user' | 'admin' | 'owner'
  is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
  is_suspended    BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_until TIMESTAMPTZ DEFAULT NULL,
  ban_reason      TEXT DEFAULT NULL,
  share_location  BOOLEAN NOT NULL DEFAULT FALSE,           -- opt-in only
  last_location   JSONB DEFAULT NULL,                       -- {lat, lng, updatedAt} - only if share_location = true
  is_online       BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ---------- EMAIL VERIFICATION / PASSWORD RESET TOKENS ----------
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  type        VARCHAR(20) NOT NULL,        -- 'verify_email' | 'reset_password'
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

-- ---------- CONVERSATIONS (1:1) ----------
CREATE TABLE IF NOT EXISTS conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_a_id, user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_users ON conversations(user_a_id, user_b_id);

-- ---------- MESSAGES ----------
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT DEFAULT '',
  attachment_url  TEXT DEFAULT NULL,
  attachment_type VARCHAR(20) DEFAULT NULL,   -- 'image' | 'file'
  attachment_name TEXT DEFAULT NULL,
  reply_to_id     UUID REFERENCES messages(id) ON DELETE SET NULL,  -- for swipe-to-reply / quoted replies
  reactions       JSONB DEFAULT '{}',          -- { "👍": ["userId1","userId2"] }
  is_edited       BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at    TIMESTAMPTZ DEFAULT NULL,
  read_at         TIMESTAMPTZ DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id);

-- ---------- BLOCKS ----------
CREATE TABLE IF NOT EXISTS blocks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (blocker_id, blocked_id)
);

-- ---------- REPORTS (user-initiated; admins only see reported content) ----------
CREATE TABLE IF NOT EXISTS reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  reason          VARCHAR(50) NOT NULL,   -- 'spam' | 'harassment' | 'threat' | 'csam' | 'other'
  details         TEXT DEFAULT '',
  message_snapshot TEXT DEFAULT NULL,     -- copy of reported message content, since original may be deleted/edited later
  status          VARCHAR(20) NOT NULL DEFAULT 'open',  -- 'open' | 'reviewing' | 'resolved' | 'dismissed'
  admin_notes     TEXT DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- ---------- LEGAL REQUESTS (law-enforcement / court-order workflow) ----------
-- This is the legitimate channel for sensitive-content access — NOT ad-hoc admin browsing.
CREATE TABLE IF NOT EXISTS legal_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by    TEXT NOT NULL,           -- agency / officer name
  case_reference  TEXT NOT NULL,
  legal_basis     TEXT NOT NULL,           -- e.g. "Court Order #..." / subpoena reference
  target_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  scope           TEXT NOT NULL,           -- description of what's being requested
  document_url    TEXT DEFAULT NULL,       -- uploaded court order / warrant
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending'|'approved'|'denied'|'fulfilled'
  handled_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ DEFAULT NULL
);

-- ---------- SECURITY / AUDIT LOGS ----------
CREATE TABLE IF NOT EXISTS security_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  VARCHAR(50) NOT NULL,   -- 'failed_login' | 'rate_limit_hit' | 'admin_action' | 'suspicious_pattern'
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address  VARCHAR(64) DEFAULT NULL,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_logs_type ON security_logs(event_type, created_at);

-- ---------- SEED: Ensure the founder account is recognized as owner ----------
-- This does not create a login (no password) — it only guarantees that IF/WHEN
-- victoryogunleye17@gmail.com registers, the application logic (see lib/auth.js)
-- elevates that exact email to role='owner' automatically on signup.
-- No separate action needed here; enforced in code, see api/auth/register.js
