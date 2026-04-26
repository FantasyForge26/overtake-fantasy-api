import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { ChatMessage } from '@/lib/models';
import { verifyLeagueMembership } from '@/lib/auth-helpers';

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

  return NextResponse.json(serializeMessage(doc), { status: 201 });
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
