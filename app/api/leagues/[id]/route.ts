import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster, DraftSession, SeasonStanding, User, Transaction } from '@/lib/models';
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

  const {
    maxManagers, isPublic, draftMode, pickTimeLimitSeconds, slowDraftPickHours, pauseStart, pauseEnd,
    freeAgencyType, acquisitionType, ccStartingBalance, waiversClearDay, waiverHoldDays, minRacesHeld,
  } = await req.json();

  if (maxManagers !== undefined && ['active', 'completed'].includes(league.status)) {
    return NextResponse.json({ error: 'Cannot change league size mid-season' }, { status: 400 });
  }

  const changes: { note: string }[] = [];

  const track = <T>(field: string, current: T, next: T | undefined, label: string) => {
    if (next === undefined || next === current) return current;
    changes.push({ note: `${label} changed to ${next}` });
    return next;
  };

  league.maxManagers        = track('maxManagers',        league.maxManagers,        maxManagers,        'Max managers');
  league.isPublic           = track('isPublic',           league.isPublic,           isPublic,           'League visibility');
  league.draftMode          = track('draftMode',          league.draftMode,          draftMode,          'Draft mode');
  league.pickTimeLimitSeconds = track('pickTimeLimitSeconds', league.pickTimeLimitSeconds, pickTimeLimitSeconds, 'Pick time limit');
  league.slowDraftPickHours = track('slowDraftPickHours', league.slowDraftPickHours, slowDraftPickHours, 'Slow draft pick hours');
  league.pauseStart         = track('pauseStart',         league.pauseStart,         pauseStart,         'Pause start time');
  league.pauseEnd           = track('pauseEnd',           league.pauseEnd,           pauseEnd,           'Pause end time');
  league.freeAgencyType     = track('freeAgencyType',     league.freeAgencyType,     freeAgencyType,     'Free agency type');
  league.acquisitionType    = track('acquisitionType',    league.acquisitionType,    acquisitionType,    'Acquisition type');
  league.ccStartingBalance  = track('ccStartingBalance',  league.ccStartingBalance,  ccStartingBalance,  'CC starting balance');
  league.waiversClearDay    = track('waiversClearDay',    league.waiversClearDay,    waiversClearDay,    'Waivers clear day');
  league.waiverHoldDays     = track('waiverHoldDays',     league.waiverHoldDays,     waiverHoldDays,     'Waiver hold days');
  league.minRacesHeld       = track('minRacesHeld',       league.minRacesHeld,       minRacesHeld,       'Min races held');

  await league.save();

  if (changes.length > 0) {
    await Transaction.insertMany(
      changes.map(({ note }) => ({
        leagueId: id,
        userId,
        type: 'settings',
        note,
        createdAt: new Date(),
      })),
    );
  }

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
