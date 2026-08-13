import { config, EMBED_DIM, usingGemini, usingOpenAI } from "@/lib/config";

/**
 * Embedding provider abstraction.
 *
 * Two implementations, chosen at runtime by {@link config}:
 *
 *  1. OpenAI `text-embedding-3-small` (1536-d) when an API key is present.
 *  2. A local, deterministic "hashing vectorizer" otherwise. It is NOT a neural
 *     model — it is the classic feature-hashing trick (a la scikit-learn's
 *     HashingVectorizer) over word unigrams/bigrams and character 3–5-grams,
 *     L2-normalised. That gives genuine lexical overlap signal (shared
 *     identifiers, substrings, camelCase parts) with zero dependencies and zero
 *     network, which is exactly what you want for a repo that must boot and pass
 *     CI with no secrets. Swapping in OpenAI is a one-env-var change and the
 *     schema/dimension stays identical.
 */

export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * A rate limit, not a failure. Ingestion treats this as "pause here and resume",
 * because the work already done is durable: chunks are keyed by content hash, so
 * a later pass re-embeds only what is still missing.
 */
export class EmbeddingQuotaError extends Error {
  readonly retryAfterMs: number;
  /**
   * Vectors produced before the limit was reached. They cost quota, so the
   * caller stores them rather than discarding the work and paying for it again.
   */
  readonly embedded: number[][];
  constructor(message: string, retryAfterMs: number, embedded: number[][] = []) {
    super(message);
    this.name = "EmbeddingQuotaError";
    this.retryAfterMs = retryAfterMs;
    this.embedded = embedded;
  }
}

/** Google returns `retryDelay: "56s"` in the error details; default to a minute. */
function parseRetryDelayMs(body: string): number {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  const seconds = m ? Number(m[1]) : 60;
  // Add a small margin — retrying exactly on the boundary tends to 429 again.
  return Math.ceil(seconds * 1000) + 3000;
}

// ── Local hashing vectorizer ────────────────────────────────────────────────

/** FNV-1a 32-bit — fast, stable, well-distributed for the hashing trick. */
function fnv1a(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Split code/text into normalised tokens, also breaking camelCase/snake_case. */
function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    out.push(t);
    // break identifiers into their parts so `getUserToken` overlaps `user`
    for (const part of t.split("_")) {
      if (part && part !== t) out.push(part);
    }
  }
  // camelCase splitting on the original text
  const camel = text.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g) ?? [];
  for (const c of camel) {
    const lc = c.toLowerCase();
    if (lc.length > 1) out.push(lc);
  }
  return out;
}

function charNGrams(token: string, min = 3, max = 5): string[] {
  const grams: string[] = [];
  const s = `^${token}$`;
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= s.length; i++) grams.push(s.slice(i, i + n));
  }
  return grams;
}

/**
 * Hash a single feature into the vector using the signed-hash trick: one hash
 * picks the bucket, one bit of a second hash picks the sign. Signed hashing
 * makes collisions cancel in expectation instead of always adding, which keeps
 * the approximation closer to a true bag-of-features dot product.
 */
function addFeature(vec: Float64Array, feature: string, weight: number): void {
  const h = fnv1a(feature);
  const bucket = h % vec.length;
  const sign = (h & 0x10000) === 0 ? 1 : -1;
  vec[bucket]! += sign * weight;
}

export function localEmbed(text: string, dim = EMBED_DIM): number[] {
  const vec = new Float64Array(dim);
  const tokens = tokenize(text);

  // word unigrams + bigrams
  for (let i = 0; i < tokens.length; i++) {
    addFeature(vec, `w:${tokens[i]}`, 1);
    if (i + 1 < tokens.length) addFeature(vec, `b:${tokens[i]}_${tokens[i + 1]}`, 0.6);
  }
  // character n-grams give sub-token robustness (typos, shared prefixes)
  for (const t of tokens) {
    if (t.length < 3) continue;
    for (const g of charNGrams(t)) addFeature(vec, `c:${g}`, 0.35);
  }

  // L2 normalise so cosine == dot product and lengths don't dominate.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = vec[i]! / norm;
  return out;
}

const localProvider: EmbeddingProvider = {
  id: "local-hashing-vectorizer-1536",
  dim: EMBED_DIM,
  async embed(texts) {
    return texts.map((t) => localEmbed(t));
  },
};

// ── OpenAI provider ─────────────────────────────────────────────────────────

const openaiProvider: EmbeddingProvider = {
  id: config.embeddingModel,
  dim: EMBED_DIM,
  async embed(texts) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: texts,
        dimensions: EMBED_DIM,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // Preserve input order — the API returns an index per row.
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  },
};

// ── Gemini provider ─────────────────────────────────────────────────────────

/**
 * `gemini-embedding-001` is natively 3072-d but accepts `outputDimensionality`,
 * so we ask for 1536 and keep the schema identical to the other providers.
 * Google only L2-normalises the full-width vectors — truncated ones come back
 * with a norm around 0.7 — so we normalise here. Cosine distance is
 * scale-invariant, but the local provider emits unit vectors and the reranker
 * treats scores as comparable, so keeping every provider on the unit sphere
 * avoids a subtle inconsistency.
 */
const GEMINI_MAX_INPUT_CHARS = 7500; // model caps input at 2048 tokens

const geminiProvider: EmbeddingProvider = {
  id: config.geminiEmbeddingModel,
  dim: EMBED_DIM,
  async embed(texts) {
    const model = `models/${config.geminiEmbeddingModel}`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents?key=${encodeURIComponent(config.geminiApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: texts.map((t) => ({
            model,
            content: { parts: [{ text: t.slice(0, GEMINI_MAX_INPUT_CHARS) }] },
            outputDimensionality: EMBED_DIM,
          })),
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      // Every item inside a batchEmbedContents call counts as one request against
      // the per-minute quota (100/min on the free tier), so a repo with more
      // chunks than that cannot be embedded inside a single function invocation.
      // Re-running converges: chunks already embedded under this model are reused
      // by content hash, so each attempt gets through another batch.
      if (res.status === 429) {
        throw new EmbeddingQuotaError(
          `Gemini embedding quota reached — 100 requests/minute on the free tier, ` +
            `one per chunk.`,
          parseRetryDelayMs(body),
        );
      }
      throw new Error(`Gemini embeddings failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { embeddings: { values: number[] }[] };
    // batchEmbedContents preserves request order, so no index sorting needed.
    return json.embeddings.map((e) => l2Normalise(e.values));
  },
};

function l2Normalise(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (usingOpenAI) return openaiProvider;
  if (usingGemini) return geminiProvider;
  return localProvider;
}

/** Smallest batch worth attempting before giving up and letting the caller wait. */
const MIN_BATCH = 8;

/**
 * Embed in batches to respect provider payload limits and keep memory bounded.
 *
 * Rate limits are a budget of requests per window, and a rejected call does not
 * spend any of it — so asking for 96 when 40 remain gets nothing, repeatedly,
 * while asking for 40 makes progress. On a quota response we halve the batch and
 * try again, down to {@link MIN_BATCH}; only when even that is refused do we
 * propagate, which is the signal for the caller to pause and resume later.
 */
export async function embedBatched(
  texts: string[],
  batchSize = 96,
): Promise<number[][]> {
  const provider = getEmbeddingProvider();
  const out: number[][] = [];
  let size = batchSize;
  let i = 0;
  while (i < texts.length) {
    const batch = texts.slice(i, i + size);
    try {
      const vecs = await provider.embed(batch);
      out.push(...vecs);
      i += batch.length;
    } catch (e) {
      if (e instanceof EmbeddingQuotaError) {
        if (size > MIN_BATCH) {
          size = Math.max(MIN_BATCH, Math.floor(size / 2));
          continue;
        }
        // Out of budget. Hand back what was embedded so it can be persisted.
        throw new EmbeddingQuotaError(e.message, e.retryAfterMs, out);
      }
      throw e;
    }
  }
  return out;
}
