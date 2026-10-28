import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolated verification servers must not replace the running workspace build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
