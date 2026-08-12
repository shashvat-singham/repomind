import { generateObject } from "ai";
import { z } from "zod";
import { getChatModel } from "@/lib/models/llm";
import type { RetrievedChunk } from "@/lib/retrieval/hybrid";

/**
 * Second-stage reranking. Hybrid retrieval casts a wide, cheap net; the reranker
 * then re-scores that small candidate set with a sharper signal and keeps the
 * best few. This is the standard retrieve-then-rerank pattern that lifts
 * precision@k without paying rerank cost over the whole corpus.
 *
 *  • With an LLM: a single structured call scores each candidate's relevance to
 *    the question 0–1 (listwise, so the model sees candidates in context).
 *  • Without an LLM: a lexical-overlap + symbol-match heuristic over the query,
 *    blended with the incoming RRF rank. Deterministic and dependency-free.
 */

export interface RerankedChunk extends RetrievedChunk {
  score: number;
}

export async function rerank(
  query: string,
  candidates: RetrievedChunk[],
  keep = 8,
): Promise<RerankedChunk[]> {
  if (candidates.length === 0) return [];
  const model = getChatModel();
  // Data-driven default: our eval shows RRF fusion order already beats either
  // single arm, and the local heuristic reranker is at best neutral over it. So
  // we only pay for reranking when a real LLM is available to add signal the
  // fusion doesn't have; otherwise we trust the fused ranking. (See evals/.)
  const scored = model
    ? await llmRerank(model, query, candidates)
    : fusionOrder(candidates);
  return scored.sort((a, b) => b.score - a.score).slice(0, keep);
}

/** Preserve the RRF fusion order, exposing rrf as the score. */
function fusionOrder(candidates: RetrievedChunk[]): RerankedChunk[] {
  return candidates.map((c) => ({ ...c, score: c.rrf }));
}

async function llmRerank(
  model: NonNullable<ReturnType<typeof getChatModel>>,
  query: string,
  candidates: RetrievedChunk[],
): Promise<RerankedChunk[]> {
  try {
    const list = candidates
      .map(
        (c, i) =>
          `[${i}] ${c.path}${c.symbol ? ` :: ${c.symbol}` : ""}\n${c.content.slice(0, 500)}`,
      )
      .join("\n\n");
    const { object } = await generateObject({
      model,
      temperature: 0,
      schema: z.object({
        scores: z.array(
          z.object({
            index: z.number(),
            relevance: z.number().min(0).max(1),
          }),
        ),
      }),
      system:
        "You rank code snippets by how directly they help answer a developer's question. Score each 0 (irrelevant) to 1 (directly answers). Judge the code, not its length.",
      prompt: `Question: ${query}\n\nSnippets:\n${list}\n\nReturn a relevance score for every index.`,
    });
    const byIndex = new Map(object.scores.map((s) => [s.index, s.relevance]));
    return candidates.map((c, i) => ({
      ...c,
      // Blend LLM judgement with the retrieval prior so a missing score can't
      // erase a strong hybrid hit.
      score: 0.8 * (byIndex.get(i) ?? 0) + 0.2 * normalizedRrf(c, candidates),
    }));
  } catch {
    return fusionOrder(candidates);
  }
}

function normalizedRrf(c: RetrievedChunk, all: RetrievedChunk[]): number {
  const max = Math.max(...all.map((x) => x.rrf), 1e-9);
  return c.rrf / max;
}
