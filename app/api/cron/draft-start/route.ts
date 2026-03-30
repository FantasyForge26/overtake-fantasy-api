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
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

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

  return NextResponse.json({ started });
}
