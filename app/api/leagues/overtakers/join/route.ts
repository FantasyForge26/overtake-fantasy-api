/**
 * POST /api/leagues/overtakers/join
 *
 * F8 Overtakers Mode entry point. Creates a personal league for the user with
 * 10 CPU drafters, an instantly-active draft session, and kicks off the F5
 * cascade so all CPU picks ahead of the user fire before the response returns.
 *
 * Flow:
 *   1. Resolve the current race week (next upcoming race in RaceCalendar)
 *   2. Idempotency: if the user already has an Overtakers league for this race
 *      week, return it (don't re-create)
 *   3. Create 10 CPU User records (with deterministic emails so they're
 *      unique per league)
 *   4. Create the League (mode='overtakers', raceWeek=N, status='drafting')
 *   5. Create 11 Rosters
 *   6. Build snake draft order, randomise CPU positions but keep user position
 *      itself random (per spec: "user should be randomly assigned a draft
 *      position each time they enter")
 *   7. Create DraftSession with status='active' (no countdown — instant start)
 *   8. Add all 10 CPU userIds to autoDraftUserIds so F5 cascade fires for them
 *   9. If the FIRST drafter is a CPU, kick off runAutoPickCascade inline so
 *      the response returns with the draft already at the user's first turn
 *
 * The response includes leagueId so the mobile client can immediately
 * navigate to /draft/[leagueId].
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, League, RaceCalendar, Roster, User } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { runAutoPickCascade } from '@/lib/pick-helpers';

const SEASON         = 2026;
const CPU_COUNT      = 10;
const TOTAL_ROUNDS   = 6;
const PICK_TIMER_SEC = 120; // 2 minutes per user pick — per spec

// Crypto-secure invite code generator (mirrors C3 fix from the audit — the
// invite isn't user-facing in Overtakers mode but the schema requires it).
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += INVITE_ALPHABET[bytes[i] & 0x1f];
  return code;
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildSnakeDraftOrder(memberIds: string[], totalRounds: number): string[] {
  const order: string[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const roundOrder = round % 2 === 0 ? [...memberIds].reverse() : [...memberIds];
    order.push(...roundOrder);
  }
  return order;
}

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 'auth' preset (5/15min per user). Each call creates 10 CPU users + 11
  // rosters + a draft session — heavy. Plus prevents accidental double-tap
  // from creating duplicate leagues.
  const rl = await checkRateLimit('auth', `overtakers-join:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  await connectDB();

  // ── 1. Resolve current race week ─────────────────────────────────────────
  const now = new Date();
  const nextRace = await RaceCalendar.findOne({
    season:    SEASON,
    cancelled: false,
    raceDate:  { $gt: now },
  }).sort({ round: 1 }).lean() as any;

  if (!nextRace) {
    return NextResponse.json(
      { error: 'Overtakers Mode is available only during the racing season.' },
      { status: 400 },
    );
  }
  const raceWeek = nextRace.round as number;

  // ── 2. Idempotency: existing Overtakers league for this user + race week? ──
  const existing = await League.findOne({
    mode:           'overtakers',
    raceWeek,
    commissionerId: userId,
    season:         SEASON,
  }).lean() as any;

  if (existing) {
    return NextResponse.json(
      { leagueId: existing._id.toString(), reused: true },
      { status: 200 },
    );
  }

  // ── 3. Create 10 CPU User records ────────────────────────────────────────
  // Email uniqueness uses a per-request token so concurrent calls don't collide.
  const cpuToken = randomBytes(8).toString('hex');
  const cpuUsers = await Promise.all(
    Array.from({ length: CPU_COUNT }, (_, i) =>
      User.create({
        displayName: `CPU Team ${i + 1}`,
        email:       `cpu-${cpuToken}-${i}@overtake.ai`,
        isAI:        true,
      }),
    ),
  );
  const cpuUserIds = cpuUsers.map(u => u._id.toString());

  // ── 4. Create the League ─────────────────────────────────────────────────
  const allMemberIds = [userId, ...cpuUserIds];

  // Fetch the assets we'll need for the draft pool BEFORE creating the
  // session so we can fail early if the asset pool is empty.
  const assets = await Asset.find({ season: SEASON, confirmed: true }).select('_id').lean();
  if (assets.length < TOTAL_ROUNDS * (CPU_COUNT + 1)) {
    return NextResponse.json(
      { error: 'Not enough assets in pool to run an Overtakers draft.' },
      { status: 500 },
    );
  }
  const availableAssetIds = assets.map((a: any) => a._id);

  const league = await League.create({
    name:               `Race ${raceWeek} Overtakers — ${(session.user as any).displayName ?? 'You'}`,
    format:             'redraft',
    commissionerId:     userId,
    memberIds:          allMemberIds,
    season:             SEASON,
    status:             'drafting',
    inviteCode:         generateInviteCode(),
    maxManagers:        CPU_COUNT + 1,
    isPublic:           false,
    draftMode:          'fast',
    pickTimeLimitSeconds: PICK_TIMER_SEC,
    draftOrderMode:     'random',
    mode:               'overtakers',
    raceWeek,
  });

  // ── 5. Create 11 Rosters ─────────────────────────────────────────────────
  await Roster.insertMany(
    allMemberIds.map((uid, i) => ({
      leagueId: league._id,
      userId:   new mongoose.Types.ObjectId(uid),
      season:   SEASON,
      teamName: i === 0 ? 'My Team' : `CPU Team ${i}`,
      ccBalance: 0,
    })),
    { ordered: false },
  );

  // ── 6. Build snake draft order with random position assignment ───────────
  // Per spec: "user should be randomly assigned a draft position each time".
  // Shuffle all 11 members; their order determines round-1 picking sequence.
  const round1Order = fisherYatesShuffle(allMemberIds);
  const draftOrder = buildSnakeDraftOrder(round1Order, TOTAL_ROUNDS);
  const userPickPosition = round1Order.indexOf(userId) + 1; // 1-indexed for display

  // Persist round-1 order for the pre-draft display (matches existing convention)
  league.draftOrderIds = round1Order as any;
  await league.save();

  // ── 7. Create the DraftSession, status='active' (no countdown) ───────────
  const draftSession = await DraftSession.create({
    leagueId:             league._id,
    season:               SEASON,
    status:               'active',
    draftOrder,
    currentPickIndex:     0,
    currentRound:         1,
    totalRounds:          TOTAL_ROUNDS,
    totalPicks:           draftOrder.length,
    availableAssetIds,
    picks:                [],
    pickTimeLimitSeconds: PICK_TIMER_SEC,
    preDraftStartedAt:    new Date(),
    currentPickStartedAt: new Date(),
    autoDraftUserIds:     cpuUserIds, // F5 cascade will fire for these
  });

  // ── 8. Kick off the F5 cascade if the first drafter is a CPU ─────────────
  // Without this the response returns with currentPickIndex=0 and the user
  // has to wait for the cron to fire the first CPU pick (up to 60s). With it,
  // the cascade runs inline and the response returns with currentPickIndex
  // already at the user's first turn.
  const firstDrafterId = draftOrder[0]?.toString();
  if (firstDrafterId && firstDrafterId !== userId) {
    try {
      const cascade = await runAutoPickCascade(league._id.toString(), firstDrafterId);
      if (cascade.lastError) {
        console.error('[overtakers/join] initial cascade lastError:', cascade.lastError);
      }
    } catch (err) {
      // Non-fatal — the user can still enter the draft, and the cron will
      // resume CPU picks within the next minute if the cascade crashed.
      console.error('[overtakers/join] initial cascade threw:', err);
    }
  }

  return NextResponse.json({
    leagueId:           league._id.toString(),
    draftSessionId:     draftSession._id.toString(),
    userPickPosition,
    raceWeek,
    reused:             false,
  }, { status: 201 });
}
