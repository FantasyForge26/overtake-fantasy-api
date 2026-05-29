import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

// New codes are 8 chars from a 32-char alphabet (no ambiguous I/O/1/0).
// That's 40 bits ≈ 1.1 trillion combinations — combined with the IP-rate-
// limit on /join (5/15min), brute force is infeasible.
//
// Existing 6-char codes (~1 billion combos) remain valid — the join endpoint
// validates against /^[A-HJ-NP-Z2-9]{6,16}$/ so both lengths are accepted.
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LEN = 8;

function generateInviteCode(): string {
  // crypto.randomBytes is CSPRNG-backed. Math.random was not — its state
  // could be inferred from a few observed codes.
  const bytes = randomBytes(INVITE_LEN);
  let code = '';
  for (let i = 0; i < INVITE_LEN; i++) {
    // Modulo 32 over 256 is bias-free because 256 is a clean multiple of 32.
    code += INVITE_ALPHABET[bytes[i] & 0x1f];
  }
  return code;
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

  // 'write' preset (60/min per user) — plenty for legitimate commissioner
  // activity, hard cap against a script creating thousands of dummy leagues
  // to stuff the DB or burn through the invite-code namespace.
  const rl = await checkRateLimit('write', `league-create:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { name, format, maxManagers, isPublic, draftMode, slowDraftPickHours, pauseStart, pauseEnd, pickTimeLimitSeconds, draftOrderMode, draftDateTime, freeAgencyType, acquisitionType, ccStartingBalance, minRacesHeld, waiversClearDay, waiverHoldDays } = await req.json();

  await connectDB();

  // Ensure invite code is unique
  let inviteCode: string;
  let attempts = 0;
  do {
    inviteCode = generateInviteCode();
    const existing = await League.findOne({ inviteCode });
    if (!existing) break;
    attempts++;
  } while (attempts < 10);

  const league = await League.create({
    name,
    format,
    maxManagers: maxManagers ?? 10,
    commissionerId: userId,
    memberIds: [userId],
    status: 'setup',
    season: 2026,
    inviteCode,
    ...(isPublic !== undefined && { isPublic }),
    ...(draftMode && { draftMode }),
    ...(slowDraftPickHours !== undefined && { slowDraftPickHours }),
    ...(pauseStart && { pauseStart }),
    ...(pauseEnd && { pauseEnd }),
    ...(pickTimeLimitSeconds !== undefined && { pickTimeLimitSeconds }),
    ...(draftOrderMode && { draftOrderMode }),
    ...(draftDateTime && { draftDateTime: new Date(draftDateTime) }),
    ...(freeAgencyType && { freeAgencyType }),
    ...(acquisitionType && { acquisitionType }),
    ...(ccStartingBalance !== undefined && { ccStartingBalance }),
    ...(minRacesHeld !== undefined && { minRacesHeld }),
    ...(waiversClearDay && { waiversClearDay }),
    ...(waiverHoldDays !== undefined && { waiverHoldDays }),
    scoring: {
      poleBonus: 10,
      raceFirstBonus: 25,
      sprintFirstBonus: 10,
      pitCrewFirstBonus: 25,
      powerUnitFirstBonus: 25,
      principalFirstBonus: 25,
    },
  });

  await Roster.create({
    leagueId: league._id,
    userId,
    season: 2026,
  });

  return NextResponse.json(league, { status: 201 });
}

export async function GET(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  console.log('[leagues GET] x-user-id header:', req.headers.get('x-user-id'));
  console.log('[leagues GET] session:', JSON.stringify(session));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const leagues = await League.find({ memberIds: userId })
    .populate('commissionerId', 'displayName email');

  return NextResponse.json(leagues);
}
