import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { ChatMessage, Roster, User, League } from '@/lib/models';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { sendPushToUser } from '@/lib/push';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

// ── Chat hardening constants (H3) ───────────────────────────────────────────
// Tuned to be invisible to legitimate users (4000 chars is ~600 words) while
// preventing DB stuffing, runaway notifyLeagueChat regex work, and reaction
// Map explosion.
const MAX_MESSAGE_LEN          = 4000;
const MAX_REACTION_EMOJI_LEN   = 16;   // single emoji + variation selectors
const MAX_REACTIONS_PER_MESSAGE = 24;  // distinct emoji types per message
const ALLOWED_TYPES = new Set(['text', 'asset', 'gif']);
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * Accepts giphy.com and any *.giphy.com subdomain (media.giphy.com,
 * media[0-4].giphy.com, i.giphy.com, etc.) over HTTPS only. Anything else —
 * arbitrary phishing host, http://, ftp://, javascript: — fails closed.
 */
function isValidGiphyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'giphy.com' || u.hostname.endsWith('.giphy.com');
  } catch {
    return false;
  }
}

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

  // Per-user message rate limit: 30 msgs/min. Stops chat flooding without
  // affecting normal conversation. Keyed on userId so one bad actor can't
  // affect the rest of the league.
  const rlUserId = (session.user as any).id as string;
  const { allowed, retryAfterSec } = await checkRateLimit('message', `chat:${rlUserId}`);
  if (!allowed) return rateLimitedResponse(retryAfterSec);

  const { id: leagueId } = await params;
  const body = await req.json().catch(() => ({}));
  const { message, type = 'text', assetId, assetName, assetOtf, gifUrl } = body;

  // ── Input validation (H3 hardening) ─────────────────────────────────────────
  if (!ALLOWED_TYPES.has(type)) {
    return NextResponse.json({ error: 'Invalid message type' }, { status: 400 });
  }
  if (message != null && typeof message !== 'string') {
    return NextResponse.json({ error: 'message must be a string' }, { status: 400 });
  }
  if (typeof message === 'string' && message.length > MAX_MESSAGE_LEN) {
    return NextResponse.json(
      { error: `Message exceeds ${MAX_MESSAGE_LEN} characters` },
      { status: 400 },
    );
  }
  if (!message && type === 'text') {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }
  if (type === 'gif') {
    if (typeof gifUrl !== 'string' || !isValidGiphyUrl(gifUrl)) {
      return NextResponse.json({ error: 'Invalid GIF url' }, { status: 400 });
    }
  }
  if (type === 'asset') {
    if (typeof assetId !== 'string' || !OBJECT_ID_RE.test(assetId)) {
      return NextResponse.json({ error: 'Invalid asset id' }, { status: 400 });
    }
    if (assetName != null && (typeof assetName !== 'string' || assetName.length > 120)) {
      return NextResponse.json({ error: 'Invalid asset name' }, { status: 400 });
    }
    if (assetOtf != null && (typeof assetOtf !== 'number' || !Number.isFinite(assetOtf))) {
      return NextResponse.json({ error: 'Invalid asset OTF' }, { status: 400 });
    }
  }

  const trimmedMessage = typeof message === 'string' ? message.trim() : '';

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
    message: trimmedMessage,
    type,
    assetId,
    assetName,
    assetOtf,
    gifUrl: type === 'gif' ? gifUrl : undefined,
    reactions: {},
  });

  // Fire-and-forget push notifications to other league members based on their
  // chatNotifications preference. Mentioned users get the push even if their
  // preference is 'mentions' only. Uses the post-validation trimmed message
  // so notifyLeagueChat sees the same body that was persisted.
  notifyLeagueChat(leagueId, userId, userName, trimmedMessage, type, gifUrl).catch(err =>
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

  const user = session.user as any;
  const userId = user.id ?? user._id ?? user.sub ?? '';

  // Reaction toggles share the 'message' preset (30/min per user). Tapping a
  // reaction is conversational, so a chat-style limit is right; this also
  // stops a script from spamming reactions to flood the Map.
  const rl = await checkRateLimit('message', `chat-react:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { id: leagueId } = await params;
  const body = await req.json().catch(() => ({}));
  const { messageId, emoji } = body;

  if (typeof messageId !== 'string' || !OBJECT_ID_RE.test(messageId)) {
    return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 });
  }
  if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > MAX_REACTION_EMOJI_LEN) {
    return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 });
  }

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const msg = await ChatMessage.findOne({ _id: messageId, leagueId });
  if (!msg) return NextResponse.json({ error: 'Message not found' }, { status: 404 });

  // Cap distinct reaction emojis per message. Adding a NEW emoji on an already
  // full message returns 400; toggling an existing emoji is always allowed.
  const reactionsMap: Map<string, string[]> = msg.reactions;
  const isNewEmoji = !reactionsMap.has(emoji);
  if (isNewEmoji && reactionsMap.size >= MAX_REACTIONS_PER_MESSAGE) {
    return NextResponse.json(
      { error: `Maximum ${MAX_REACTIONS_PER_MESSAGE} distinct reactions per message` },
      { status: 400 },
    );
  }

  const users: string[] = reactionsMap.get(emoji) ?? [];
  const idx = users.indexOf(userId);
  if (idx >= 0) {
    users.splice(idx, 1);
  } else {
    users.push(userId);
  }
  // Drop the emoji entirely if no users remain — keeps the Map tidy and
  // prevents accumulation of empty entries against MAX_REACTIONS_PER_MESSAGE.
  if (users.length === 0) {
    reactionsMap.delete(emoji);
  } else {
    reactionsMap.set(emoji, users);
  }
  await msg.save();

  return NextResponse.json(serializeMessage(msg));
}
