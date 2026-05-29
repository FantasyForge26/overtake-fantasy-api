import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { NewsSummary } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function GET(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const articleUrl = req.nextUrl.searchParams.get('url');
  if (!articleUrl) {
    return NextResponse.json({ error: 'url query param is required' }, { status: 400 });
  }

  // Anthropic call is metered. The cache below handles repeats, but a
  // miss-storm could still rack up cost — 5/min per user keeps that bounded.
  // Applied before the cache check on purpose: rate-limit budget is per
  // request, regardless of hit or miss.
  const rlUserId = (session.user as any).id as string;
  const { allowed, retryAfterSec } = await checkRateLimit('expensive', `news:${rlUserId}`);
  if (!allowed) return rateLimitedResponse(retryAfterSec);

  await connectDB();

  // Check cache
  const cached = await NewsSummary.findOne({ url: articleUrl }).lean() as any;
  if (cached?.cachedAt && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
    return NextResponse.json({ summary: cached.summary, cached: true });
  }

  // Fetch article HTML
  let articleText = '';
  try {
    const htmlRes = await fetch(articleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OvertakeFantasy/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status}`);
    const html = await htmlRes.text();
    // Strip HTML tags and collapse whitespace
    articleText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
  } catch (err: any) {
    console.error('[news/summarize] fetch article error:', err?.message);
    return NextResponse.json({ error: 'Failed to fetch article' }, { status: 502 });
  }

  // Call Anthropic API
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Summarize this F1 news article in 3-4 sentences. Focus on the key facts and takeaways. Be concise and direct. Article text: ${articleText}`,
      }],
    }),
  });

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text();
    console.error('[news/summarize] Anthropic error:', err);
    return NextResponse.json({ error: 'Failed to summarize article' }, { status: 502 });
  }

  const anthropicData = await anthropicRes.json();
  const summary = anthropicData.content?.[0]?.text?.trim() ?? '';

  if (!summary) {
    return NextResponse.json({ error: 'Empty summary returned' }, { status: 502 });
  }

  // Upsert into MongoDB
  const cachedAt = new Date();
  await NewsSummary.findOneAndUpdate(
    { url: articleUrl },
    { url: articleUrl, summary, cachedAt },
    { upsert: true, new: true },
  );

  return NextResponse.json({ summary, cached: false });
}
