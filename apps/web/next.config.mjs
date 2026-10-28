import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load configuration from the repository root.
 *
 * Next reads `.env` relative to its own directory, which in a monorepo is
 * `apps/web`. The documented setup is `cp .env.example .env` at the root, so
 * without this the one-command install silently runs with no APP_SECRET and
 * writes its database somewhere unexpected. Both are corrected here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

for (const file of [".env", ".env.local"]) {
  const path = resolve(repoRoot, file);
  if (!existsSync(path)) continue;
  try {
    // Values already in the environment win, so `AI_BRAIN_DB=… pnpm dev`
    // still overrides the file.
    process.loadEnvFile(path);
  } catch {
    // An unreadable or malformed .env must not stop the server from booting;
    // the app reports missing configuration in its own UI.
  }
}

// A relative database path should mean "relative to the repository", not
// "relative to apps/web".
if (process.env.AI_BRAIN_DB && !isAbsolute(process.env.AI_BRAIN_DB)) {
  process.env.AI_BRAIN_DB = resolve(repoRoot, process.env.AI_BRAIN_DB);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The core package ships TypeScript source with .ts import specifiers, so
  // Next compiles it rather than expecting a built artifact.
  transpilePackages: ["@ai-brain/core"],
  experimental: {
    // Server Actions receive form posts from the same origin only.
    serverActions: { bodySizeLimit: "8mb" },
  },
  // A self-hosted personal data system should not phone home.
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next injects inline bootstrap scripts; 'unsafe-inline' is
              // required for them and is the documented trade-off.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https://avatars.githubusercontent.com",
              "font-src 'self' data:",
              // No third-party endpoints: everything is same-origin.
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
