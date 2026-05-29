import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Pollinations call is expensive (paid downstream + 30s timeout). 5/min per
  // user is plenty for normal team-creation flow, blocks abuse loops.
  const rlUserId = (session.user as any).id as string;
  const { allowed, retryAfterSec } = await checkRateLimit('expensive', `logo:${rlUserId}`);
  if (!allowed) return rateLimitedResponse(retryAfterSec);

  const { teamName, primaryColor, secondaryColor, accentColor } = await req.json();
  if (!teamName || typeof teamName !== 'string' || !teamName.trim()) {
    return NextResponse.json({ error: 'teamName is required' }, { status: 400 });
  }

  const prompt = `Flat 2D vector logo for F1 motorsport team called '${teamName.trim()}'. Use these exact brand colors: primary ${primaryColor ?? ''}, secondary ${secondaryColor ?? ''}, accent ${accentColor ?? ''}. Style: clean corporate F1 team identity like Alpine, McLaren, or Red Bull Racing logos. Bold typography, simple geometric icon or lettermark. Flat design, no gradients, no 3D, no photographs. White background. Professional motorsport brand mark.`;

  console.log('[generate-logo] prompt:', prompt);

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${Math.floor(Math.random() * 999999)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);

    console.log('[generate-logo] Pollinations status:', res.status);

    if (!res.ok) {
      const errText = await res.text();
      console.error('[generate-logo] Pollinations error:', errText);
      return NextResponse.json({ error: `Image generation failed (${res.status})` }, { status: 502 });
    }

    const imageBuffer = await res.arrayBuffer();
    console.log('[generate-logo] success, buffer size:', imageBuffer.byteLength);
    const imageBase64 = Buffer.from(imageBuffer).toString('base64');
    return NextResponse.json({ imageBase64 });
  } catch (err: any) {
    console.error('[generate-logo] fetch exception:', err?.message ?? err);
    return NextResponse.json({ error: 'Logo generation failed', detail: err?.message ?? String(err) }, { status: 500 });
  }
}
