import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed, retryAfterSec } = await checkRateLimit('auth', `login:${ip}`);
  if (!allowed) return rateLimitedResponse(retryAfterSec);

  const { email, password } = await req.json();

  if (typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  await connectDB();

  const user = await User.findOne({ email: email.toLowerCase() }).lean() as any;
  if (!user || !user.passwordHash) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  return NextResponse.json({
    userId: user._id.toString(),
    email:  user.email,
    name:   user.displayName,
    image:  user.avatarUrl ?? null,
  });
}
