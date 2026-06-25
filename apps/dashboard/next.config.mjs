/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard imports TypeScript source from the repo root (db/schema.ts,
  // src/positions/tracker.ts, src/prices, src/linker/assets, the read repos).
  // externalDir lets Next compile files that live outside apps/dashboard.
  experimental: {
    externalDir: true,
  },
  // bun:sqlite is a Bun built-in resolved at runtime (the dashboard runs under
  // `bun --bun run`); never trace/bundle it for the server build.
  serverExternalPackages: ['bun:sqlite'],
  eslint: {
    // Root `bun run check` runs project ESLint; the dashboard is not part of
    // the root tsc/eslint graph. Skip Next's own lint during build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
