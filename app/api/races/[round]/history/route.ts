import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, HistoricalRaceBreakdown, RaceCalendar } from '@/lib/models';

function slugToDisplayName(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ round: string }> },
) {
  const { round: roundStr } = await params;
  const round = parseInt(roundStr, 10);
  if (isNaN(round) || round < 1 || round > 24) {
    return NextResponse.json({ error: 'Invalid round' }, { status: 400 });
  }

  const sp = req.nextUrl.searchParams;
  const assetType = sp.get('assetType') ?? 'driver';
  const validTypes = ['driver', 'principal', 'pitCrew', 'powerUnit'];
  if (!validTypes.includes(assetType)) {
    return NextResponse.json({ error: 'Invalid assetType' }, { status: 400 });
  }

  await connectDB();

  const raceDoc = await RaceCalendar.findOne({ season: 2026, round }).lean() as any;
  const raceName = raceDoc?.name ?? `Round ${round}`;

  if (assetType !== 'driver') {
    return NextResponse.json({
      raceName,
      assetType,
      hasRaceSpecificData: false,
      rows: [],
    });
  }

  // Load 2026 active assets for isActive2026 lookup
  const active2026 = await Asset.find({ season: 2026, isActive: true }).select('slug').lean() as any[];
  const active2026Slugs = new Set(active2026.map((a: any) => a.slug));

  // Asset name lookup
  const assets2026 = await Asset.find({ season: 2026 }).select('slug name team').lean() as any[];
  const assetMeta: Record<string, { name: string; team: string }> = {};
  for (const a of assets2026) {
    assetMeta[a.slug] = { name: a.name, team: a.team };
  }

  // Aggregate across all seasons for this round
  const breakdowns = await HistoricalRaceBreakdown.find({ round, assetType: 'driver' })
    .sort({ assetSlug: 1, season: 1 })
    .lean() as any[];

  // Group by assetSlug
  const grouped: Record<string, { totalScore: number; racesCompleted: number; seasons: number[]; latestTeam: string }> = {};
  for (const b of breakdowns) {
    if (!grouped[b.assetSlug]) {
      grouped[b.assetSlug] = { totalScore: 0, racesCompleted: 0, seasons: [], latestTeam: '' };
    }
    grouped[b.assetSlug].totalScore += b.tot ?? 0;
    grouped[b.assetSlug].racesCompleted += 1;
    grouped[b.assetSlug].seasons.push(b.season);
    grouped[b.assetSlug].latestTeam = b.team ?? grouped[b.assetSlug].latestTeam;
  }

  const rows = Object.entries(grouped).map(([slug, agg]) => {
    const meta = assetMeta[slug];
    const avgScore = agg.racesCompleted > 0
      ? Math.round((agg.totalScore / agg.racesCompleted) * 10) / 10
      : 0;
    return {
      slug,
      displayName: meta?.name ?? slugToDisplayName(slug),
      team: meta?.team ?? agg.latestTeam ?? '—',
      totalScore: agg.totalScore,
      racesCompleted: agg.racesCompleted,
      avgScore,
      isActive2026: active2026Slugs.has(slug),
      yearsAvailable: [...new Set(agg.seasons)].sort(),
    };
  });

  rows.sort((a, b) => b.totalScore - a.totalScore || b.avgScore - a.avgScore);

  return NextResponse.json({
    raceName,
    assetType,
    hasRaceSpecificData: true,
    rows,
  });
}
