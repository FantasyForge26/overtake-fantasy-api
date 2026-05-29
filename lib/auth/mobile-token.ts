/**
 * mobile-token.ts
 *
 * Compact HMAC-SHA256 session token for the mobile client. Format:
 *   <base64url(JSON payload)>.<base64url(hmac signature)>
 *
 * Payload: { sub, email, iat, exp }
 *   - sub:   user._id as string
 *   - email: user email (cached for display, not used for auth)
 *   - iat:   issued-at (unix seconds)
 *   - exp:   expiry (unix seconds) — default 30 days
 *
 * Signed with NEXTAUTH_SECRET. Verified by recomputing the HMAC and checking
 * exp. No external deps required (uses node:crypto). Switch to a full JWT lib
 * later only if we need key rotation or RS256.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface MobileTokenPayload {
  sub:   string;
  email: string;
  iat:   number;
  exp:   number;
}

function getSecret(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  return Buffer.from(secret, 'utf8');
}

export function signMobileToken(userId: string, email: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: MobileTokenPayload = {
    sub:   userId,
    email,
    iat:   now,
    exp:   now + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export interface VerifyResult {
  valid:   boolean;
  payload: MobileTokenPayload | null;
  reason?: 'malformed' | 'bad_signature' | 'expired' | 'no_secret';
}

export function verifyMobileToken(token: string | null | undefined): VerifyResult {
  if (!token || typeof token !== 'string') {
    return { valid: false, payload: null, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, payload: null, reason: 'malformed' };
  }
  const [payloadB64, providedSig] = parts;

  let expectedSig: string;
  try {
    expectedSig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  } catch {
    return { valid: false, payload: null, reason: 'no_secret' };
  }

  // Constant-time comparison
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, payload: null, reason: 'bad_signature' };
  }

  let payload: MobileTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, payload: null, reason: 'malformed' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { valid: false, payload: null, reason: 'expired' };
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    return { valid: false, payload: null, reason: 'malformed' };
  }

  return { valid: true, payload };
}
