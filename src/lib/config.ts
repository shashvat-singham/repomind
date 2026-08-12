/**
 * Central runtime configuration. RepoMind is designed to boot with an empty
 * environment: when a capability's key is missing it degrades to a local,
 * deterministic implementation rather than throwing. This module is the single
 * place that decides which mode each subsystem runs in, so the rest of the code
 * never sprinkles `process.env.X ?? fallback` checks around.
 */

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  /** Neon/Postgres connection string. Empty ⇒ use in-process PGlite. */
  databaseUrl: str("DATABASE_URL"),

  openaiApiKey: str("OPENAI_API_KEY"),
  embeddingModel: str("EMBEDDING_MODEL", "text-embedding-3-small"),
  chatModel: str("CHAT_MODEL", "gpt-4o-mini"),

  githubToken: str("GITHUB_TOKEN"),

  rateLimitRpm: int("RATE_LIMIT_RPM", 30),
  mcpBearerToken: str("MCP_BEARER_TOKEN"),

  /**
   * Directory where PGlite persists when DATABASE_URL is unset. On Vercel the
   * project filesystem is read-only, but /tmp is writable (per warm instance),
   * so we default there in that environment. This lets the app boot and run on
   * Vercel with ZERO configuration; set DATABASE_URL (Neon) for durable,
   * cross-instance storage in real production.
   */
  pgliteDir: str("PGLITE_DIR", process.env.VERCEL ? "/tmp/repomind-pg" : ".repomind-data/pg"),
} as const;

/** True when a real cloud Postgres is configured. */
export const usingCloudDb = config.databaseUrl.length > 0;

/** True when a real OpenAI key is configured (enables embeddings + LLM). */
export const usingOpenAI = config.openaiApiKey.startsWith("sk-");

/**
 * Embedding dimension. We fix this at 1536 for both providers so a database
 * indexed in local mode stays compatible if you later add an OpenAI key:
 * text-embedding-3-small is natively 1536; the local model is generated at the
 * same width. This is a deliberate schema-stability decision.
 */
export const EMBED_DIM = 1536;

export type Mode = {
  db: "neon" | "pglite";
  models: "openai" | "local";
};

export function currentMode(): Mode {
  return {
    db: usingCloudDb ? "neon" : "pglite",
    models: usingOpenAI ? "openai" : "local",
  };
}
