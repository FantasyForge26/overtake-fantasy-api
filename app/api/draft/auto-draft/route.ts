import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { DraftSession, League } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  try {
    const session = await getMobileSession(req);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { leagueId, enabled, targetUserId } = await req.json();

    if (targetUserId && targetUserId !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const userId = session.user.id;

    // 'write' preset (60/min per user).
    const rl = await checkRateLimit('write', `auto-draft:${userId}`);
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

    await connectDB();

    // M6: League membership check. Without this, a non-member could POST any
    // leagueId and pollute that draft's autoDraftUserIds array. Auto-pick
    // cron iterates draftOrder so a non-member's entry is functionally inert,
    // but it's still bad hygiene and could leak that the league exists.
    const league = await League.findById(leagueId).select('memberIds').lean() as any;
    if (!league) return NextResponse.json({ error: 'League not found' }, { status: 404 });
    const isMember = (league.memberIds as any[]).some(id => id.toString() === userId);
    if (!isMember) {
      return NextResponse.json({ error: 'Only league members can set auto-draft' }, { status: 403 });
    }

    const draftSession = await DraftSession.findOne({ leagueId, status: 'active' });
    if (!draftSession) return NextResponse.json({ error: 'No active draft' }, { status: 404 });

    if (!draftSession.autoDraftUserIds) draftSession.autoDraftUserIds = [];

    if (enabled) {
      if (!draftSession.autoDraftUserIds.includes(userId)) {
        draftSession.autoDraftUserIds.push(userId);
      }
    } else {
      draftSession.autoDraftUserIds = draftSession.autoDraftUserIds.filter((id: string) => id !== userId);
    }

    await draftSession.save();
    return NextResponse.json({ autoDraftUserIds: draftSession.autoDraftUserIds });
  } catch (err: any) {
    console.error('[auto-draft] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
