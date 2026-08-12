import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a wasm bundle + Node bindings we only touch on the server.
  // Keep it external so the client bundle stays lean and the wasm resolves at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    // Larger bodies for repo ingestion payloads on server actions / route handlers.
    serverActions: { bodySizeLimit: "8mb" },
  },
  async headers() {
    return [
      {
        // The MCP endpoint is meant to be called cross-origin by MCP clients.
        source: "/api/mcp",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, mcp-session-id" },
        ],
      },
    ];
  },
};

export default nextConfig;
