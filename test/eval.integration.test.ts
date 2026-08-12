import { describe, it, expect } from "vitest";
import { runEval } from "@/lib/eval/harness";

/**
 * Guards the central quality claim of the project: hybrid RRF retrieval beats
 * both single-arm baselines, and every golden question surfaces a relevant file.
 * If a change to chunking, fusion, or embeddings regresses this, the suite fails.
 */
describe("retrieval eval on the fixture repo", () => {
  it("hybrid meets the quality floor and beats single-arm baselines", async () => {
    const report = await runEval();
    const by = Object.fromEntries(report.perConfig.map((c) => [c.config, c.metrics]));

    const hybrid = by["hybrid (RRF)"]!;
    const dense = by["dense-only"]!;
    const lexical = by["lexical-only"]!;

    // Absolute floor (also enforced by the CI gate in scripts/run-evals.ts).
    expect(hybrid.recallAt5).toBeGreaterThanOrEqual(0.75);
    expect(hybrid.mrr).toBeGreaterThanOrEqual(0.6);
    expect(hybrid.ndcgAt10).toBeGreaterThanOrEqual(0.65);

    // Hybrid should not be worse than either arm on MRR — the whole thesis.
    expect(hybrid.mrr).toBeGreaterThanOrEqual(dense.mrr - 1e-9);
    expect(hybrid.mrr).toBeGreaterThanOrEqual(lexical.mrr - 1e-9);

    // Every question retrieves a relevant file in the top 5.
    expect(report.perCase.every((c) => c.hybridHit)).toBe(true);
  }, 60_000);
});
