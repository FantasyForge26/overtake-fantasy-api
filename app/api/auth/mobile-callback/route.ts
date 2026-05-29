/**
 * Mobile OAuth callback. Lands here after Google sign-in via NextAuth, mints a
 * signed mobile session token, and redirects back into the app via the
 * overtakefantasy:// deep link with both the user info and the token.
 *
 * The token is the authoritative auth credential going forward — the
 * userId/email/name/image params are display-only and the client should not
 * trust them for auth decisions.
 */

import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { signMobileToken } from '@/lib/auth/mobile-token';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function GET() {
  // IP-keyed rate limit on the token-mint endpoint. Prevents an attacker who
  // somehow lands on this callback from flooding it to enumerate or stress
  // the auth path. Uses the 'auth' preset: 5 req / 15 min per IP.
  const hdrs = await headers();
  const forwarded = hdrs.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0].trim() ?? hdrs.get('x-real-ip') ?? 'unknown';
  const { allowed, retryAfterSec } = await checkRateLimit('auth', `mobile-callback:${ip}`);
  if (!allowed) return rateLimitedResponse(retryAfterSec);

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect('/api/auth/signin');
  }

  const { id, email, name, image } = session.user as {
    id:    string;
    email: string;
    name?: string | null;
    image?: string | null;
  };

  const token = signMobileToken(id, email);

  const params = new URLSearchParams({
    userId: id,
    email,
    token,
    ...(name ? { name } : {}),
    ...(image ? { image } : {}),
  });

  redirect(`overtakefantasy://auth?${params.toString()}`);
}
