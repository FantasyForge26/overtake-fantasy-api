import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster } from '@/lib/models';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { inviteCode } = await req.json();

  await connectDB();

  const league = await League.findOne({
    inviteCode: { $regex: new RegExp(`^${inviteCode}$`, 'i') },
  });

  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  const memberIds = league.memberIds.map((id: any) => id.toString());

  if (memberIds.includes(userId)) {
    return NextResponse.json({ error: 'Already a member of this league' }, { status: 400 });
  }

  if (league.memberIds.length >= league.maxManagers) {
    return NextResponse.json({ error: 'League is full' }, { status: 400 });
  }

  if (!['setup', 'active'].includes(league.status)) {
    return NextResponse.json({ error: 'League is not accepting new members' }, { status: 400 });
  }

  league.memberIds.push(userId);
  await league.save();

  await Roster.create({
    leagueId: league._id,
    userId,
    season: league.season,
  });

  return NextResponse.json(league);
}
