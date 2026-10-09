import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: "standalone",
  serverExternalPackages: ["@electric-sql/pglite"],
  async rewrites() {
    // mcp.nabikaran.org/ → the MCP route; /mcp and /.well-known/* already resolve on any host.
    const mcpHost = process.env.MCP_HOST;
    return mcpHost ? [{ source: "/", has: [{ type: "host", value: mcpHost }], destination: "/mcp" }] : [];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
