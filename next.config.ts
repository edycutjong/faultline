import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hunt reconciliation talks to the Nebius REST API on every request; nothing here
  // may be statically cached or the timeline freezes on the first poll.
  experimental: { proxyTimeout: 60_000 },
  // The recorded example is read from disk at request time; tell the tracer to ship it.
  outputFileTracingIncludes: { "/api/examples/recorded": ["./data/recorded-hunt.json"] },
  // The story page and the pitch deck are static single-file pages in public/; give them clean URLs.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/about", destination: "/landing/index.html" },
        { source: "/pitch", destination: "/pitch/index.html" },
      ],
    };
  },
};

export default nextConfig;
