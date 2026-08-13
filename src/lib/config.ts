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

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
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

  /** Google AI Studio key. Used when no OpenAI key is set. */
  geminiApiKey: str("GEMINI_API_KEY", str("GOOGLE_GENERATIVE_AI_API_KEY")),
  // gemini-2.5-* is still listed by the models endpoint but rejects new keys
  // ("no longer available to new users"), so the default is a current model that
  // was verified to accept function declarations.
  geminiChatModel: str("GEMINI_CHAT_MODEL", "gemini-3.1-flash-lite"),
  // gemini-embedding-001 is the only Gemini embedder that can emit 1536-d
  // vectors, which is what keeps the schema identical across providers.
  geminiEmbeddingModel: str("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001"),

  githubToken: str("GITHUB_TOKEN"),

  /**
   * LLM-generated contextual retrieval at ingest. Off by default even when a key
   * is present: it costs one sequential model call per chunk, so a 1,800-chunk
   * repo would need 1,800 round trips — hours of wall clock and instant free-tier
   * throttling, against a 60s function ceiling. The deterministic context
   * (path + symbol + extractive line) is what actually runs in the demo. Turn
   * this on only with a background/queued ingestion path.
   */
  contextualLLM: bool("CONTEXTUAL_LLM"),

  rateLimitRpm: int("RATE_LIMIT_RPM", 30),
  mcpBearerToken: str("MCP_BEARER_TOKEN"),

  /** When set, removing an indexed repo requires this as a bearer token. */
  adminToken: str("ADMIN_TOKEN"),

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

/** Gemini is the fallback provider: used only when OpenAI is not configured. */
export const usingGemini = !usingOpenAI && config.geminiApiKey.length > 0;

/**
 * Embedding dimension. We fix this at 1536 for both providers so a database
 * indexed in local mode stays compatible if you later add an OpenAI key:
 * text-embedding-3-small is natively 1536; the local model is generated at the
 * same width. This is a deliberate schema-stability decision.
 */
export const EMBED_DIM = 1536;

export type Mode = {
  db: "neon" | "pglite";
  models: "openai" | "gemini" | "local";
  /**
   * Id of the embedding provider currently in use. Vectors from different
   * providers live in different spaces, so a repo indexed under one and queried
   * under another returns nonsense — the UI compares this against each repo's
   * stored `embed_model` and refuses to answer on a mismatch.
   */
  embedModel: string;
  /**
   * True when the index is NOT shared across server instances: PGlite on a
   * multi-instance serverless host keeps its data in that instance's own /tmp,
   * so a repo indexed by one request can be invisible to the next. The UI
   * surfaces this, because otherwise a successful ingest silently disappears.
   * Local dev is single-process, so PGlite there is not ephemeral in this sense.
   */
  ephemeral: boolean;
};

export function currentMode(): Mode {
  return {
    db: usingCloudDb ? "neon" : "pglite",
    models: usingOpenAI ? "openai" : usingGemini ? "gemini" : "local",
    embedModel: currentEmbedModelId(),
    ephemeral: !usingCloudDb && Boolean(process.env.VERCEL),
  };
}

/** Kept here (not in the embeddings module) so client-facing config has no
 *  server-only imports. Must match `EmbeddingProvider.id`. */
export function currentEmbedModelId(): string {
  if (usingOpenAI) return config.embeddingModel;
  if (usingGemini) return config.geminiEmbeddingModel;
  return "local-hashing-vectorizer-1536";
}
