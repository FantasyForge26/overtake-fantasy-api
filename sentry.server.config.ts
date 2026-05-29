import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Performance Monitoring — 10% sample to stay within free-tier (10K spans/mo)
  tracesSampleRate: 0.1,

  // Vercel deployment metadata
  environment: process.env.VERCEL_ENV ?? 'development',
  release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),

  // No-op safely when DSN is not configured (e.g. local dev without env var)
  enabled: !!process.env.SENTRY_DSN,
});
