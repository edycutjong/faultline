import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hunt reconciliation talks to the Nebius REST API on every request; nothing here
  // may be statically cached or the timeline freezes on the first poll.
  experimental: { proxyTimeout: 60_000 },
};

export default nextConfig;
