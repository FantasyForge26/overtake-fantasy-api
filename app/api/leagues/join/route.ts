import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';

// Allowed alphabet for invite codes:
//   - legacy 6-char codes: ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (32 chars, no ambiguous I/O/1/0)
//   - new 8-char codes from crypto.randomBytes: same alphabet
// Length range 6-16 covers both old and a generous future bump.
const INVITE_CODE_RE = /^[A-HJ-NP-Z2-9]{6,16}$/;

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // IP-keyed rate limit on join. Even with the regex injection fixed, 6-char
  // codes are only 30 bits — without a limit, a single attacker can guess
  // thousands per minute. 'auth' preset: 5 per 15 min per IP is restrictive
  // enough to make brute force impractical while letting legitimate users
  // retry typos. Per-user limit added below as defense in depth.
  const ip = getClientIp(req);
  {
    const rl = await checkRateLimit('auth', `join-ip:${ip}`);
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);
  }
  {
    const rl = await checkRateLimit('auth', `join-user:${userId}`);
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);
  }

  const body = await req.json().catch(() => ({}));
  const rawInviteCode = body.inviteCode;

  if (typeof rawInviteCode !== 'string') {
    return NextResponse.json({ error: 'inviteCode is required' }, { status: 400 });
  }

  // Normalize to uppercase so legacy mixed-case codes still resolve.
  const inviteCode = rawInviteCode.trim().toUpperCase();

  // Strict whitelist on the alphabet. Critical: without this, the previous
  // implementation interpolated user input directly into a RegExp, so
  // inviteCode='.*' would match every league. This is an exact equality query
  // now, but we still validate the format to avoid noise queries against the
  // unique index.
  if (!INVITE_CODE_RE.test(inviteCode)) {
    return NextResponse.json({ error: 'Invalid invite code' }, { status: 400 });
  }

  await connectDB();

  // Exact match — no regex, no interpolation. Codes are minted in uppercase
  // so the normalized input above will match.
  const league = await League.findOne({ inviteCode });

  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  const memberIds = league.memberIds.map((id: any) => id.toString());

  if (memberIds.includes(userId)) {
    return NextResponse.json({ error: 'Already a member of this league' }, { status: 400 });
  }

  if (league.memberIds.length >= league.maxManagers) {
    return NextResponse.json({ error: 'League is full' }, { status: 400 });
  }

  if (!['setup', 'active'].includes(league.status)) {
    return NextResponse.json({ error: 'League is not accepting new members' }, { status: 400 });
  }

  league.memberIds.push(userId);
  await league.save();

  await Roster.create({
    leagueId: league._id,
    userId,
    season: league.season,
  });

  return NextResponse.json(league);
}
