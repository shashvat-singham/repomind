import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { config } from "@/lib/config";
import {
  searchCode,
  readFile,
  listSymbols,
  repoStats,
  listRepos,
} from "@/lib/agent/tools-core";

export const runtime = "nodejs";
export const maxDuration = 60;

/** MCP text tool-result, with the discriminant typed as a literal. */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * MCP server over Streamable HTTP. This exposes RepoMind's repo-intelligence
 * tools to ANY MCP client — Claude Desktop, Cursor, Windsurf — so a developer
 * can point their editor's agent at this deployment and get hybrid code search
 * over indexed repos without leaving their IDE. It reuses the exact same core
 * functions as the web agent (see tools-core.ts): one implementation, two
 * transports. That's the whole promise of MCP, demonstrated.
 *
 * Connect from Claude Desktop with:
 *   { "mcpServers": { "repomind": { "url": "https://<deployment>/api/mcp" } } }
 */

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_repos",
      {
        description: "List all repositories currently indexed in RepoMind, with their id, status, and size. Call this first to discover valid repoId values.",
        inputSchema: {},
      },
      async () => {
        const repos = await listRepos();
        return textResult(JSON.stringify(repos, null, 2));
      },
    );

    server.registerTool(
      "search_code",
      {
        description: "Hybrid semantic + lexical search over an indexed repository. Returns ranked code snippets with file paths and line numbers.",
        inputSchema: {
          repoId: z.string().describe("Repo id from list_repos, e.g. 'owner/name@main'."),
          query: z.string().describe("Natural-language or keyword search query."),
          k: z.number().min(1).max(15).default(8),
          pathLike: z.string().optional().describe("Optional path substring filter."),
        },
      },
      async ({ repoId, query, k, pathLike }) => {
        const hits = await searchCode(repoId, query, k, pathLike);
        return textResult(JSON.stringify(hits, null, 2));
      },
    );

    server.registerTool(
      "read_file",
      {
        description: "Read a file (or a line range) from an indexed repository, reconstructed from its chunks.",
        inputSchema: {
          repoId: z.string(),
          path: z.string(),
          startLine: z.number().optional(),
          endLine: z.number().optional(),
        },
      },
      async ({ repoId, path, startLine, endLine }) => {
        const file = await readFile(repoId, path, startLine, endLine);
        return textResult(file.found ? file.content : `File not found: ${path}`);
      },
    );

    server.registerTool(
      "list_symbols",
      {
        description: "List function/class/type definitions in an indexed repository, optionally filtered by a name substring.",
        inputSchema: {
          repoId: z.string(),
          nameLike: z.string().optional(),
          limit: z.number().min(1).max(100).default(40),
        },
      },
      async ({ repoId, nameLike, limit }) => {
        const symbols = await listSymbols(repoId, nameLike, limit);
        return textResult(JSON.stringify(symbols, null, 2));
      },
    );

    server.registerTool(
      "repo_stats",
      {
        description: "Get a high-level overview of an indexed repository: languages, file count, and largest files.",
        inputSchema: { repoId: z.string() },
      },
      async ({ repoId }) => {
        const stats = await repoStats(repoId);
        return textResult(JSON.stringify(stats, null, 2));
      },
    );
  },
  {
    serverInfo: { name: "repomind", version: "1.0.0" },
  },
);

// Optional bearer-token gate: if MCP_BEARER_TOKEN is set, require it; otherwise
// the endpoint is open for the public demo. Auth is enforced at the edge, not
// buried inside each tool.
const guarded = config.mcpBearerToken
  ? withMcpAuth(
      handler,
      async (_req, token) =>
        token === config.mcpBearerToken
          ? { token: token!, scopes: ["repo:read"], clientId: "bearer" }
          : undefined,
      { required: true },
    )
  : handler;

export { guarded as GET, guarded as POST, guarded as DELETE };
