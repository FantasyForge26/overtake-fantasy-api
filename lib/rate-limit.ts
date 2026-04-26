/**
 * Rate limiting for auth endpoints.
 *
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * are set (production). Falls back to an in-memory Map when those vars are
 * absent (local dev / single-instance hobby deployments).
 *
 * LIMITATION: The in-memory fallback does NOT share state across Vercel
 * function instances. On a multi-instance deployment it provides weaker
 * guarantees — use Upstash Redis in production.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// 5 requests per 15 minutes per key
const REQUESTS = 5;
const WINDOW   = '15 m';
const WINDOW_MS = 15 * 60 * 1000;

// ── Upstash Redis limiter (production) ──────────────────────────────────────

let upstashLimiter: Ratelimit | null = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  upstashLimiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(REQUESTS, WINDOW),
    prefix: 'otf:rl',
  });
}

// ── In-memory fallback limiter ───────────────────────────────────────────────

interface MemBucket { count: number; resetAt: number }
const memStore = new Map<string, MemBucket>();

function memCheck(key: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  let bucket = memStore.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    memStore.set(key, bucket);
  }

  bucket.count++;
  const allowed   = bucket.count <= REQUESTS;
  const remaining = Math.max(0, REQUESTS - bucket.count);
  return { allowed, remaining };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns { allowed: boolean }.
 * Pass the client IP (or any stable identifier) as `key`.
 */
export async function checkRateLimit(key: string): Promise<{ allowed: boolean }> {
  if (upstashLimiter) {
    const result = await upstashLimiter.limit(key);
    return { allowed: result.success };
  }

  const result = memCheck(key);
  return { allowed: result.allowed };
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
