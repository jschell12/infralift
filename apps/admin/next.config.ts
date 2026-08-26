import type { NextConfig } from "next";

const API_BACKEND = process.env.API_BACKEND_URL ?? "http://10.0.0.2:30380";

const nextConfig: NextConfig = {
  output: "standalone",
  rewrites: async () => [
    {
      source: "/api/:path*",
      destination: `${API_BACKEND}/:path*`,
    },
  ],
};

export default nextConfig;
