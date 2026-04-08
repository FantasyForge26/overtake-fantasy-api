import { NextRequest, NextResponse } from 'next/server';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { HistoricalSeason } from '@/lib/models';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getMobileSession(req);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;

  await connectDB();

  const history = await HistoricalSeason.find({ assetSlug: slug }).sort({ season: -1 });

  console.log(`[history] slug="${slug}" found=${history.length} docs`, history.map((h: any) => ({ season: h.season, assetType: h.assetType, totalPoints: h.totalPoints })));

  return NextResponse.json(history);
}
