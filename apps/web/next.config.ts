import type { NextConfig } from "next";

const apiOrigin = process.env.VSO_API_ORIGIN ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${apiOrigin}/v1/:path*` },
      { source: "/api/auth/:path*", destination: `${apiOrigin}/api/auth/:path*` },
    ];
  },
};

export default nextConfig;
