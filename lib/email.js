// lib/email.js
// ============================================================
// Email sending via Resend. Handles verification + password reset emails.
// ============================================================

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.EMAIL_FROM || 'Shadow Chat <noreply@example.com>';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function baseTemplate({ title, bodyHtml, ctaText, ctaUrl }) {
  return `
  <div style="background:#05060a;padding:40px 20px;font-family:Segoe UI,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#0b0e16;border:1px solid #1c2333;border-radius:16px;padding:32px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="font-size:22px;font-weight:700;color:#3fa9ff;letter-spacing:1px;">SHADOW CHAT</span>
      </div>
      <h2 style="color:#fff;font-size:20px;margin:0 0 12px;">${title}</h2>
      <p style="color:#9aa5b8;font-size:14px;line-height:1.6;margin:0 0 24px;">${bodyHtml}</p>
      ${
        ctaUrl
          ? `<div style="text-align:center;margin:24px 0;">
              <a href="${ctaUrl}" style="background:#3fa9ff;color:#05060a;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:14px;display:inline-block;">${ctaText}</a>
            </div>
            <p style="color:#4d5870;font-size:12px;word-break:break-all;">${ctaUrl}</p>`
          : ''
      }
      <p style="color:#4d5870;font-size:12px;margin-top:32px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  </div>`;
}

async function sendVerificationEmail(toEmail, username, rawToken) {
  const url = `${APP_URL}/verify.html?token=${rawToken}&email=${encodeURIComponent(toEmail)}`;
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping send. Verify URL:', url);
    return { skipped: true, url };
  }
  return resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: 'Verify your Shadow Chat account',
    html: baseTemplate({
      title: `Welcome, ${username} 👋`,
      bodyHtml: 'Confirm your email address to activate your Shadow Chat account. This link expires in 24 hours.',
      ctaText: 'Verify Email',
      ctaUrl: url,
    }),
  });
}

async function sendPasswordResetEmail(toEmail, username, rawToken) {
  const url = `${APP_URL}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(toEmail)}`;
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping send. Reset URL:', url);
    return { skipped: true, url };
  }
  return resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: 'Reset your Shadow Chat password',
    html: baseTemplate({
      title: `Hi ${username}, reset your password`,
      bodyHtml: 'We received a request to reset your password. This link expires in 1 hour. If this wasn\'t you, secure your account.',
      ctaText: 'Reset Password',
      ctaUrl: url,
    }),
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
