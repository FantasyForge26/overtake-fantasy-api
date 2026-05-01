/**
 * POST /api/admin/recompute-totals
 *
 * Emergency rollback: undoes all sprint_quali_scored events for a given season
 * so they can be cleanly re-run via /api/cron/score-sprint-quali.
 *
 * Body: { "season": 2026 }
 *
 * Auth: x-admin-key header must match ADMIN_SECRET env var.
 *
 * Safe to call multiple times — if no ScoringLog entries exist for the season,
 * it returns immediately with roundsRolledBack: [].
 */

import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { recomputeTeamTotalsFromScratch } from '@/lib/scoring/recompute';

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-key') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const season = typeof body?.season === 'number' ? body.season : 2026;

  await connectDB();

  const result = await recomputeTeamTotalsFromScratch(season);

  return NextResponse.json({
    ok:               true,
    season:           result.season,
    roundsRolledBack: result.roundsRolledBack,
    rostersAdjusted:  result.rostersAdjusted,
    leaguesAffected:  result.leagueIds.length,
    message:          result.roundsRolledBack.length === 0
      ? 'Nothing to roll back — no sprint_quali_scored logs found for this season.'
      : `Rolled back sprint qualifying for rounds ${result.roundsRolledBack.join(', ')}. ` +
        `Adjusted ${result.rostersAdjusted} rosters across ${result.leagueIds.length} league(s). ` +
        `Re-run /api/cron/score-sprint-quali to re-score.`,
  });
}
