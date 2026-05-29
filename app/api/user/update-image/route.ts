import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

// 1 MB raw image cap. Generous for an avatar — JPEG at 80% quality, 1024×1024
// is usually well under 500 KB. Critical: MongoDB's BSON limit is 16 MB per
// document, so an unbounded upload here could corrupt the entire User doc
// (avatar + everything else) the moment the save exceeded that ceiling.
const MAX_RAW_IMAGE_BYTES = 1_000_000;
// base64 expands ~4/3, plus padding + small safety margin.
const MAX_BASE64_LEN = Math.ceil(MAX_RAW_IMAGE_BYTES * 1.4);

// MIME whitelist. HEIC/HEIF intentionally excluded — verifying their magic
// numbers is fiddly (multiple sub-types) and mobile clients can convert to
// JPEG via expo-image-picker before upload.
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Verifies the decoded bytes begin with the magic number for the claimed
 * MIME type. Without this, a client could send mimeType='image/png' but
 * actual bytes for an HTML/JS payload and we'd persist it as a data: URL
 * that other clients later render.
 *
 * Magic numbers:
 *   JPEG: FF D8 FF
 *   PNG : 89 50 4E 47 0D 0A 1A 0A
 *   WebP: bytes 0-3 = 'RIFF', bytes 8-11 = 'WEBP'
 */
function magicMatchesMime(bytes: Buffer, mime: string): boolean {
  if (bytes.length < 12) return false;
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === 'image/png') {
    return (
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    );
  }
  if (mime === 'image/webp') {
    return (
      bytes.slice(0, 4).toString('ascii') === 'RIFF' &&
      bytes.slice(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 'expensive' preset (5/min per user). Each call writes a sizeable payload
  // to Mongo; without a limit a script could thrash the User collection.
  const rl = await checkRateLimit('expensive', `update-image:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const body = await req.json().catch(() => ({}));
  const { imageBase64, mimeType } = body;

  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    return NextResponse.json({ error: 'imageBase64 is required' }, { status: 400 });
  }

  // Default to JPEG (legacy behavior) but require it be in the whitelist.
  const mime = (typeof mimeType === 'string' && mimeType.length > 0)
    ? mimeType.toLowerCase()
    : 'image/jpeg';

  if (!ALLOWED_MIMES.has(mime)) {
    return NextResponse.json(
      { error: 'Unsupported image type. Use JPEG, PNG, or WebP.' },
      { status: 400 },
    );
  }

  // Cheap length-based rejection before we spend cycles decoding.
  if (imageBase64.length > MAX_BASE64_LEN) {
    return NextResponse.json(
      { error: `Image too large. Maximum ${Math.round(MAX_RAW_IMAGE_BYTES / 1024)} KB.` },
      { status: 413 },
    );
  }

  // Strip any whitespace clients may have introduced (line breaks etc.) then
  // validate it's pure base64 — protects against stray quotes / injection
  // attempts and ensures decoding won't throw.
  const cleaned = imageBase64.replace(/\s+/g, '');
  if (!BASE64_RE.test(cleaned)) {
    return NextResponse.json({ error: 'Invalid base64 payload' }, { status: 400 });
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(cleaned, 'base64');
  } catch {
    return NextResponse.json({ error: 'Invalid base64 payload' }, { status: 400 });
  }

  if (bytes.length === 0) {
    return NextResponse.json({ error: 'Empty image payload' }, { status: 400 });
  }
  if (bytes.length > MAX_RAW_IMAGE_BYTES) {
    return NextResponse.json(
      { error: `Image too large. Maximum ${Math.round(MAX_RAW_IMAGE_BYTES / 1024)} KB.` },
      { status: 413 },
    );
  }

  // Magic-number verification — defends against MIME spoofing where a client
  // claims one type but sends bytes for another (e.g. arbitrary HTML/JS).
  if (!magicMatchesMime(bytes, mime)) {
    return NextResponse.json(
      { error: 'Image bytes do not match declared type' },
      { status: 400 },
    );
  }

  const imageUrl = `data:${mime};base64,${cleaned}`;

  await connectDB();
  await User.findByIdAndUpdate(userId, { avatarUrl: imageUrl });

  return NextResponse.json({ imageUrl });
}
