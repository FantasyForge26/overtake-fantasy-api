import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { League, Asset, DraftSession, Roster } from '@/lib/models';

function buildSnakeDraftOrder(memberIds: string[], totalRounds: number): string[] {
  const order: string[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const roundOrder = round % 2 === 0 ? [...memberIds].reverse() : [...memberIds];
    order.push(...roundOrder);
  }
  return order;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret = process.env.CRON_SECRET;

  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await connectDB();
  } catch (e: any) {
    console.error('[cron] DB connection failed:', e.message);
    return NextResponse.json({ error: 'DB connection failed', message: e.message }, { status: 500 });
  }

  const now = new Date();
  const leagues = await League.find({
    status: 'setup',
    draftDateTime: { $exists: true, $lte: now },
  });

  if (leagues.length === 0) {
    return NextResponse.json({ started: [] });
  }

  const assets = await Asset.find({ season: 2026, confirmed: true }).select('_id');
  const availableAssetIds = assets.map((a: any) => a._id);

  const started: string[] = [];

  for (const league of leagues) {
    const memberIds = league.memberIds.map((id: any) => id.toString());
    const totalRounds = 6;
    const draftOrder = buildSnakeDraftOrder(memberIds, totalRounds);
    const totalPicks = draftOrder.length;

    await DraftSession.create({
      leagueId: league._id,
      season: 2026,
      status: 'pending',
      draftOrder,
      currentPickIndex: 0,
      currentRound: 1,
      totalRounds,
      totalPicks,
      availableAssetIds,
      picks: [],
      pickTimeLimitSeconds: 120,
      preDraftStartedAt: new Date(),
    });

    league.status = 'drafting';
    await league.save();

    const rosterDocs = memberIds.map((uid: string) => ({
      leagueId: league._id,
      userId: uid,
      season: 2026,
      teamName: 'My Team',
    }));
    try {
      await Roster.insertMany(rosterDocs, { ordered: false });
    } catch (e: any) {
      if (e.code !== 11000 && e?.writeErrors?.some((we: any) => we.code !== 11000)) {
        throw e;
      }
    }

    started.push(league._id.toString());
  }

  // Also activate any pending drafts whose pre-draft window has passed
  const pendingSessions = await DraftSession.find({ status: 'pending' });
  console.log('[cron] pending sessions found:', pendingSessions.length);
  for (const session of pendingSessions) {
    if (!session.preDraftStartedAt) {
      console.log('[cron] session has no preDraftStartedAt:', session._id);
      continue;
    }
    const elapsed = (Date.now() - new Date(session.preDraftStartedAt).getTime()) / 1000;
    console.log('[cron] session elapsed seconds:', elapsed, 'threshold: 10');
    if (elapsed >= 10) {
      console.log('[cron] activating session:', session._id);
      session.status = 'active';
      session.currentPickStartedAt = new Date();
      await session.save();
      started.push(`activated:${session.leagueId}`);
    }
  }

  return NextResponse.json({ started });
}
