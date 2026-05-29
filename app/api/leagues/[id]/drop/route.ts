import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster, Transaction } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const ROSTER_SLOTS = [
  'driver1AssetId',
  'driver2AssetId',
  'principalAssetId',
  'pitCrew1AssetId',
  'pitCrew2AssetId',
  'powerUnitAssetId',
] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 'write' preset (60/min per user). Pairs with the add-route limit so
  // add/drop loops are both bounded.
  const rl = await checkRateLimit('write', `roster-drop:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { id: leagueId } = await params;
  const { dropAssetId } = await req.json();

  await connectDB();

  const league = await League.findById(leagueId);
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  const roster = await Roster.findOne({ leagueId, userId });
  if (!roster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  const slot = ROSTER_SLOTS.find((s) => roster[s]?.toString() === dropAssetId);
  if (!slot) {
    return NextResponse.json({ error: 'Asset not found on roster' }, { status: 400 });
  }

  roster[slot] = undefined;
  roster.updatedAt = new Date();
  await roster.save();

  await Transaction.create({
    leagueId,
    userId,
    type: 'drop',
    dropAssetId,
    createdAt: new Date(),
  });

  return NextResponse.json(roster);
}
