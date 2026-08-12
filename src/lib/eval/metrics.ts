/**
 * Standard information-retrieval metrics. These are what let RepoMind make a
 * falsifiable quality claim instead of "it seems to work" — and what the CI gate
 * checks so a change to chunking, fusion weights, or the embedding model can't
 * silently regress retrieval.
 *
 * A "relevant" result is judged by a matcher over (path, symbol); `ranked` is the
 * ordered list of retrieved items. All metrics take the ranked hits + the
 * relevance predicate so they're independent of the retrieval implementation.
 */

export interface Rankable {
  path: string;
  symbol: string | null;
}

export type Relevance<T extends Rankable> = (hit: T) => boolean;

/** Fraction of relevant items found within the top k. */
export function recallAtK<T extends Rankable>(
  ranked: T[],
  isRelevant: Relevance<T>,
  totalRelevant: number,
  k: number,
): number {
  if (totalRelevant <= 0) return 0;
  const found = ranked.slice(0, k).filter(isRelevant).length;
  return Math.min(1, found / totalRelevant);
}

/** Did at least one relevant item appear in the top k? (a.k.a. hit rate) */
export function hitAtK<T extends Rankable>(
  ranked: T[],
  isRelevant: Relevance<T>,
  k: number,
): number {
  return ranked.slice(0, k).some(isRelevant) ? 1 : 0;
}

/** Precision@k: fraction of the top k that are relevant. */
export function precisionAtK<T extends Rankable>(
  ranked: T[],
  isRelevant: Relevance<T>,
  k: number,
): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter(isRelevant).length / top.length;
}

/** Reciprocal rank of the first relevant item (0 if none). */
export function reciprocalRank<T extends Rankable>(
  ranked: T[],
  isRelevant: Relevance<T>,
): number {
  for (let i = 0; i < ranked.length; i++) {
    if (isRelevant(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Normalised Discounted Cumulative Gain@k with binary relevance. Rewards putting
 * relevant items higher, normalised against the ideal ordering so it's in [0,1].
 */
export function ndcgAtK<T extends Rankable>(
  ranked: T[],
  isRelevant: Relevance<T>,
  totalRelevant: number,
  k: number,
): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (isRelevant(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, totalRelevant); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

export interface AggregateMetrics {
  n: number;
  recallAt5: number;
  recallAt10: number;
  hitAt5: number;
  precisionAt5: number;
  mrr: number;
  ndcgAt10: number;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
