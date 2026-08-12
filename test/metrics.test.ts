import { describe, it, expect } from "vitest";
import {
  recallAtK, hitAtK, precisionAtK, reciprocalRank, ndcgAtK, mean,
} from "@/lib/eval/metrics";

const rel = (paths: string[]) => (h: { path: string }) => paths.includes(h.path);
const rank = (...paths: string[]) => paths.map((p) => ({ path: p, symbol: null }));

describe("IR metrics", () => {
  const ranked = rank("a.ts", "b.ts", "c.ts", "d.ts", "e.ts");

  it("recall@k counts relevant found over total relevant, capped at 1", () => {
    expect(recallAtK(ranked, rel(["a.ts", "c.ts"]), 2, 5)).toBe(1);
    expect(recallAtK(ranked, rel(["a.ts", "z.ts"]), 2, 5)).toBe(0.5);
    expect(recallAtK(ranked, rel(["c.ts"]), 1, 2)).toBe(0); // c.ts is at rank 3
  });

  it("hit@k is 1 iff any relevant in top k", () => {
    expect(hitAtK(ranked, rel(["c.ts"]), 3)).toBe(1);
    expect(hitAtK(ranked, rel(["c.ts"]), 2)).toBe(0);
  });

  it("precision@k is relevant fraction of top k", () => {
    expect(precisionAtK(ranked, rel(["a.ts", "b.ts"]), 4)).toBe(0.5);
  });

  it("reciprocal rank is 1/(first relevant position)", () => {
    expect(reciprocalRank(ranked, rel(["b.ts"]))).toBeCloseTo(1 / 2);
    expect(reciprocalRank(ranked, rel(["z.ts"]))).toBe(0);
  });

  it("nDCG@k is 1 for a perfectly-ordered result and in [0,1]", () => {
    // both relevant items at the very top ⇒ ideal ordering ⇒ 1.0
    expect(ndcgAtK(rank("a.ts", "b.ts", "x.ts"), rel(["a.ts", "b.ts"]), 2, 10)).toBeCloseTo(1);
    const n = ndcgAtK(ranked, rel(["e.ts"]), 1, 10);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(1);
  });

  it("mean averages", () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5);
    expect(mean([])).toBe(0);
  });
});
