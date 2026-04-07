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
  console.log('[generate-logo] STABILITY_API_KEY prefix:', apiKey ? apiKey.slice(0, 10) : 'NOT SET');
  if (!apiKey) {
    return NextResponse.json({ error: 'Image generation not configured' }, { status: 500 });
  }

  const prompt = `Flat 2D vector logo for F1 team called ${teamName.trim()}. Style: exactly like Alpine, Williams, McLaren, Haas or Red Bull Racing F1 team logos — flat corporate identity, white background, bold typography, simple geometric icon or lettermark, no gradients, no 3D effects, no photographs, no realistic rendering. Colors: Primary ${primaryColor ?? ''}, Secondary ${secondaryColor ?? ''}, Accent ${accentColor ?? ''}. Clean SVG-style flat design. Professional motorsport brand mark. Transparent background, no background, isolated logo on transparent background.`;

  console.log('[generate-logo] prompt:', prompt);

  // Step 1: Generate the logo
  const genForm = new FormData();
  genForm.append('prompt', prompt);
  genForm.append('output_format', 'png');
  genForm.append('aspect_ratio', '1:1');

  let imageBuffer: ArrayBuffer;

  try {
    console.log('[generate-logo] calling generate endpoint...');
    const genRes = await fetch(
      'https://api.stability.ai/v2beta/stable-image/generate/core',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'image/*',
        },
        body: genForm,
      },
    );

    console.log('[generate-logo] generate status:', genRes.status);
    console.log('[generate-logo] generate content-type:', genRes.headers.get('content-type'));

    if (!genRes.ok) {
      const errText = await genRes.text();
      console.error('[generate-logo] generate error body:', errText);
      return NextResponse.json(
        { error: `Image generation failed (${genRes.status})`, stabilityError: errText, step: 'generate' },
        { status: 502 },
      );
    }

    imageBuffer = await genRes.arrayBuffer();
    console.log('[generate-logo] generate success, buffer size:', imageBuffer.byteLength);
  } catch (err: any) {
    console.error('[generate-logo] generate fetch exception:', err?.message ?? err);
    return NextResponse.json({ error: 'Logo generation failed', detail: err?.message ?? String(err), step: 'generate' }, { status: 500 });
  }

  // Step 2: Remove background to get transparent PNG
  try {
    console.log('[generate-logo] calling remove-background endpoint...');
    const imageBlob = new Blob([imageBuffer], { type: 'image/png' });
    const bgForm = new FormData();
    bgForm.append('image', imageBlob, 'logo.png');
    bgForm.append('output_format', 'png');

    const bgRes = await fetch(
      'https://api.stability.ai/v2beta/stable-image/edit/remove-background',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'image/*',
        },
        body: bgForm,
      },
    );

    console.log('[generate-logo] remove-background status:', bgRes.status);
    console.log('[generate-logo] remove-background content-type:', bgRes.headers.get('content-type'));

    if (!bgRes.ok) {
      const errText = await bgRes.text();
      console.error('[generate-logo] remove-background error body:', errText);
      // Fall back to original image, but include the error detail in response
      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      return NextResponse.json({ imageBase64, bgRemovalError: errText, bgRemovalStatus: bgRes.status });
    }

    const transparentBuffer = await bgRes.arrayBuffer();
    console.log('[generate-logo] remove-background success, buffer size:', transparentBuffer.byteLength);
    const imageBase64 = Buffer.from(transparentBuffer).toString('base64');
    return NextResponse.json({ imageBase64 });
  } catch (err: any) {
    console.error('[generate-logo] remove-background fetch exception:', err?.message ?? err);
    // Fall back to original image
    const imageBase64 = Buffer.from(imageBuffer).toString('base64');
    return NextResponse.json({ imageBase64, bgRemovalError: err?.message ?? String(err) });
  }
}
