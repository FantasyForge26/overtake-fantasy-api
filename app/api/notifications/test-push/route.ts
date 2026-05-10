/**
 * /api/notifications/test-push
 *
 * Sends a test push notification to the authenticated user. Useful for
 * verifying end-to-end push delivery after deploys or device changes.
 *
 * The push fires through the same sendPushToUser pipeline as production
 * notifications, so the resulting Notification doc populates pushSentAt and
 * pushTickets[] just like a real one. Inspect via /api/notifications/push-status
 * or scripts/check-push-status.ts.
 *
 *   POST /api/notifications/test-push
 *   → returns the saved Notification (with pushTickets) once Expo has responded
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Notification, PushToken } from '@/lib/models';
import { sendPushToUser } from '@/lib/push';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;

  await connectDB();

  const tokens = await PushToken.find({ userId }).lean() as any[];
  if (tokens.length === 0) {
    return NextResponse.json({
      error: 'No push tokens registered for this user',
      hint:  'Open the app on a device that has notifications permission enabled',
    }, { status: 400 });
  }

  const stamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  await sendPushToUser(
    userId,
    'Push test 🧪',
    `Sent at ${stamp}. If you got this on your phone, end-to-end delivery works.`,
    { screen: 'home', test: true },
    'general',
  );

  // Find the just-created notification so we can return its tickets
  const created = await Notification.findOne({ userId, type: 'general', title: 'Push test 🧪' })
    .sort({ createdAt: -1 })
    .lean() as any;

  return NextResponse.json({
    success:    true,
    tokenCount: tokens.length,
    notification: created,
  });
}
