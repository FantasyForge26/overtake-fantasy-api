import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession, Transaction, User, Asset } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;

  await connectDB();

  const [draftSession, txDocs] = await Promise.all([
    DraftSession.findOne({ leagueId }).lean() as any,
    Transaction.find({ leagueId }).lean() as unknown as any[],
  ]);

  // Draft picks
  const draftItems = await Promise.all(
    (draftSession?.picks ?? []).map(async (pick: any) => {
      const [user, asset] = await Promise.all([
        User.findById(pick.userId).select('displayName').lean() as any,
        Asset.findById(pick.assetId).select('name assetType').lean() as any,
      ]);
      return {
        type: 'draft',
        displayName: user?.displayName ?? 'Unknown',
        assetName: asset?.name ?? '',
        assetType: asset?.assetType ?? pick.assetType,
        createdAt: pick.pickedAt,
      };
    })
  );

  // FA / trade transactions
  const txItems = await Promise.all(
    txDocs.map(async (tx: any) => {
      const [user, addAsset, dropAsset] = await Promise.all([
        User.findById(tx.userId).select('displayName').lean() as any,
        tx.addAssetId ? Asset.findById(tx.addAssetId).select('name assetType').lean() as any : null,
        tx.dropAssetId ? Asset.findById(tx.dropAssetId).select('name assetType').lean() as any : null,
      ]);
      return {
        type: tx.type,
        displayName: user?.displayName ?? 'Unknown',
        assetName: addAsset?.name ?? '',
        assetType: addAsset?.assetType ?? dropAsset?.assetType ?? '',
        dropAssetName: dropAsset?.name ?? '',
        createdAt: tx.createdAt,
      };
    })
  );

  const all = [...draftItems, ...txItems].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return NextResponse.json(all);
}
