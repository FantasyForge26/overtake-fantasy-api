import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed, retryAfterSec } = await checkRateLimit('auth', `register:${ip}`);
  if (!allowed) return rateLimitedResponse(retryAfterSec);

  const { email, password, displayName } = await req.json();

  if (typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }
  if (!displayName || !displayName.trim()) {
    return NextResponse.json({ error: 'Display name is required' }, { status: 400 });
  }

  await connectDB();

  const existing = await User.findOne({ email: email.toLowerCase() }).lean();
  if (existing) {
    return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    email: email.toLowerCase(),
    displayName: displayName.trim(),
    passwordHash,
  });

  return NextResponse.json({
    userId:      user._id.toString(),
    email:       user.email,
    name:        user.displayName,
  }, { status: 201 });
}
