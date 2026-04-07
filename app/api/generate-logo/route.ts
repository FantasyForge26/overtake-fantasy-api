import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { teamName, primaryColor, secondaryColor, accentColor } = await req.json();
  if (!teamName || typeof teamName !== 'string' || !teamName.trim()) {
    return NextResponse.json({ error: 'teamName is required' }, { status: 400 });
  }

  const apiKey = process.env.STABILITY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Image generation not configured' }, { status: 500 });
  }

  const prompt = `Flat 2D vector logo for F1 team called ${teamName.trim()}. Style: exactly like Alpine, Williams, McLaren, Haas or Red Bull Racing F1 team logos — flat corporate identity, white background, bold typography, simple geometric icon or lettermark, no gradients, no 3D effects, no photographs, no realistic rendering. Colors: Primary ${primaryColor ?? ''}, Secondary ${secondaryColor ?? ''}, Accent ${accentColor ?? ''}. Clean SVG-style flat design. Professional motorsport brand mark.`;

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('output_format', 'png');
  form.append('aspect_ratio', '1:1');

  try {
    const stabilityRes = await fetch(
      'https://api.stability.ai/v2beta/stable-image/generate/core',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'image/*',
        },
        body: form,
      },
    );

    if (!stabilityRes.ok) {
      const errText = await stabilityRes.text();
      console.error('[generate-logo] Stability error:', stabilityRes.status, errText);
      return NextResponse.json(
        { error: `Image generation failed (${stabilityRes.status})` },
        { status: 502 },
      );
    }

    const buffer = await stabilityRes.arrayBuffer();
    const imageBase64 = Buffer.from(buffer).toString('base64');

    return NextResponse.json({ imageBase64 });
  } catch (err: any) {
    console.error('[generate-logo] fetch error:', err?.message ?? err);
    return NextResponse.json({ error: 'Logo generation failed' }, { status: 500 });
  }
}
