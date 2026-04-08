import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Transaction, Asset } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  await connectDB();

  const txs = await Transaction.find({
    leagueId,
    type: { $in: ['add', 'drop'] },
    createdAt: { $gte: since },
  }).lean() as any[];

  // Count adds and drops per asset
  const addCounts: Record<string, number> = {};
  const dropCounts: Record<string, number> = {};

  for (const tx of txs) {
    if (tx.type === 'add' && tx.addAssetId) {
      const id = tx.addAssetId.toString();
      addCounts[id] = (addCounts[id] ?? 0) + 1;
    }
    if (tx.type === 'drop' && tx.dropAssetId) {
      const id = tx.dropAssetId.toString();
      dropCounts[id] = (dropCounts[id] ?? 0) + 1;
    }
  }

  // Gather all relevant asset IDs
  const allIds = Array.from(new Set([...Object.keys(addCounts), ...Object.keys(dropCounts)]));
  if (allIds.length === 0) {
    return NextResponse.json({ trendingUp: [], trendingDown: [] });
  }

  const assets = await Asset.find({ _id: { $in: allIds } })
    .select('name assetType team otfRating')
    .lean() as any[];

  const assetMap = Object.fromEntries(assets.map((a: any) => [a._id.toString(), a]));

  const trendingUp = Object.entries(addCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ asset: assetMap[id], count }))
    .filter(x => x.asset);

  const trendingDown = Object.entries(dropCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ asset: assetMap[id], count }))
    .filter(x => x.asset);

  return NextResponse.json({ trendingUp, trendingDown });
}
