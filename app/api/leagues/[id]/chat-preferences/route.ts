/**
 * GET  /api/leagues/[id]/chat-preferences  — returns current user's chat notification setting
 * PATCH /api/leagues/[id]/chat-preferences  — updates it
 *
 * Body: { chatNotifications: 'all' | 'mentions' | 'off' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Roster } from '@/lib/models';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const VALID_PREFS = ['all', 'mentions', 'off'] as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;

  await connectDB();
  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const roster = await Roster.findOne({ leagueId, userId, season: 2026 })
    .select('chatNotifications')
    .lean() as any;

  return NextResponse.json({
    chatNotifications: roster?.chatNotifications ?? 'mentions',
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;

  // 'write' preset (60/min per user).
  const rl = await checkRateLimit('write', `chat-prefs:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const body = await req.json().catch(() => ({}));
  const { chatNotifications } = body as { chatNotifications?: string };

  if (!chatNotifications || !VALID_PREFS.includes(chatNotifications as any)) {
    return NextResponse.json({ error: `chatNotifications must be one of: ${VALID_PREFS.join(', ')}` }, { status: 400 });
  }

  await connectDB();
  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const roster = await Roster.findOneAndUpdate(
    { leagueId, userId, season: 2026 },
    { $set: { chatNotifications, updatedAt: new Date() } },
    { new: true },
  ).select('chatNotifications').lean() as any;

  if (!roster) return NextResponse.json({ error: 'Roster not found' }, { status: 404 });

  return NextResponse.json({ chatNotifications: roster.chatNotifications });
}
