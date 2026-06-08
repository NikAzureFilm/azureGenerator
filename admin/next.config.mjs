import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The repo root also has a lockfile (the Vite app); pin tracing to this app
  // so Vercel bundles the right files.
  outputFileTracingRoot: __dirname,
  // The admin app reads no data at build time; everything is dynamic + auth-gated.
  experimental: {
    // keep server-only secrets (service role, stripe) out of any client bundle
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
