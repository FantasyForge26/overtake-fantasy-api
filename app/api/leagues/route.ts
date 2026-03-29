import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name, format, maxManagers } = await req.json();

  await connectDB();

  // Ensure invite code is unique
  let inviteCode: string;
  let attempts = 0;
  do {
    inviteCode = generateInviteCode();
    const existing = await League.findOne({ inviteCode });
    if (!existing) break;
    attempts++;
  } while (attempts < 10);

  const league = await League.create({
    name,
    format,
    maxManagers: maxManagers ?? 10,
    commissionerId: userId,
    memberIds: [userId],
    status: 'setup',
    season: 2026,
    inviteCode,
    scoring: {
      poleBonus: 10,
      raceFirstBonus: 25,
      sprintFirstBonus: 10,
      pitCrewFirstBonus: 25,
      powerUnitFirstBonus: 25,
      principalFirstBonus: 25,
    },
  });

  await Roster.create({
    leagueId: league._id,
    userId,
    season: 2026,
  });

  return NextResponse.json(league, { status: 201 });
}

export async function GET(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const leagues = await League.find({ memberIds: userId })
    .populate('commissionerId', 'displayName email');

  return NextResponse.json(leagues);
}
