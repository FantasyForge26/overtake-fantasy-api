/**
 * POST /api/leagues/[id]/trades/[tradeId]/decline
 *
 * Either party (proposer or counterparty) can decline/cancel a pending trade.
 * Proposer declining = cancelling their own offer.
 * Counterparty declining = rejecting the offer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Trade } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; tradeId: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId, tradeId } = await params;
  const userId = (session.user as any).id as string;

  // 'write' preset (60/min per user).
  const rl = await checkRateLimit('write', `trade-decline:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  await connectDB();

  const trade = await Trade.findById(tradeId) as any;
  if (!trade) return NextResponse.json({ error: 'Trade not found' }, { status: 404 });
  if (trade.leagueId.toString() !== leagueId) return NextResponse.json({ error: 'League mismatch' }, { status: 400 });

  const isProposer    = trade.proposerUserId.toString()    === userId;
  const isCounterparty = trade.counterpartyUserId.toString() === userId;
  if (!isProposer && !isCounterparty) {
    return NextResponse.json({ error: 'Not authorized for this trade' }, { status: 403 });
  }
  if (trade.status !== 'pending') {
    return NextResponse.json({ error: `Trade is already ${trade.status}` }, { status: 400 });
  }

  trade.status = isProposer ? 'cancelled' : 'declined';
  trade.respondedAt = new Date();
  await trade.save();

  return NextResponse.json({ trade });
}
