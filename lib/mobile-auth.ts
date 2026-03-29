import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models';

export async function getMobileSession(request: NextRequest) {
  const userId = request.headers.get('x-user-id');
  if (!userId) return null;

  await connectDB();

  const user = await User.findById(userId).select('_id email displayName').lean() as {
    _id: { toString(): string };
    email: string;
    displayName: string;
  } | null;

  if (!user) return null;

  return {
    user: {
      id: user._id.toString(),
      email: user.email,
      displayName: user.displayName,
    },
  };
}
