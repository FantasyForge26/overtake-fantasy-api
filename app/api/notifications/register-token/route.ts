import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { PushToken } from '@/lib/models';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';

// Expo push token format: `ExponentPushToken[<base64-ish payload>]`
// Reject anything else — without this, the collection could be flooded with
// arbitrary strings that wouldn't deliver anywhere but would still pollute
// PushToken.find lookups during sendPushToUser.
const EXPO_TOKEN_RE = /^ExponentPushToken\[[A-Za-z0-9_-]{15,40}\]$/;
const ALLOWED_PLATFORMS = new Set(['ios', 'android']);

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;

  // 'auth' preset (5/15min). Token registration is auth-adjacent — happens
  // once per app install / sign-in. Two limits: IP-keyed to block bursts
  // from a single attacker, user-keyed as defense in depth.
  const ip = getClientIp(req);
  {
    const rl = await checkRateLimit('auth', `pushtoken-ip:${ip}`);
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);
  }
  {
    const rl = await checkRateLimit('auth', `pushtoken-user:${userId}`);
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);
  }

  const body = await req.json().catch(() => ({}));
  const { token, platform } = body;

  if (typeof token !== 'string' || !EXPO_TOKEN_RE.test(token)) {
    return NextResponse.json({ error: 'Invalid Expo push token' }, { status: 400 });
  }

  if (platform != null && (typeof platform !== 'string' || !ALLOWED_PLATFORMS.has(platform))) {
    return NextResponse.json({ error: 'Invalid platform' }, { status: 400 });
  }

  await connectDB();

  await PushToken.findOneAndUpdate(
    { token },
    { userId, token, platform, updatedAt: new Date() },
    { upsert: true, new: true },
  );

  return NextResponse.json({ ok: true });
}
