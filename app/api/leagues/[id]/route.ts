import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import mongoose from 'mongoose';
import { League, Roster, DraftSession, SeasonStanding, User, Transaction } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

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

  // 'write' preset (60/min per user). Commissioner-only at the route, so
  // limit is defense in depth.
  const rl = await checkRateLimit('write', `league-update:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

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

  // 'auth' preset (5/15min per user). League delete is destructive and
  // irreversible — wipes rosters, draft sessions, standings. Tighter limit
  // here forces a backoff if a script tries to mass-delete.
  const rl = await checkRateLimit('auth', `league-delete:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { id } = await params;

  await connectDB();

  const league = await League.findById(id);
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  if (league.commissionerId.toString() !== userId) {
    return NextResponse.json({ error: 'Only the commissioner can delete this league' }, { status: 403 });
  }

  // M8: Atomic delete. The previous Promise.all could leave the DB in a
  // corrupted half-deleted state if any one operation failed — League gone
  // but Rosters/DraftSession/SeasonStanding orphaned, or User.leagueIds still
  // pointing at a deleted league. session.withTransaction rolls everything
  // back atomically on any failure, mirroring the H7 pattern.
  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      await Promise.all([
        League.deleteOne({ _id: id }, { session: dbSession }),
        Roster.deleteMany({ leagueId: id }, { session: dbSession }),
        DraftSession.deleteMany({ leagueId: id }, { session: dbSession }),
        SeasonStanding.deleteMany({ leagueId: id }, { session: dbSession }),
        User.updateMany(
          { leagueIds: id },
          { $pull: { leagueIds: id } },
          { session: dbSession },
        ),
      ]);
    });
  } catch (err) {
    console.error('[league/delete] transaction failed:', err);
    return NextResponse.json({ error: 'Delete failed. League state unchanged.' }, { status: 500 });
  } finally {
    await dbSession.endSession();
  }

  return NextResponse.json({ success: true });
}
