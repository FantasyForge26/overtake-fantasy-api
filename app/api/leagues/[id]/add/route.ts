import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, Transaction } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

const SLOT_MAP: Record<string, string[]> = {
  driver:     ['driver1AssetId', 'driver2AssetId'],
  principal:  ['principalAssetId'],
  pitCrew:    ['pitCrew1AssetId', 'pitCrew2AssetId'],
  powerUnit:  ['powerUnitAssetId'],
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;
  const { addAssetId, dropAssetId } = await req.json();

  if (!addAssetId) {
    return NextResponse.json({ error: 'addAssetId is required' }, { status: 400 });
  }

  await connectDB();

  const league = await League.findById(leagueId).lean() as any;
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  const asset = await Asset.findById(addAssetId).select('assetType name').lean() as any;
  if (!asset) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  }

  const assetType: string = asset.assetType;
  const slots = SLOT_MAP[assetType];
  if (!slots) {
    return NextResponse.json({ error: `Unknown asset type: ${assetType}` }, { status: 400 });
  }

  const roster = await Roster.findOne({ leagueId, userId });
  if (!roster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  // Find an open slot for the asset type
  const openSlot = slots.find(slot => !roster[slot]);

  if (!openSlot && !dropAssetId) {
    return NextResponse.json({ error: 'Must drop a player first' }, { status: 400 });
  }

  // Drop the specified asset if provided
  if (dropAssetId) {
    for (const slot of Object.values(SLOT_MAP).flat()) {
      if (roster[slot]?.toString() === dropAssetId) {
        roster[slot] = undefined;
        break;
      }
    }
  }

  // Assign new asset to slot (open slot, or first slot of the type after drop)
  const targetSlot = openSlot ?? slots.find(slot => !roster[slot]) ?? slots[0];
  roster[targetSlot] = addAssetId;
  roster.updatedAt = new Date();
  await roster.save();

  // Log add transaction
  await Transaction.create({
    leagueId,
    userId,
    type: 'add',
    addAssetId,
    dropAssetId: dropAssetId ?? undefined,
    createdAt: new Date(),
  });

  // Log separate drop transaction if a drop occurred
  if (dropAssetId) {
    await Transaction.create({
      leagueId,
      userId,
      type: 'drop',
      dropAssetId,
      createdAt: new Date(),
    });
  }

  const populated = await Roster.findById(roster._id)
    .populate('driver1AssetId driver2AssetId principalAssetId pitCrew1AssetId pitCrew2AssetId powerUnitAssetId')
    .lean();

  return NextResponse.json(populated);
}
