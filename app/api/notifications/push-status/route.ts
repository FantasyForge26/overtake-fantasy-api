/**
 * /api/notifications/push-status
 *
 * Returns the requesting user's recent push attempts and their delivery
 * tickets. Useful for verifying end-to-end push delivery and debugging stuck
 * notifications.
 *
 * Response shape:
 * {
 *   tokensRegistered: number,
 *   recent: [
 *     {
 *       _id, type, title, body, createdAt,
 *       pushSentAt, pushTickets: [{ token, ticketId, status, expoErrorCode, expoMessage }]
 *     }
 *   ],
 *   summary: {
 *     last24h: { total: number, ok: number, error: number },
 *     errorBreakdown: { [expoErrorCode]: number }
 *   }
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Notification, PushToken } from '@/lib/models';

export async function GET(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;

  await connectDB();

  const [tokens, recent] = await Promise.all([
    PushToken.find({ userId }).select('platform updatedAt').lean(),
    Notification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('type title body createdAt pushSentAt pushTickets')
      .lean(),
  ]);

  // Summary over last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent24 = recent.filter((n: any) => n.createdAt >= since);

  let okCount = 0;
  let errCount = 0;
  const errorBreakdown: Record<string, number> = {};

  for (const n of recent24) {
    const tickets: any[] = n.pushTickets ?? [];
    for (const t of tickets) {
      if (t.status === 'ok') {
        okCount++;
      } else {
        errCount++;
        const code = t.expoErrorCode ?? 'UNKNOWN';
        errorBreakdown[code] = (errorBreakdown[code] ?? 0) + 1;
      }
    }
  }

  return NextResponse.json({
    tokensRegistered: tokens.length,
    tokens,
    recent,
    summary: {
      last24h: { total: okCount + errCount, ok: okCount, error: errCount },
      errorBreakdown,
    },
  });
}
