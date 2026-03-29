import NextAuth, { type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models';

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: 'jwt',
  },
  cookies: {
    sessionToken: {
      name: 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: false,
      },
    },
  },
  callbacks: {
    async signIn({ profile }) {
      if (!profile?.email) return false;

      await connectDB();

      const existing = await User.findOne({ email: profile.email });
      if (!existing) {
        await User.create({
          email: profile.email,
          googleId: (profile as any).sub,
          displayName: profile.name,
          avatarUrl: (profile as any).picture,
        });
      }

      return true;
    },

    async jwt({ token, profile }) {
      if (profile?.email) {
        await connectDB();
        const user = await User.findOne({ email: profile.email }).select('_id email').lean();
        if (user) {
          token.id = (user._id as any).toString();
          token.email = user.email;
        }
      }
      return token;
    },

    async session({ session, token }) {
      const user = session.user as typeof session.user & { id?: string };
      if (token.id) {
        user.id = token.id as string;
      }
      if (token.email) {
        user.email = token.email;
      }
      return session;
    },
  },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
