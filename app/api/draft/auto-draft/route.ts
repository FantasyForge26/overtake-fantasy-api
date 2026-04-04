import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { DraftSession } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function POST(req: NextRequest) {
  try {
    const session = await getMobileSession(req);
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const userId = session.user.id;
    const { leagueId, enabled } = await req.json();

    await connectDB();

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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
