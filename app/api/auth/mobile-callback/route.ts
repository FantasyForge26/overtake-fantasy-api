import { createHmac } from 'crypto';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';

function createSignedToken(userId: string, email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, email, exp: Math.floor(Date.now() / 1000) + 300 })
  ).toString('base64url');

  const sig = createHmac('sha256', process.env.NEXTAUTH_SECRET!)
    .update(payload)
    .digest('base64url');

  return `${payload}.${sig}`;
}

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect('/api/auth/signin');
  }

  const { id, email, name, image } = session.user as {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
  };

  createSignedToken(id, email);

  const params = new URLSearchParams({
    userId: id,
    email: email,
    ...(name ? { name } : {}),
    ...(image ? { image } : {}),
  });

  redirect(`overtakefantasy://auth?${params.toString()}`);
}
