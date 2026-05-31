import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Notification } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;

  // 'write' preset (60/min per user). mark-read fires on every app-foreground
  // event (throttled to 30s on the mobile side), so legitimate cadence is
  // well under this. Self-targeting (updateMany filters by userId from the
  // session) so abuse is already bounded — limit is defense in depth.
  const rl = await checkRateLimit('write', `mark-read:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { notificationIds } = await req.json().catch(() => ({}));

  await connectDB();

  const filter: any = { userId };
  if (notificationIds?.length) {
    filter._id = { $in: notificationIds };
  }

  const result = await Notification.updateMany(filter, { $set: { read: true } });

  return NextResponse.json({ updated: result.modifiedCount });
}
