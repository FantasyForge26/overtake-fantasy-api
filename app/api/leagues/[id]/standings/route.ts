import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster, User } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;

  await connectDB();

  const rosters = await Roster.find({ leagueId }).lean() as any[];

  const standings = await Promise.all(
    rosters.map(async (roster) => {
      const user = await User.findById(roster.userId).select('displayName avatarUrl').lean() as any;
      return {
        userId: roster.userId.toString(),
        displayName: user?.displayName ?? 'Unknown',
        avatarUrl: user?.avatarUrl ?? null,
        teamName: roster.teamName,
        totalPoints: roster.totalPoints ?? 0,
        seasonRank: roster.seasonRank ?? 0,
      };
    })
  );

  standings.sort((a, b) => b.totalPoints - a.totalPoints);

  return NextResponse.json(standings);
}
