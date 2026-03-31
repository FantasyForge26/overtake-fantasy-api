import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const assetType          = searchParams.get('assetType');
  const season             = parseInt(searchParams.get('season') ?? '2026', 10);
  const teamSlug           = searchParams.get('teamSlug');
  const includeUnconfirmed = searchParams.get('includeUnconfirmed') === 'true';

  const filter: Record<string, unknown> = { season };

  if (assetType) filter.assetType = assetType;
  if (teamSlug)  filter.teamSlug  = teamSlug;
  if (!includeUnconfirmed) filter.confirmed = true;

  await connectDB();

  const assets = await Asset.find(filter).sort({ assetType: 1, teamSlug: 1, name: 1 });

  return NextResponse.json(assets);
}
