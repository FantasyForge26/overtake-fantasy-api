import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';

const client = new Anthropic();

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { teamName } = await req.json();
  if (!teamName || typeof teamName !== 'string' || !teamName.trim()) {
    return NextResponse.json({ error: 'teamName is required' }, { status: 400 });
  }

  const prompt = `You are an expert SVG logo designer specialising in motorsport and F1 team branding.

Create a bold, professional SVG logo for an F1 team called "${teamName.trim()}".

Requirements:
- Return ONLY the raw SVG code — no markdown, no code fences, no explanation
- The SVG must be self-contained, viewBox="0 0 200 200", width="200" height="200"
- Use a dark background (fill="#0d0d0d" or similar)
- Use bold geometric shapes that evoke speed, precision, and high-tech F1 aesthetics
- Incorporate the team name or initials as text within the SVG
- Use a striking accent colour (cyan #00D1FF, red #FF2D2D, or green #A6FF00) for key design elements
- Keep the design clean and legible at small sizes
- Do not use external images or fonts — use SVG-native text with font-family="Arial, sans-serif"`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      return NextResponse.json({ error: 'Unexpected response from AI' }, { status: 500 });
    }

    // Strip any accidental markdown fences
    const svg = content.text
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    if (!svg.startsWith('<svg')) {
      return NextResponse.json({ error: 'AI did not return valid SVG' }, { status: 500 });
    }

    return NextResponse.json({ svg });
  } catch (err: any) {
    console.error('[generate-logo] Anthropic error:', err?.message ?? err);
    return NextResponse.json({ error: 'Logo generation failed' }, { status: 500 });
  }
}
