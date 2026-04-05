import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession, User, Asset } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;

  await connectDB();

  const draftSession = await DraftSession.findOne({ leagueId }).lean() as any;

  if (!draftSession || !draftSession.picks?.length) {
    return NextResponse.json([]);
  }

  const transactions = await Promise.all(
    draftSession.picks.map(async (pick: any) => {
      const [user, asset] = await Promise.all([
        User.findById(pick.userId).select('displayName').lean() as any,
        Asset.findById(pick.assetId).select('name assetType').lean() as any,
      ]);
      return {
        type: 'draft',
        displayName: user?.displayName ?? 'Unknown',
        assetName: asset?.name ?? '',
        assetType: asset?.assetType ?? pick.assetType,
        pickedAt: pick.pickedAt,
      };
    })
  );

  transactions.sort((a, b) => new Date(b.pickedAt).getTime() - new Date(a.pickedAt).getTime());

  return NextResponse.json(transactions);
}
