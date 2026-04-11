import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { AssetNews } from '@/lib/models';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  const { searchParams } = new URL(req.url);
  const assetName = searchParams.get('assetName') ?? slug;
  const assetType = searchParams.get('assetType') ?? '';

  await connectDB();

  // Check cache
  const cached = await AssetNews.findOne({ assetSlug: slug }).lean() as any;
  if (cached?.generatedAt && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS) {
    return NextResponse.json({
      headlines: cached.headlines,
      generatedAt: cached.generatedAt,
      cached: true,
    });
  }

  // Build search query
  const typeHint = assetType === 'pitCrew' ? 'pit crew'
    : assetType === 'powerUnit' ? 'power unit engine'
    : assetType === 'principal' ? 'team principal'
    : '';
  const searchQuery = `${assetName}${typeHint ? ` ${typeHint}` : ''} F1 2026`;

  const prompt = `Search for the 5 most recent and relevant F1 news stories about ${assetName}${typeHint ? ` (${typeHint})` : ''}. For each story return: title, a 2 sentence summary, source name, url, and published date. Focus on 2026 season news, recent race results, team updates, and significant developments. Return ONLY a JSON array of exactly 5 objects with fields: title, summary, url, source, publishedAt`;

  // Call Anthropic API with web_search tool
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text();
    console.error('Anthropic API error:', err);
    return NextResponse.json({ error: 'Failed to fetch news' }, { status: 502 });
  }

  const anthropicData = await anthropicRes.json();

  // Extract text content from the response (last text block)
  const textBlock = anthropicData.content?.findLast((b: any) => b.type === 'text');
  if (!textBlock?.text) {
    return NextResponse.json({ error: 'No content in response' }, { status: 502 });
  }

  // Parse JSON array from response text
  let headlines: any[] = [];
  try {
    const match = textBlock.text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found');
    headlines = JSON.parse(match[0]);
  } catch (e) {
    console.error('Failed to parse headlines JSON:', textBlock.text);
    return NextResponse.json({ error: 'Failed to parse news response' }, { status: 502 });
  }

  const generatedAt = new Date();

  // Upsert into MongoDB
  await AssetNews.findOneAndUpdate(
    { assetSlug: slug },
    { assetSlug: slug, headlines, generatedAt, searchQuery },
    { upsert: true, new: true },
  );

  return NextResponse.json({ headlines, generatedAt, cached: false });
}
