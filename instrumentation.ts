export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Forward Next.js request errors into Sentry. The hook name `onRequestError`
// is what Next.js looks for; @sentry/nextjs 10 exposes the handler as
// `captureRequestError`.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
