import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
};

export default withSentryConfig(nextConfig, {
  // Source map upload config — only runs at build time when SENTRY_AUTH_TOKEN is set
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress source map upload logs in CI/build output
  silent: !process.env.CI,

  // Source maps: skip upload entirely when auth token is missing (keeps local
  // builds fast), and delete after upload so they're never served publicly.
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },

  // Disable Sentry's automatic instrumentation of console.log etc
  disableLogger: true,
});
