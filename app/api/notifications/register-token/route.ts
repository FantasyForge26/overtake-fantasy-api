import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { PushToken } from '@/lib/models';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  const { token, platform } = await req.json();

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  await connectDB();

  await PushToken.findOneAndUpdate(
    { token },
    { userId, token, platform, updatedAt: new Date() },
    { upsert: true, new: true },
  );

  return NextResponse.json({ ok: true });
}
