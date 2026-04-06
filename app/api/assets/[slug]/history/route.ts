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

  return NextResponse.json(history);
}
