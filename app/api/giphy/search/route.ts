/**
 * Server-side Giphy proxy.
 *
 * Replaces direct client-side Giphy calls (which previously shipped the API
 * key in the mobile bundle). The mobile client now hits this endpoint with a
 * Bearer/session credential and gets back a normalized payload.
 *
 *   GET /api/giphy/search?q=<query>
 *   GET /api/giphy/search          → trending
 *
 * Response:
 *   { gifs: [{ id, url, preview }] }
 *
 * Requires:
 *   - authenticated session (NextAuth web or mobile Bearer)
 *   - GIPHY_API_KEY env var
 *
 * Rate limited via the 'message' preset (30/min per user). Browsing GIFs is
 * a conversational activity, so a chat-style limit is appropriate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const LIMIT = 20;
const RATING = 'g';

interface GiphyApiItem {
  id: string;
  images?: {
    fixed_height?:       { url?: string };
    fixed_height_small?: { url?: string };
  };
}

export async function GET(req: NextRequest) {
  // Auth — accept either NextAuth web session or signed mobile Bearer.
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  const rl = await checkRateLimit('message', `giphy:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  // Server-side key. If unset, fail closed — better than leaking a stack trace
  // or silently calling the unauthenticated Giphy endpoint.
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    console.error('[giphy] GIPHY_API_KEY not configured');
    return NextResponse.json({ error: 'GIF search is not configured' }, { status: 503 });
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const url = q
    ? `${GIPHY_BASE}/search?api_key=${apiKey}&q=${encodeURIComponent(q)}&limit=${LIMIT}&rating=${RATING}`
    : `${GIPHY_BASE}/trending?api_key=${apiKey}&limit=${LIMIT}&rating=${RATING}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    console.error('[giphy] upstream fetch failed:', err);
    return NextResponse.json({ error: 'GIF search temporarily unavailable' }, { status: 502 });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    console.error('[giphy] upstream HTTP', upstream.status, text.slice(0, 200));
    return NextResponse.json({ error: 'GIF search temporarily unavailable' }, { status: 502 });
  }

  let body: { data?: GiphyApiItem[] };
  try {
    body = await upstream.json();
  } catch {
    return NextResponse.json({ error: 'GIF search returned malformed data' }, { status: 502 });
  }

  const gifs = (body.data ?? [])
    .map(item => {
      const url     = item.images?.fixed_height?.url ?? '';
      const preview = item.images?.fixed_height_small?.url ?? url;
      return { id: item.id, url, preview };
    })
    .filter(g => g.url);

  // Edge-cacheable for 5 min — trending and popular search terms are repeated
  // by every user in every league. Per-user keys make this a noop unless we
  // strip auth from the cache key, which is fine because the response carries
  // no user-specific data.
  return NextResponse.json(
    { gifs },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    },
  );
}
