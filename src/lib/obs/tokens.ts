import { encode } from "gpt-tokenizer";

/**
 * Token accounting + cost estimation. We meter every LLM/embedding call so the
 * observability panel can show real $ spend, and so the semantic cache can prove
 * its savings. Prices are per 1M tokens (USD), matching public list prices for
 * the default models; override via the map if you change models.
 */

export function countTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    // Fallback heuristic (~4 chars/token) if the tokenizer trips on odd input.
    return Math.ceil(text.length / 4);
  }
}

const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "text-embedding-3-small": { in: 0.02, out: 0 },
  "text-embedding-3-large": { in: 0.13, out: 0 },
  // Local models cost nothing.
  "local-hashing-vectorizer-1536": { in: 0, out: 0 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut = 0): number {
  const p = PRICES[model] ?? { in: 0, out: 0 };
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
