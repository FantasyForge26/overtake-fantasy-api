import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  
  const userId = (session.user as any).id as string;
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
}
