import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { config, usingOpenAI } from "@/lib/config";

/**
 * Generation layer. When an OpenAI key is present we return a real AI SDK
 * language model (used for the agentic tool loop, contextual-retrieval
 * enrichment, reranking and LLM-judge evals). Without a key, callers fall back
 * to the deterministic, extractive helpers below so every feature still has a
 * working — if simpler — implementation.
 */

let cached: LanguageModel | null | undefined;

export function getChatModel(): LanguageModel | null {
  if (cached !== undefined) return cached;
  if (!usingOpenAI) {
    cached = null;
    return null;
  }
  const openai = createOpenAI({ apiKey: config.openaiApiKey });
  cached = openai(config.chatModel);
  return cached;
}

export const hasLLM = usingOpenAI;

/**
 * Deterministic extractive summariser used as the local fallback for
 * contextual-retrieval enrichment and answer synthesis. It scores sentences by
 * overlap with a query/anchor and returns the top ones. Not clever, but honest:
 * it never hallucinates because every output token comes from the source.
 */
export function extractiveSummary(
  text: string,
  anchor: string,
  maxSentences = 2,
): string {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return text.trim();
  const anchorTerms = new Set(terms(anchor));
  const scored = sentences.map((s, i) => {
    const t = terms(s);
    let overlap = 0;
    for (const w of t) if (anchorTerms.has(w)) overlap++;
    // small positional prior: earlier sentences are usually more definitional
    const positional = 1 / (1 + i * 0.15);
    return { s, score: overlap + positional, i };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s.trim())
    .join(" ");
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 2);
}
