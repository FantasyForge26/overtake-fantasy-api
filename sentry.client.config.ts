import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: 0.1,

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7),

  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});
