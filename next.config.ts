// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  experimental: {
    optimizePackageImports: ["react", "react-dom"],
  },

  // ✅ Add these for smoother Firebase builds
  eslint: {
    ignoreDuringBuilds: true, // don't fail deployment on warnings
  },
  typescript: {
    ignoreBuildErrors: false, // keep type safety enforced
  },
};

export default nextConfig;
