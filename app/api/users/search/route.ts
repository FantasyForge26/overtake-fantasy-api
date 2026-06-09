/**
 * GET /api/users/search?q=<query>
 *
 * Search users by displayName (case-insensitive prefix match preferred,
 * falls back to substring). Used by the in-app "Invite by Username" flow.
 *
 * - Requires authentication
 * - Minimum 2 characters to prevent enumeration of the full user table
 * - Rate-limited with the 'auth' preset (5/15min per user) — user search is
 *   sensitive enough to warrant a tight limit
 * - Returns max 10 results
 * - Excludes the requesting user from results
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const MAX_RESULTS = 10;
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 50;

export async function GET(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;

  const rl = await checkRateLimit('auth', `user-search:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < MIN_QUERY_LEN) {
    return NextResponse.json(
      { error: `Query must be at least ${MIN_QUERY_LEN} characters` },
      { status: 400 },
    );
  }
  if (q.length > MAX_QUERY_LEN) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 });
  }

  await connectDB();

  // Escape regex special chars in user input to prevent injection (same lesson
  // as C3 — never trust user input in a $regex query without escaping).
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const users = await User.find({
    _id: { $ne: userId },
    displayName: { $regex: escaped, $options: 'i' },
    isAI: { $ne: true },
  })
    .select('_id displayName avatarUrl')
    .limit(MAX_RESULTS)
    .lean() as any[];

  const results = users.map(u => ({
    userId:      u._id.toString(),
    displayName: u.displayName ?? 'Manager',
    avatarUrl:   u.avatarUrl ?? null,
  }));

  return NextResponse.json({ results });
}
