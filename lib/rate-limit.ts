/**
 * Rate limiting for the public API.
 *
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * are set (production). Falls back to an in-memory Map when those vars are
 * absent (local dev / single-instance hobby deployments).
 *
 * LIMITATION: The in-memory fallback does NOT share state across Vercel
 * function instances. On a multi-instance deployment it provides weaker
 * guarantees — use Upstash Redis in production.
 *
 * Usage:
 *
 *   const ip = getClientIp(req);
 *   const { allowed, retryAfterSec } = await checkRateLimit('auth', `login:${ip}`);
 *   if (!allowed) return rateLimitedResponse(retryAfterSec);
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export type RateLimitPreset = 'auth' | 'expensive' | 'message' | 'write';

/**
 * Presets — tuned for Overtake Fantasy:
 *   auth      sign-in, register, token mint        — IP-keyed
 *   expensive Anthropic / Pollinations / uploads    — user-keyed
 *   message   chat send, reactions                  — user-keyed
 *   write     trades, bids, roster mutations        — user-keyed
 */
const PRESETS: Record<
  RateLimitPreset,
  { requests: number; window: `${number} ${'s' | 'm' | 'h'}`; windowMs: number }
> = {
  auth:      { requests: 5,  window: '15 m', windowMs: 15 * 60 * 1000 },
  expensive: { requests: 5,  window: '1 m',  windowMs: 60 * 1000 },
  message:   { requests: 30, window: '1 m',  windowMs: 60 * 1000 },
  write:     { requests: 60, window: '1 m',  windowMs: 60 * 1000 },
};

// ── Upstash Redis limiters (production) ─────────────────────────────────────
// One Ratelimit instance per preset because windows differ. Created lazily.

const upstashConfigured =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
const upstashRedis = upstashConfigured ? Redis.fromEnv() : null;

const upstashLimiters = new Map<RateLimitPreset, Ratelimit>();
function getUpstashLimiter(preset: RateLimitPreset): Ratelimit | null {
  if (!upstashRedis) return null;
  const existing = upstashLimiters.get(preset);
  if (existing) return existing;
  const cfg = PRESETS[preset];
  const created = new Ratelimit({
    redis: upstashRedis,
    limiter: Ratelimit.slidingWindow(cfg.requests, cfg.window),
    prefix: `otf:rl:${preset}`,
  });
  upstashLimiters.set(preset, created);
  return created;
}

// ── In-memory fallback ──────────────────────────────────────────────────────
// Bucket keyed by `${preset}:${key}` so presets don't collide.

interface MemBucket { count: number; resetAt: number }
const memStore = new Map<string, MemBucket>();

function memCheck(preset: RateLimitPreset, key: string): { allowed: boolean } {
  const cfg = PRESETS[preset];
  const now = Date.now();
  const k = `${preset}:${key}`;
  let bucket = memStore.get(k);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + cfg.windowMs };
    memStore.set(k, bucket);
  }
  bucket.count++;
  return { allowed: bucket.count <= cfg.requests };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * checkRateLimit(preset, key) — returns whether the request is allowed and
 * (when blocked) the Retry-After value in seconds.
 *
 * `key` should be a stable identifier: IP for auth, userId for everything
 * authenticated. Different presets are isolated, so the same userId can hold
 * separate budgets for chat and trades.
 */
export async function checkRateLimit(
  preset: RateLimitPreset,
  key: string,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const cfg = PRESETS[preset];
  const limiter = getUpstashLimiter(preset);
  if (limiter) {
    const result = await limiter.limit(key);
    const retryAfterSec = result.success
      ? 0
      : Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
    return { allowed: result.success, retryAfterSec };
  }
  const { allowed } = memCheck(preset, key);
  return {
    allowed,
    retryAfterSec: allowed ? 0 : Math.ceil(cfg.windowMs / 1000),
  };
}

/**
 * Extracts the client IP from Next.js request headers.
 * x-forwarded-for is set by Vercel's edge; x-real-ip is a common fallback.
 */
export function getClientIp(req: Request): string {
  const headers = req.headers as unknown as { get(name: string): string | null };
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

/**
 * Standard 429 response with Retry-After header. Use after a failed
 * checkRateLimit so clients know when to back off.
 */
export function rateLimitedResponse(retryAfterSec: number): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests. Try again later.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
      },
    },
  );
}
