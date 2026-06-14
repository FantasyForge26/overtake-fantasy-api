import mongoose from 'mongoose';
import { Asset, DraftQueue, DraftSession, League, Roster } from './models';

export interface PickDoc {
  pickNumber: number;
  round: number;
  userId: string | mongoose.Types.ObjectId;
  assetId: mongoose.Types.ObjectId | string;
  assetType: string;
  pickedAt: Date;
}

/**
 * Returns the next asset type the drafter should pick, or null if their roster is full.
 * Uses fill-in-order priority by default (driver, driver, principal, pitCrew, pitCrew, powerUnit)
 * with a late-round override: when picks remaining <= unfilled slots, prioritize rarest slots
 * first (powerUnit > principal > pitCrew > driver) so users don't end up missing a category.
 */
export function nextNeededAssetType(
  roster: any,
  currentRound: number,
  totalRounds: number,
): string | null {
  const needed: string[] = [];
  if (!roster.driver1AssetId)   needed.push('driver');
  if (!roster.driver2AssetId)   needed.push('driver');
  if (!roster.principalAssetId) needed.push('principal');
  if (!roster.pitCrew1AssetId)  needed.push('pitCrew');
  if (!roster.pitCrew2AssetId)  needed.push('pitCrew');
  if (!roster.powerUnitAssetId) needed.push('powerUnit');

  if (needed.length === 0) return null;

  // Late-round rare-type override: only kick in once picks are STRICTLY fewer
  // than open slots (an impossible state in a balanced snake draft, so this is
  // effectively a safety net for hand-edited rosters). Previously this used <=
  // and triggered on round 1 of every fresh roster because picks === slots.
  const picksRemaining = totalRounds - currentRound + 1;
  if (picksRemaining < needed.length) {
    const priority = ['powerUnit', 'principal', 'pitCrew', 'driver'];
    for (const type of priority) {
      if (needed.includes(type)) return type;
    }
  }

  return needed[0];
}

/**
 * Returns the unique set of asset types the roster still needs. Used by the
 * auto-pick code paths to query "highest OTF across all open slot types"
 * instead of being locked into one type at a time.
 */
export function neededAssetTypes(roster: any): string[] {
  const needed = new Set<string>();
  if (!roster.driver1AssetId   || !roster.driver2AssetId)   needed.add('driver');
  if (!roster.principalAssetId)                              needed.add('principal');
  if (!roster.pitCrew1AssetId  || !roster.pitCrew2AssetId)  needed.add('pitCrew');
  if (!roster.powerUnitAssetId)                              needed.add('powerUnit');
  return Array.from(needed);
}

/**
 * Returns true if the roster has an open slot for the given asset type.
 *
 * Used by /api/draft/pick to reject over-draft attempts BEFORE atomicClaimAsset
 * runs. Without this check, a user could pick a third driver and the server
 * would silently overwrite their driver2 slot (the existing assignRosterSlot
 * code did `else { driver2 = newAsset }` with no guard).
 *
 * Roster slot caps: 2 drivers, 1 principal, 2 pit crews, 1 power unit (6 total).
 */
export function hasOpenSlotForType(roster: any, assetType: string): boolean {
  if (!roster) return false;
  switch (assetType) {
    case 'driver':    return !roster.driver1AssetId || !roster.driver2AssetId;
    case 'principal': return !roster.principalAssetId;
    case 'pitCrew':   return !roster.pitCrew1AssetId || !roster.pitCrew2AssetId;
    case 'powerUnit': return !roster.powerUnitAssetId;
    default:          return false;
  }
}

/**
 * Per-asset-type expected-points-per-race weighting. Reflects approximate
 * fantasy points contribution:
 *   - drivers     ~50 pts/race
 *   - principals  ~25-30 pts/race
 *   - pit crews   ~15-20 pts/race
 *   - power units ~10-15 pts/race
 *
 * Used by sortCandidatesForAutoDraft to convert raw OTF rating (which is
 * normalised 0-100 across all asset types) into an "expected value" that
 * compares fairly across types:
 *
 *   expectedValue = otfRating * weight
 *
 * Sort by expectedValue desc and you get the genuinely best asset, regardless
 * of type. Examples:
 *
 *   - 60 OTF driver  → 60.0   beats   95 OTF power unit → 23.75
 *   - 95 OTF principal → 52.25 beats   50 OTF driver    → 50.0
 *
 * F6: previously this was tier-first then OTF, which meant a CPU always
 * picked driver > principal > pitCrew > powerUnit regardless of OTF. Beta
 * testers reported bots drafting in obvious position order rather than
 * taking the best asset. Weighted-value sort fixes that while still
 * respecting per-race points realism.
 */
export const ASSET_TYPE_VALUE_WEIGHT: Record<string, number> = {
  driver:    1.0,
  principal: 0.55,
  pitCrew:   0.35,
  powerUnit: 0.25,
};

/**
 * Sorts a list of asset candidates by (expectedValue desc, otfRating desc as
 * tiebreaker) and returns the best pick. Used by auto-pick handlers as the
 * FALLBACK selection logic when the user's queue doesn't have an applicable
 * pick. The roster's open-slot constraint is applied upstream — by the time
 * candidates reach this function, they're guaranteed to match an open slot.
 */
export function sortCandidatesForAutoDraft<T extends { assetType: string; otfRating?: number }>(
  candidates: T[],
): T[] {
  return [...candidates].sort((a, b) => {
    const aValue = (a.otfRating ?? 0) * (ASSET_TYPE_VALUE_WEIGHT[a.assetType] ?? 0);
    const bValue = (b.otfRating ?? 0) * (ASSET_TYPE_VALUE_WEIGHT[b.assetType] ?? 0);
    if (aValue !== bValue) return bValue - aValue;
    // Tiebreaker on raw OTF (rare — only fires when expectedValue is exactly equal).
    return (b.otfRating ?? 0) - (a.otfRating ?? 0);
  });
}

/**
 * Atomically claims an asset from the draft session in a single MongoDB operation.
 *
 * The filter requires ALL of:
 *   - status: 'active'              — session must still be running
 *   - currentPickIndex: pickIndex   — only one request can advance a given pick slot
 *   - availableAssetIds: assetId    — only one request can claim a given asset
 *
 * Because both conditions are in the same atomic filter, two concurrent requests
 * racing on the same pick slot will have exactly one winner. The loser gets null.
 *
 * Returns the updated DraftSession (new: true), or null if the race was lost.
 */
export async function atomicClaimAsset(params: {
  sessionId: mongoose.Types.ObjectId | string;
  assetId: mongoose.Types.ObjectId | string;
  pickIndex: number;
  newPickIndex: number;
  newRound: number;
  pickDoc: PickDoc;
}): Promise<any | null> {
  const { sessionId, assetId, pickIndex, newPickIndex, newRound, pickDoc } = params;

  return DraftSession.findOneAndUpdate(
    {
      _id: sessionId,
      status: 'active',
      currentPickIndex: pickIndex,
      availableAssetIds: assetId,
    },
    {
      $pull: { availableAssetIds: assetId },
      $push: { picks: pickDoc },
      $set: {
        currentPickIndex: newPickIndex,
        currentRound: newRound,
        currentPickStartedAt: new Date(),
      },
    },
    { new: true },
  );
}

const ROSTER_ASSET_FIELDS = [
  'driver1AssetId', 'driver2AssetId',
  'principalAssetId',
  'pitCrew1AssetId', 'pitCrew2AssetId',
  'powerUnitAssetId',
] as const;

/**
 * Defense-in-depth guard: throws if the asset is already assigned to any roster
 * in this league. Call this AFTER atomicClaimAsset succeeds but BEFORE writing to
 * the roster. Catches bugs that bypass the draft session (manual /add calls, out-of-
 * sync availableAssetIds, or future code paths that forget atomicClaimAsset).
 *
 * If this throws, the caller must roll back by adding the asset back to
 * availableAssetIds.
 */
export async function assertAssetNotOnAnyRoster(
  leagueId: string | mongoose.Types.ObjectId,
  assetId: mongoose.Types.ObjectId | string,
): Promise<void> {
  const assetIdStr = assetId.toString();
  const allRosters = await Roster.find({ leagueId }).lean() as any[];

  for (const roster of allRosters) {
    for (const field of ROSTER_ASSET_FIELDS) {
      if (roster[field]?.toString() === assetIdStr) {
        throw new Error(
          `DUPLICATE_ASSET: ${assetIdStr} already assigned to roster ${roster._id} (${field})`,
        );
      }
    }
  }
}

/**
 * Rolls back a successful atomic claim by re-adding the asset to availableAssetIds.
 * Call this if assertAssetNotOnAnyRoster throws after a successful atomicClaimAsset.
 */
export async function rollbackClaim(
  sessionId: mongoose.Types.ObjectId | string,
  assetId: mongoose.Types.ObjectId | string,
): Promise<void> {
  await DraftSession.updateOne(
    { _id: sessionId },
    { $addToSet: { availableAssetIds: assetId } },
  );
}

/**
 * Assigns the picked asset to the correct roster slot.
 *
 * Defense-in-depth: THROWS `SLOT_FULL: <type>` if no open slot exists for the
 * asset type. Previously this silently overwrote slot 2 (driver2 / pitCrew2)
 * when both slots were already filled, OR overwrote the principal/powerUnit
 * slot via unconditional $set. Either case corrupted the roster.
 *
 * Callers MUST guard with hasOpenSlotForType BEFORE invoking this. The throw
 * here is a safety net for any future code path that forgets to check.
 */
export async function assignRosterSlot(
  leagueId: string | mongoose.Types.ObjectId,
  userId: string | mongoose.Types.ObjectId,
  assetId: mongoose.Types.ObjectId | string,
  assetType: string,
): Promise<void> {
  if (assetType === 'driver') {
    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) throw new Error('ROSTER_NOT_FOUND');
    if (!roster.driver1AssetId)      { roster.driver1AssetId = assetId; }
    else if (!roster.driver2AssetId) { roster.driver2AssetId = assetId; }
    else throw new Error('SLOT_FULL: driver');
    roster.updatedAt = new Date();
    await roster.save();
    return;
  }

  if (assetType === 'pitCrew') {
    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) throw new Error('ROSTER_NOT_FOUND');
    if (!roster.pitCrew1AssetId)      { roster.pitCrew1AssetId = assetId; }
    else if (!roster.pitCrew2AssetId) { roster.pitCrew2AssetId = assetId; }
    else throw new Error('SLOT_FULL: pitCrew');
    roster.updatedAt = new Date();
    await roster.save();
    return;
  }

  if (assetType === 'principal' || assetType === 'powerUnit') {
    const field = assetType === 'principal' ? 'principalAssetId' : 'powerUnitAssetId';
    // Filter requires the slot to be unset — atomic guard against overwrite.
    const result = await Roster.updateOne(
      { leagueId, userId, [field]: { $in: [null, undefined] } },
      { $set: { [field]: assetId, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      throw new Error(`SLOT_FULL: ${assetType}`);
    }
    return;
  }

  throw new Error(`UNKNOWN_ASSET_TYPE: ${assetType}`);
}

/**
 * F5: shared auto-pick implementation used by:
 *   - /api/draft/auto-pick     (user taps "auto-pick now" for themselves)
 *   - /api/draft/pick          (after a manual pick, cascade through CPUs/auto users)
 *   - /api/cron/auto-pick      (belt-and-suspenders for stuck drafts)
 *
 * Does NOT do auth, rate limiting, "is it their turn" verification, or push
 * notifications — caller's responsibility. Caller MUST have verified that
 * `userId` is the currentDrafter and the draft is active before calling.
 *
 * Steps (mirrors what /api/draft/auto-pick was doing inline):
 *   1. Refresh draft session
 *   2. Check open slot types from roster
 *   3. Try first queued asset matching an open slot
 *   4. Fall back to sortCandidatesForAutoDraft (weighted-best-available per F6)
 *   5. Mark user as auto-draft (idempotent)
 *   6. atomicClaimAsset
 *   7. assertAssetNotOnAnyRoster (rollback on duplicate)
 *   8. assignRosterSlot (rollback on SLOT_FULL — F3)
 *   9. Mark complete if currentPickIndex >= totalPicks
 *
 * Returns the post-pick state so the caller can decide whether to cascade
 * to the next drafter or send completion pushes.
 */
export interface PerformAutoPickResult {
  success:        boolean;
  draftComplete:  boolean;
  nextDrafterId:  string | null;
  pickedAssetId:  string | null;
  error?:         string;
}

export async function performAutoPick(
  leagueId: string,
  userId: string,
): Promise<PerformAutoPickResult> {
  const draftSession = await DraftSession.findOne({ leagueId, status: 'active' });
  if (!draftSession) return { success: false, draftComplete: false, nextDrafterId: null, pickedAssetId: null, error: 'NO_ACTIVE_DRAFT' };

  // Sanity check: caller should have verified, but double-check.
  const currentDrafterId = draftSession.draftOrder[draftSession.currentPickIndex]?.toString();
  if (currentDrafterId !== userId) {
    return { success: false, draftComplete: false, nextDrafterId: currentDrafterId ?? null, pickedAssetId: null, error: 'NOT_YOUR_TURN' };
  }

  const roster = await Roster.findOne({ leagueId, userId });
  if (!roster) return { success: false, draftComplete: false, nextDrafterId: null, pickedAssetId: null, error: 'NO_ROSTER' };

  const openTypes = neededAssetTypes(roster);
  if (openTypes.length === 0) {
    return { success: false, draftComplete: false, nextDrafterId: null, pickedAssetId: null, error: 'ROSTER_FULL' };
  }

  const availableIds = draftSession.availableAssetIds.map((id: any) => id.toString());

  // Queue first.
  const draftQueue = await DraftQueue.findOne({ leagueId, userId });
  const queuedIds = draftQueue?.queue?.map((id: any) => id.toString()) ?? [];
  const queuedPickId = queuedIds.find((qid: string) => availableIds.includes(qid));

  let bestAsset: any = null;
  if (queuedPickId) {
    const queued = await Asset.findOne({
      _id: queuedPickId,
      assetType: { $in: openTypes },
      isActive: true,
    }).select('_id assetType');
    if (queued) bestAsset = queued;
  }

  // Fall back to weighted best-available (F6).
  if (!bestAsset) {
    const candidates = await Asset
      .find({ _id: { $in: availableIds }, assetType: { $in: openTypes }, isActive: true })
      .select('_id assetType otfRating')
      .lean();
    bestAsset = sortCandidatesForAutoDraft(candidates as any[])[0] ?? null;
  }

  if (!bestAsset) {
    return { success: false, draftComplete: false, nextDrafterId: null, pickedAssetId: null, error: `NO_CANDIDATE_FOR_TYPES: ${openTypes.join(',')}` };
  }

  const assetType = bestAsset.assetType as string;

  const pickIndex = draftSession.currentPickIndex;
  const memberCount = draftSession.draftOrder.length / draftSession.totalRounds;
  const newPickIndex = pickIndex + 1;
  const newRound = Math.floor(newPickIndex / memberCount) + 1;

  // Mark user as auto-draft (idempotent — F5 cascade relies on this so the
  // next call recognises the user as still on auto).
  if (!draftSession.autoDraftUserIds) draftSession.autoDraftUserIds = [] as any;
  if (!draftSession.autoDraftUserIds.includes(userId as any)) {
    draftSession.autoDraftUserIds.push(userId as any);
    await draftSession.save();
  }

  const updatedSession = await atomicClaimAsset({
    sessionId: draftSession._id,
    assetId:   bestAsset._id,
    pickIndex,
    newPickIndex,
    newRound,
    pickDoc: {
      pickNumber: pickIndex + 1,
      round:      draftSession.currentRound,
      userId,
      assetId:    bestAsset._id,
      assetType,
      pickedAt:   new Date(),
    },
  });

  if (!updatedSession) {
    return { success: false, draftComplete: false, nextDrafterId: null, pickedAssetId: null, error: 'ATOMIC_CLAIM_FAILED' };
  }

  try {
    await assertAssetNotOnAnyRoster(leagueId, bestAsset._id);
  } catch (err: any) {
    await rollbackClaim(updatedSession._id, bestAsset._id);
    return { success: false, draftComplete: false, nextDrafterId: null, pickedAssetId: null, error: `DUPLICATE_ASSET: ${err?.message}` };
  }

  try {
    await assignRosterSlot(leagueId, userId, bestAsset._id, assetType);
  } catch (err: any) {
    await rollbackClaim(updatedSession._id, bestAsset._id);
    return { success: false, draftComplete: false, nextDrafterId: null, pickedAssetId: null, error: err?.message ?? 'ASSIGN_FAILED' };
  }

  // Completion check
  let draftComplete = false;
  let nextDrafterId: string | null = null;
  if (updatedSession.currentPickIndex >= updatedSession.totalPicks) {
    updatedSession.status = 'completed';
    updatedSession.completedAt = new Date();
    const league = await League.findById(leagueId);
    if (league) {
      league.status = 'active';
      await league.save();
    }
    await updatedSession.save();
    draftComplete = true;
  } else {
    nextDrafterId = updatedSession.draftOrder[updatedSession.currentPickIndex]?.toString() ?? null;
  }

  return {
    success:       true,
    draftComplete,
    nextDrafterId,
    pickedAssetId: bestAsset._id.toString(),
  };
}

/**
 * F5: drives the cascade loop. Starts from `seedNextDrafterId` and keeps
 * firing performAutoPick as long as the next drafter is in autoDraftUserIds.
 * Stops on: human's turn, draft completion, error, or safety cap.
 *
 * Returns the final state so the caller can send the right push notifications.
 */
export interface CascadeResult {
  iterationsRun: number;
  draftComplete: boolean;
  finalNextDrafterId: string | null;
  lastError: string | null;
}

const MAX_CASCADE_ITERATIONS = 60; // safety: roughly one full snake round of 50-manager league

export async function runAutoPickCascade(
  leagueId: string,
  seedNextDrafterId: string | null,
): Promise<CascadeResult> {
  let nextDrafterId = seedNextDrafterId;
  let iterations = 0;
  let draftComplete = false;
  let lastError: string | null = null;

  while (nextDrafterId && iterations < MAX_CASCADE_ITERATIONS) {
    // Refresh session each iteration so autoDraftUserIds is current.
    const session = await DraftSession.findOne({ leagueId, status: 'active' }).lean() as any;
    if (!session) {
      // Either the draft completed (last iteration set status='completed') or
      // a concurrent process completed it. Stop cleanly.
      draftComplete = true;
      break;
    }

    const isAuto = (session.autoDraftUserIds ?? []).some((id: any) => id.toString() === nextDrafterId);
    if (!isAuto) {
      // Human's turn — stop. The cron will not auto-pick for them; they
      // either pick manually or time out, at which point this cascade fires again.
      break;
    }

    iterations++;
    const result = await performAutoPick(leagueId, nextDrafterId);
    if (!result.success) {
      lastError = result.error ?? 'UNKNOWN';
      console.error(`[draft cascade] iteration ${iterations} failed for ${nextDrafterId}:`, lastError);
      break;
    }

    if (result.draftComplete) {
      draftComplete = true;
      nextDrafterId = null;
      break;
    }

    nextDrafterId = result.nextDrafterId;
  }

  return {
    iterationsRun: iterations,
    draftComplete,
    finalNextDrafterId: nextDrafterId,
    lastError,
  };
}
