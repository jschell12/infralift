import type { NextConfig } from "next";

// Where /api is proxied to, fixed at build time (the Dockerfile's
// API_BACKEND_URL build argument). Defaults to the local dev API.
const API_BACKEND = process.env.API_BACKEND_URL || "http://localhost:4000";

const nextConfig: NextConfig = {
  output: "standalone",
  // Assessments and migrations live under Projects now. The report and
  // options pages (/assessments/:id...) stay where they are; only the two
  // list pages moved.
  redirects: async () => [
    { source: "/assessments", destination: "/projects?start=existing", permanent: false },
    { source: "/migrations", destination: "/projects#migrations", permanent: false },
  ],
  rewrites: async () => [
    {
      source: "/api/:path*",
      destination: `${API_BACKEND}/:path*`,
    },
  ],
};

export default nextConfig;
