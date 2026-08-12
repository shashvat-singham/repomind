/** Shared client/server DTOs. Kept dependency-free so client components can
 *  import them without pulling server-only modules. */

export interface Citation {
  path: string;
  symbol: string | null;
  symbolKind: string | null;
  startLine: number;
  endLine: number;
  lang: string;
  score: number;
  snippet: string;
}

export type ChatEvent =
  | { type: "status"; stage: "cache" | "retrieving" | "reranking" | "generating"; detail?: string }
  | { type: "trace"; tool: string; args: Record<string, unknown>; resultCount?: number }
  | { type: "token"; text: string }
  | { type: "citations"; items: Citation[] }
  | { type: "done"; answer: string; usage: Usage }
  | { type: "error"; message: string };

export interface Usage {
  mode: "openai" | "local";
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  retrieveMs: number;
  generateMs: number;
  totalMs: number;
}

export type IngestEvent =
  | { type: "resolving"; slug: string }
  | { type: "resolved"; ref: string; sha: string | null }
  | { type: "file"; path: string; fileCount: number }
  | { type: "chunking"; chunks: number }
  | { type: "embedding"; done: number; total: number }
  | { type: "upserting"; done: number; total: number }
  | { type: "done"; repoId: string; files: number; chunks: number; reused: number; tokens: number; ms: number }
  | { type: "error"; message: string };

export interface RepoInfo {
  id: string;
  owner: string;
  name: string;
  ref: string;
  status: string;
  files: number;
  chunks: number;
  indexedAt: string | null;
}

export interface Mode {
  db: "neon" | "pglite";
  models: "openai" | "local";
}
