/**
 * POST /api/leagues/[id]/invite
 *
 * Send an in-app invite to a specific user. Creates a Notification with
 * type=league_invite that the recipient can Accept or Decline.
 *
 * Body: { targetUserId: string }
 *
 * Constraints:
 *   - Only the league commissioner can invite (members share the deeplink instead)
 *   - Target user must exist
 *   - Target user must not already be a member
 *   - League must not be full
 *   - League status must be 'setup' or 'active'
 *   - Duplicate pending invites are coalesced — existing invite is returned
 *     instead of creating a second one
 *
 * Side effects: also sends a push notification ("Ross invited you to Beta Testers").
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { League, Notification, User } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { sendPushToUser } from '@/lib/push';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const inviterId = (session.user as any).id as string;
  if (!inviterId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 'write' preset (60/min per user) — fine for normal use, prevents spam
  // notifications. Recipient's notification panel can't be weaponized this way.
  const rl = await checkRateLimit('write', `league-invite:${inviterId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { id: leagueId } = await params;
  const body = await req.json().catch(() => ({}));
  const targetUserId = body.targetUserId;

  if (typeof targetUserId !== 'string' || !OBJECT_ID_RE.test(targetUserId)) {
    return NextResponse.json({ error: 'Invalid targetUserId' }, { status: 400 });
  }
  if (targetUserId === inviterId) {
    return NextResponse.json({ error: "Can't invite yourself" }, { status: 400 });
  }

  await connectDB();

  const league = await League.findById(leagueId).lean() as any;
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  if (league.commissionerId.toString() !== inviterId) {
    return NextResponse.json(
      { error: 'Only the commissioner can send invites. Share the invite link instead.' },
      { status: 403 },
    );
  }

  if (!['setup', 'active'].includes(league.status)) {
    return NextResponse.json({ error: 'League is not accepting new members' }, { status: 400 });
  }

  if (league.memberIds.length >= league.maxManagers) {
    return NextResponse.json({ error: 'League is full' }, { status: 400 });
  }

  const memberIds = (league.memberIds as any[]).map(id => id.toString());
  if (memberIds.includes(targetUserId)) {
    return NextResponse.json({ error: 'User is already a member' }, { status: 400 });
  }

  const targetUser = await User.findById(targetUserId).select('displayName').lean() as any;
  if (!targetUser) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const inviter = await User.findById(inviterId).select('displayName').lean() as any;
  const inviterName = inviter?.displayName ?? 'Someone';

  // Coalesce duplicates: if a pending invite already exists for this user +
  // league, return it instead of creating a second one.
  const existing = await Notification.findOne({
    userId: targetUserId,
    type: 'league_invite',
    'data.leagueId': leagueId,
    actionTaken: null,
  }).lean() as any;

  if (existing) {
    return NextResponse.json({ notification: existing, duplicate: true }, { status: 200 });
  }

  const notification = await Notification.create({
    userId: targetUserId,
    type: 'league_invite',
    title: `${inviterName} invited you to ${league.name}`,
    body: 'Tap to accept or decline.',
    read: false,
    data: {
      leagueId,
      leagueName:  league.name,
      inviterUserId: inviterId,
      inviterName,
    },
  });

  // Push notification — fire and forget. Tapping it deeplinks into the app
  // (handled by the mobile push handler) and surfaces the in-app card.
  sendPushToUser(
    targetUserId,
    `${inviterName} invited you to ${league.name}`,
    'Tap to accept or decline.',
    { screen: 'notifications', leagueId, notificationId: notification._id.toString() },
    'league_invite',
  ).catch(err => console.error('[league/invite] push dispatch failed:', err));

  return NextResponse.json({ notification }, { status: 201 });
}
