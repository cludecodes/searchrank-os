import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite and Neon ship native/WASM binaries that must stay outside the bundler.
  serverExternalPackages: ["@electric-sql/pglite", "@neondatabase/serverless"],
  experimental: {
    // Route handlers are long-lived enough to keep a PGlite instance warm.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
