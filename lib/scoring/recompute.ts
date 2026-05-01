/**
 * recompute.ts — Sprint qualifying rollback helper
 *
 * recomputeTeamTotalsFromScratch(season) undoes all sprint_quali_scored
 * events for the given season by:
 *   1. Finding every non-dry-run ScoringLog entry for sprint_quali_scored
 *   2. Subtracting pointsAdded from each affected roster's totalPoints
 *   3. Clearing the sprintQualiScored flag on RaceCalendar (so it can be re-run)
 *   4. Re-ranking all rosters within their league
 *   5. Deleting the ScoringLog entries that were rolled back
 *
 * Assumes DB is already connected before calling.
 * Returns a report of what was rolled back.
 */

import { Roster, RaceCalendar, ScoringLog } from '@/lib/models';
import mongoose from 'mongoose';

export interface RecomputeResult {
  season:           number;
  roundsRolledBack: number[];
  rostersAdjusted:  number;
  leagueIds:        string[];
}

export async function recomputeTeamTotalsFromScratch(season: number): Promise<RecomputeResult> {
  // 1. Find all live (non-dry-run) sprint_quali_scored logs for this season
  const logs = await ScoringLog.find({
    event:  'sprint_quali_scored',
    season,
    dryRun: false,
  }).lean() as any[];

  if (!logs.length) {
    return { season, roundsRolledBack: [], rostersAdjusted: 0, leagueIds: [] };
  }

  const roundsRolledBack = [...new Set(logs.map((l: any) => l.round as number))].sort((a, b) => a - b);
  const affectedLeagueIds = new Set<string>();
  let rostersAdjusted = 0;

  // 2. Undo each log's team updates
  for (const log of logs) {
    const teamUpdates: Array<{ rosterId: any; pointsAdded: number }> = log.teamUpdates ?? [];

    for (const update of teamUpdates) {
      if (!update.rosterId || update.pointsAdded === 0) continue;

      const rosterId = update.rosterId.toString();
      const deduction = Math.round(update.pointsAdded * 100) / 100;

      const updated = await Roster.findByIdAndUpdate(
        rosterId,
        {
          $inc: { totalPoints: -deduction },
          $set: { updatedAt: new Date() },
        },
        { new: true },
      );

      if (updated) {
        affectedLeagueIds.add(updated.leagueId.toString());
        rostersAdjusted++;
      }
    }
  }

  // 3. Re-rank all affected leagues
  for (const leagueId of affectedLeagueIds) {
    const rosters = await Roster.find({ leagueId, season });
    const ranked  = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save();
    }
  }

  // 4. Clear sprintQualiScored flags on RaceCalendar for rolled-back rounds
  await RaceCalendar.updateMany(
    { season, round: { $in: roundsRolledBack } },
    {
      $set: {
        sprintQualiScored:    false,
        sprintQualiResults:   [],
      },
      $unset: { sprintQualiScoredAt: '' },
    },
  );

  // 5. Delete the rolled-back ScoringLog entries
  await ScoringLog.deleteMany({
    _id: { $in: logs.map((l: any) => l._id) },
  });

  return {
    season,
    roundsRolledBack,
    rostersAdjusted,
    leagueIds: [...affectedLeagueIds],
  };
}
