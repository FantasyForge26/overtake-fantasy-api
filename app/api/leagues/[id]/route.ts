import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster, DraftSession, SeasonStanding, User } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  await connectDB();

  const league = await League.findById(id);
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  const memberIds = league.memberIds.map((m: any) => m.toString());
  if (!memberIds.includes(userId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json(league);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  await connectDB();

  const league = await League.findById(id);
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  if (league.commissionerId.toString() !== userId) {
    return NextResponse.json({ error: 'Only the commissioner can update league settings' }, { status: 403 });
  }

  const { maxManagers, isPublic, draftMode, pickTimerSeconds, slowDraftPickHours, pauseStart, pauseEnd } = await req.json();

  if (maxManagers !== undefined)       league.maxManagers = maxManagers;
  if (isPublic !== undefined)          league.isPublic = isPublic;
  if (draftMode !== undefined)         league.draftMode = draftMode;
  if (pickTimerSeconds !== undefined)  league.pickTimerSeconds = pickTimerSeconds;
  if (slowDraftPickHours !== undefined) league.slowDraftPickHours = slowDraftPickHours;
  if (pauseStart !== undefined)        league.pauseStart = pauseStart;
  if (pauseEnd !== undefined)          league.pauseEnd = pauseEnd;

  await league.save();

  return NextResponse.json(league);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  await connectDB();

  const league = await League.findById(id);
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  if (league.commissionerId.toString() !== userId) {
    return NextResponse.json({ error: 'Only the commissioner can delete this league' }, { status: 403 });
  }

  await Promise.all([
    League.deleteOne({ _id: id }),
    Roster.deleteMany({ leagueId: id }),
    DraftSession.deleteMany({ leagueId: id }),
    SeasonStanding.deleteMany({ leagueId: id }),
    User.updateMany({ leagueIds: id }, { $pull: { leagueIds: id } }),
  ]);

  return NextResponse.json({ success: true });
}
