import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, HistoricalRaceBreakdown, HistoricalSeason, RaceCalendar } from '@/lib/models';

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

  const seasonParam = sp.get('season');
  const season = seasonParam ? parseInt(seasonParam, 10) : 2025;

  await connectDB();

  // Get race name from calendar
  const raceDoc = await RaceCalendar.findOne({ season: 2026, round }).lean() as any;
  const raceName = raceDoc?.name ?? `Round ${round}`;

  // Load 2026 active assets for isActive2026 lookup
  const active2026 = await Asset.find({ season: 2026, isActive: true }).select('slug').lean() as any[];
  const active2026Slugs = new Set(active2026.map((a: any) => a.slug));

  // Asset name lookup from 2026 assets (best displayName source)
  const assets2026 = await Asset.find({ season: 2026 }).select('slug name team').lean() as any[];
  const assetMeta: Record<string, { name: string; team: string }> = {};
  for (const a of assets2026) {
    assetMeta[a.slug] = { name: a.name, team: a.team };
  }

  if (assetType === 'driver') {
    // Per-race breakdown from historicalracebreakdowns
    const breakdowns = await HistoricalRaceBreakdown.find({ season, round, assetType: 'driver' })
      .sort({ tot: -1 })
      .lean() as any[];

    const rows = breakdowns.map((b: any) => {
      const meta = assetMeta[b.assetSlug];
      return {
        slug: b.assetSlug,
        displayName: meta?.name ?? slugToDisplayName(b.assetSlug),
        team: meta?.team ?? b.team ?? '—',
        score: b.tot ?? 0,
        dnf: b.dnf ?? false,
        isActive2026: active2026Slugs.has(b.assetSlug),
        qPos: b.qPos ?? null,
        qStage: b.qStage ?? null,
      };
    });

    return NextResponse.json({
      raceName,
      season,
      assetType,
      hasRaceSpecificData: true,
      rows,
    });
  }

  // Non-driver: return season totals
  const seasonDocs = await HistoricalSeason.find({ season, assetType })
    .sort({ totalPoints: -1 })
    .lean() as any[];

  const rows = seasonDocs.map((s: any) => {
    const meta = assetMeta[s.assetSlug];
    return {
      slug: s.assetSlug,
      displayName: meta?.name ?? slugToDisplayName(s.assetSlug),
      team: meta?.team ?? s.team ?? '—',
      score: s.totalPoints ?? 0,
      dnf: false,
      isActive2026: active2026Slugs.has(s.assetSlug),
    };
  });

  return NextResponse.json({
    raceName,
    season,
    assetType,
    hasRaceSpecificData: false,
    rows,
  });
}
