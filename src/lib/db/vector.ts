/**
 * pgvector accepts a bracketed literal like `[0.1,0.2,0.3]`. We pass embeddings
 * as this string and cast with `::vector` in SQL, which works identically on
 * PGlite and Neon and avoids driver-specific array binding quirks.
 */
export function toSqlVector(embedding: number[]): string {
  // Trim float precision to keep row size and index build time reasonable;
  // 6 significant digits is well within cosine-similarity tolerance.
  let out = "[";
  for (let i = 0; i < embedding.length; i++) {
    if (i > 0) out += ",";
    out += (embedding[i] ?? 0).toPrecision(6);
  }
  return out + "]";
}
