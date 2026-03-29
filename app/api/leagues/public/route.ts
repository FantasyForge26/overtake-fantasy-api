import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const leagues = await League.aggregate([
    {
      $match: {
        isPublic: true,
        status: 'setup',
        $expr: { $lt: [{ $size: '$memberIds' }, '$maxManagers'] },
      },
    },
    {
      $project: {
        name: 1,
        format: 1,
        memberCount: { $size: '$memberIds' },
        maxManagers: 1,
        season: 1,
        inviteCode: 1,
      },
    },
  ]);

  return NextResponse.json(leagues);
}
