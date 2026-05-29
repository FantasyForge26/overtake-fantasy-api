import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  tracesSampleRate: 0.1,

  environment: process.env.VERCEL_ENV ?? 'development',
  release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),

  enabled: !!process.env.SENTRY_DSN,
});
