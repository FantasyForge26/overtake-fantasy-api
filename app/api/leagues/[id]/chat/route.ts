import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { ChatMessage, Roster, User, League } from '@/lib/models';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { sendPushToUser } from '@/lib/push';

type Params = { params: Promise<{ id: string }> };

function serializeMessage(doc: any) {
  const reactions: Record<string, string[]> = {};
  if (doc.reactions instanceof Map) {
    for (const [emoji, users] of doc.reactions.entries()) {
      reactions[emoji] = users;
    }
  } else if (doc.reactions && typeof doc.reactions === 'object') {
    for (const [emoji, users] of Object.entries(doc.reactions)) {
      reactions[emoji] = users as string[];
    }
  }
  return {
    _id:          doc._id,
    leagueId:     doc.leagueId,
    userId:       doc.userId,
    userName:     doc.userName,
    userInitials: doc.userInitials,
    message:      doc.message,
    type:         doc.type,
    assetId:      doc.assetId,
    assetName:    doc.assetName,
    assetOtf:     doc.assetOtf,
    gifUrl:       doc.gifUrl,
    reactions,
    createdAt:    doc.createdAt,
  };
}

// GET — fetch all messages for the league
export async function GET(req: NextRequest, { params }: Params) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const messages = await ChatMessage.find({ leagueId }).sort({ createdAt: 1 }).lean();
  return NextResponse.json(messages.map(serializeMessage));
}

// POST — send a new message
export async function POST(req: NextRequest, { params }: Params) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const body = await req.json();
  const { message, type = 'text', assetId, assetName, assetOtf, gifUrl } = body;

  if (!message && type === 'text') return NextResponse.json({ error: 'message is required' }, { status: 400 });
  if (!gifUrl && type === 'gif') return NextResponse.json({ error: 'gifUrl is required for gif type' }, { status: 400 });

  const user = session.user as any;
  const userId = user.id ?? user._id ?? user.sub ?? '';
  const userName = user.name ?? user.displayName ?? user.email ?? 'User';
  const userInitials = userName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const doc = await ChatMessage.create({
    leagueId,
    userId,
    userName,
    userInitials,
    message: message ?? '',
    type,
    assetId,
    assetName,
    assetOtf,
    gifUrl,
    reactions: {},
  });

  // Fire-and-forget push notifications to other league members based on their
  // chatNotifications preference. Mentioned users get the push even if their
  // preference is 'mentions' only.
  notifyLeagueChat(leagueId, userId, userName, message ?? '', type, gifUrl).catch(err =>
    console.error('[chat] notification dispatch failed:', err),
  );

  return NextResponse.json(serializeMessage(doc), { status: 201 });
}

async function notifyLeagueChat(
  leagueId: string,
  senderUserId: string,
  senderName: string,
  message: string,
  type: string,
  gifUrl?: string,
) {
  // Load all rosters in this league with their chatNotifications preference
  const rosters = await Roster.find({ leagueId, season: 2026 })
    .select('userId chatNotifications')
    .lean() as any[];

  if (rosters.length === 0) return;

  // Resolve display names for mention detection
  const memberUserIds = rosters.map(r => r.userId);
  const users = await User.find({ _id: { $in: memberUserIds } })
    .select('displayName')
    .lean() as any[];
  const userMap = new Map<string, string>(
    users.map(u => [u._id.toString(), u.displayName ?? '']),
  );

  // Detect @-mentions in the message body. Match display name case-insensitively.
  // Falls back to no mentions if message is empty (GIF / asset card).
  const mentionedUserIds = new Set<string>();
  const lowerMsg = (message ?? '').toLowerCase();
  if (lowerMsg.length > 0) {
    for (const r of rosters) {
      const uid = r.userId.toString();
      if (uid === senderUserId) continue;
      const displayName = userMap.get(uid);
      if (!displayName) continue;
      const escaped = displayName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`@${escaped}(?:\\b|$)`, 'i');
      if (pattern.test(lowerMsg)) mentionedUserIds.add(uid);
    }
  }

  // Fetch league name for push title
  const league = await League.findById(leagueId).select('name').lean() as any;
  const leagueName = league?.name ?? 'League chat';

  // Body preview — first 80 chars or asset card / gif placeholder
  let preview = '';
  if (type === 'gif')        preview = '🎬 sent a GIF';
  else if (type === 'asset') preview = '📇 shared an asset';
  else                       preview = (message ?? '').slice(0, 80);

  // Dispatch
  for (const r of rosters) {
    const targetId = r.userId.toString();
    if (targetId === senderUserId) continue;
    const pref = r.chatNotifications ?? 'mentions';
    if (pref === 'off') continue;
    const isMentioned = mentionedUserIds.has(targetId);
    if (pref === 'mentions' && !isMentioned) continue;

    const title = isMentioned
      ? `${senderName} mentioned you in ${leagueName}`
      : `${senderName} in ${leagueName}`;

    sendPushToUser(
      targetId,
      title,
      preview || ' ',
      { screen: 'chat', leagueId },
      'general',
    ).catch(() => {});
  }
}

// PATCH — add or remove a reaction
export async function PATCH(req: NextRequest, { params }: Params) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const { messageId, emoji } = await req.json();
  if (!messageId || !emoji) return NextResponse.json({ error: 'messageId and emoji required' }, { status: 400 });

  const user = session.user as any;
  const userId = user.id ?? user._id ?? user.sub ?? '';

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const msg = await ChatMessage.findOne({ _id: messageId, leagueId });
  if (!msg) return NextResponse.json({ error: 'Message not found' }, { status: 404 });

  const users: string[] = msg.reactions.get(emoji) ?? [];
  const idx = users.indexOf(userId);
  if (idx >= 0) {
    users.splice(idx, 1);
  } else {
    users.push(userId);
  }
  msg.reactions.set(emoji, users);
  await msg.save();

  return NextResponse.json(serializeMessage(msg));
}
