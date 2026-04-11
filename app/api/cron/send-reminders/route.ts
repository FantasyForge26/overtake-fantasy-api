import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { DraftSession } from '@/lib/models';
import { sendPushToUser } from '@/lib/push';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret = process.env.CRON_SECRET;

  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const now = new Date();
  const activeSessions = await DraftSession.find({ status: 'active' });
  let reminded = 0;

  for (const session of activeSessions) {
    if (!session.currentPickStartedAt || !session.pickTimeLimitSeconds) continue;

    const reminderAt = new Date(
      new Date(session.currentPickStartedAt).getTime() +
      (session.pickTimeLimitSeconds - 45) * 1000,
    );

    // Only send if we've passed the reminder threshold
    if (now < reminderAt) continue;

    // Only send once per pick (reminderSentAt must be null or from a previous pick)
    if (
      session.reminderSentAt &&
      new Date(session.reminderSentAt) >= new Date(session.currentPickStartedAt)
    ) continue;

    const userId = session.draftOrder[session.currentPickIndex]?.toString();
    if (!userId) continue;

    await sendPushToUser(
      userId,
      '⏰ 45 seconds left!',
      'Pick now or auto-draft will choose for you.',
      { screen: 'draft', leagueId: session.leagueId.toString() },
      'draft_reminder',
    );

    session.reminderSentAt = now;
    await session.save();
    reminded++;
  }

  return NextResponse.json({ reminded });
}
