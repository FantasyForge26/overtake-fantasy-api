/**
 * mobile-auth.ts
 *
 * Resolves the calling user from a mobile request. The authoritative path is
 * a signed token in the Authorization header:
 *
 *   Authorization: Bearer <signed mobile token>
 *
 * The token is HMAC-SHA256-signed with NEXTAUTH_SECRET, issued by
 * /api/auth/mobile-callback after Google sign-in. See lib/auth/mobile-token.ts.
 *
 * TRANSITION (delete after 2026-06-15): the previous scheme used an
 * x-user-id header containing the raw MongoDB ObjectId, which made every
 * mobile-authed endpoint impersonatable by anyone who knew a user's ID.
 * We keep that fallback temporarily so existing installs that haven't
 * been re-signed-in keep working, but every fallback hit is logged so we
 * can track the migration. Remove the fallback (and the x-user-id branch)
 * once telemetry shows ~zero hits.
 */

import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models';
import { verifyMobileToken } from '@/lib/auth/mobile-token';

export async function getMobileSession(request: NextRequest) {
  // 1. Preferred path: Authorization: Bearer <token>
  const auth = request.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    const result = verifyMobileToken(token);
    if (result.valid && result.payload) {
      await connectDB();
      const user = await User.findById(result.payload.sub)
        .select('_id email displayName avatarUrl')
        .lean() as any;
      if (!user) return null;
      return {
        user: {
          id:          user._id.toString(),
          email:       user.email,
          displayName: user.displayName,
          image:       user.avatarUrl ?? null,
        },
      };
    }
    // Invalid token — fall through (deliberately do NOT honor x-user-id when
    // a Bearer was provided, since that would let a downgrade attack succeed).
    console.warn('[mobile-auth] invalid bearer token, reason:', result.reason);
    return null;
  }

  // 2. Legacy fallback — DELETE AFTER 2026-06-15.
  const legacyUserId = request.headers.get('x-user-id');
  if (!legacyUserId) return null;

  console.warn('[mobile-auth] legacy x-user-id fallback hit. userId=', legacyUserId,
               'path=', request.nextUrl.pathname);

  await connectDB();
  const user = await User.findById(legacyUserId)
    .select('_id email displayName avatarUrl')
    .lean() as any;
  if (!user) return null;

  return {
    user: {
      id:          user._id.toString(),
      email:       user.email,
      displayName: user.displayName,
      image:       user.avatarUrl ?? null,
    },
  };
}
