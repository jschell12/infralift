import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Marketing site + docs are fully static (docs are SSG from repo-root
  // markdown at build time) — export for Cloudflare Workers static assets.
  output: "export",
};

export default nextConfig;
