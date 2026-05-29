import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

/**
 * GET /api/admin/sentry-test
 *
 * Smoke-test endpoint: throws an error so we can confirm Sentry is capturing
 * exceptions end-to-end. Auth-gated identically to other /api/admin/* routes:
 * requires the `x-admin-key` header to match ADMIN_SECRET.
 *
 *   curl -H "x-admin-key: $ADMIN_SECRET" https://.../api/admin/sentry-test
 */
export async function GET(req: NextRequest) {
  if (req.headers.get('x-admin-key') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Capture explicitly so the event still flies even if the runtime swallows
  // thrown errors before instrumentation.onRequestError sees them.
  const id = Sentry.captureException(new Error('Manual API Sentry test'));
  await Sentry.flush(2000);

  throw new Error(`Manual API Sentry test (eventId=${id})`);
}
