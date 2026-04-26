import { Roster } from './models';

/**
 * Returns true if the given userId has a roster in the given league,
 * i.e. they are a member of that league.
 */
export async function verifyLeagueMembership(leagueId: string, userId: string): Promise<boolean> {
  const roster = await Roster.findOne({ leagueId, userId }).lean();
  return !!roster;
}
