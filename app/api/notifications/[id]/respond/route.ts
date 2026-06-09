/**
 * POST /api/notifications/[id]/respond
 *
 * Accept or decline an interactive notification. Currently only league_invite
 * notifications are interactive — others return 400.
 *
 * Body: { response: 'accept' | 'decline' }
 *
 * On accept (league_invite): the recipient is added to the league's
 * memberIds, a Roster is created for them, the notification is marked
 * actionTaken='accepted' and read=true.
 *
 * On decline: notification is marked actionTaken='declined' and read=true.
 * No side effects.
 *
 * The whole flow runs in a Mongoose transaction so a partial failure on
 * accept (e.g. league.save succeeds but Roster.create fails) rolls back
 * cleanly rather than leaving the user partially joined.
 */

import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { League, Notification, Roster } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rl = await checkRateLimit('write', `notification-respond:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { id: notificationId } = await params;
  if (!OBJECT_ID_RE.test(notificationId)) {
    return NextResponse.json({ error: 'Invalid notification id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const response = body.response;
  if (response !== 'accept' && response !== 'decline') {
    return NextResponse.json(
      { error: "response must be 'accept' or 'decline'" },
      { status: 400 },
    );
  }

  await connectDB();

  const notification = await Notification.findById(notificationId);
  if (!notification) {
    return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
  }
  if (notification.userId.toString() !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (notification.type !== 'league_invite') {
    return NextResponse.json(
      { error: 'This notification is not interactive' },
      { status: 400 },
    );
  }
  if (notification.actionTaken) {
    return NextResponse.json(
      { error: `Already ${notification.actionTaken}` },
      { status: 409 },
    );
  }

  // Decline path — fast, no transaction needed.
  if (response === 'decline') {
    notification.actionTaken = 'declined';
    notification.read = true;
    await notification.save();
    return NextResponse.json({ notification, joined: false });
  }

  // Accept path — wrap join in a transaction so we don't half-add the user.
  const leagueId = (notification.data as any)?.leagueId;
  if (!leagueId || typeof leagueId !== 'string') {
    return NextResponse.json(
      { error: 'Invite is missing league reference' },
      { status: 400 },
    );
  }

  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      const league = await League.findById(leagueId).session(dbSession);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');

      const memberIds = (league.memberIds as any[]).map(id => id.toString());
      if (memberIds.includes(userId)) {
        // Edge case: user joined via deeplink between invite and accept. Treat as success.
        notification.actionTaken = 'accepted';
        notification.read = true;
        await notification.save({ session: dbSession });
        return;
      }

      if (league.memberIds.length >= league.maxManagers) {
        throw new Error('LEAGUE_FULL');
      }
      if (!['setup', 'active'].includes(league.status)) {
        throw new Error('LEAGUE_CLOSED');
      }

      league.memberIds.push(userId as any);
      await league.save({ session: dbSession });

      await Roster.create([{
        leagueId: league._id,
        userId,
        season: league.season,
      }], { session: dbSession });

      notification.actionTaken = 'accepted';
      notification.read = true;
      await notification.save({ session: dbSession });
    });
  } catch (err: any) {
    console.error('[notifications/respond] accept transaction failed:', err?.message ?? err);
    const code = err?.message;
    if (code === 'LEAGUE_NOT_FOUND') {
      return NextResponse.json({ error: 'League no longer exists' }, { status: 404 });
    }
    if (code === 'LEAGUE_FULL') {
      return NextResponse.json({ error: 'League is full' }, { status: 400 });
    }
    if (code === 'LEAGUE_CLOSED') {
      return NextResponse.json({ error: 'League is no longer accepting new members' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Could not accept invite' }, { status: 500 });
  } finally {
    await dbSession.endSession();
  }

  return NextResponse.json({
    notification,
    joined: true,
    leagueId,
    leagueName: (notification.data as any)?.leagueName,
  });
}
