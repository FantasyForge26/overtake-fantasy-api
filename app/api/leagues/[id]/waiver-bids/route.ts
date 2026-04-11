import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { WaiverBid } from '@/lib/models';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (session.user as any).id as string;
  const { id: leagueId } = await params;

  await connectDB();

  const bids = await WaiverBid.find({ leagueId, userId, status: 'pending' })
    .populate('assetId', 'name assetType team slug otfRating')
    .populate('dropAssetId', 'name assetType')
    .sort({ bidAmount: -1 })
    .lean();

  return NextResponse.json({ bids });
}
