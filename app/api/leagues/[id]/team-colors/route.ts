import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  const { id: leagueId } = await params;

  const { searchParams } = new URL(req.url);
  const primary   = searchParams.get('primary')   ?? '';
  const secondary = searchParams.get('secondary') ?? '';
  const accent    = searchParams.get('accent')    ?? '';

  if (!primary || !secondary || !accent) {
    return NextResponse.json({ error: 'primary, secondary, and accent are required' }, { status: 400 });
  }

  await connectDB();

  // Check if any OTHER roster in this league has the exact same 3-color combination
  const conflict = await Roster.findOne({
    leagueId,
    userId: { $ne: userId },
    teamPrimaryColor:   primary,
    teamSecondaryColor: secondary,
    teamAccentColor:    accent,
  }).lean();

  return NextResponse.json({ taken: !!conflict });
}
