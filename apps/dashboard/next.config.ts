import type { NextConfig } from "next";

const API_BACKEND =
  process.env.API_BACKEND_URL ?? "http://10.0.0.2:30380";

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
