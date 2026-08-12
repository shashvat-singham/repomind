import { describe, it, expect } from "vitest";
import { localEmbed } from "@/lib/models/embeddings";
import { EMBED_DIM } from "@/lib/config";

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s; // inputs are L2-normalised
}

describe("localEmbed (hashing vectorizer)", () => {
  it("produces fixed-dimension, L2-normalised vectors", () => {
    const v = localEmbed("function getUserToken(id)");
    expect(v).toHaveLength(EMBED_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("is deterministic", () => {
    expect(localEmbed("hello world")).toEqual(localEmbed("hello world"));
  });

  it("ranks related code above unrelated code", () => {
    const q = localEmbed("how do we authenticate a user login");
    const relevant = localEmbed(
      "function login(username, password) { return authenticateUser(username, password); }",
    );
    const irrelevant = localEmbed(
      "const PI = 3.14159; function areaOfCircle(r) { return PI * r * r; }",
    );
    expect(cosine(q, relevant)).toBeGreaterThan(cosine(q, irrelevant));
  });

  it("gives sub-token robustness via char n-grams", () => {
    // shared identifier fragment should pull these together
    const a = localEmbed("getUserProfile");
    const b = localEmbed("updateUserProfile");
    const c = localEmbed("renderChart");
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});
