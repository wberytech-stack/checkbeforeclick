import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Gate 006B: emit .next/standalone (server.js + traced node_modules) for the
  // Azure Container Apps image. Vercel builds use their own output handling.
  output: "standalone",
};

export default nextConfig;
