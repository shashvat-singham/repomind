import type { Db } from "@/lib/db/client";
import { toSqlVector } from "@/lib/db/vector";

/**
 * Batched chunk insert, shared by the ingest pipeline and the demo seeder.
 *
 * Why batch: PGlite runs in-process, so a statement per chunk costs almost
 * nothing. Neon's HTTP driver charges a network round trip per statement, so the
 * same loop turns a 3,000-chunk repo into 3,000 round trips — far past the 60s
 * function ceiling. Folding many rows into one multi-row VALUES keeps ingestion
 * inside budget on Neon and is harmless (slightly faster) on PGlite.
 *
 * `ON CONFLICT DO NOTHING` also covers duplicates *within* a batch: unlike
 * DO UPDATE, it silently skips a row that collides with one inserted earlier in
 * the same statement.
 */

export interface ChunkRow {
  repoId: string;
  path: string;
  lang: string;
  symbol: string | null;
  symbolKind: string | null;
  startLine: number;
  endLine: number;
  content: string;
  context: string;
  contentHash: string;
  tokenCount: number;
  embedding: number[];
}

// 12 params per row; 40 rows ≈ 480 params, comfortably under Postgres' 65,535
// bind-parameter limit while keeping each HTTP body a sane size.
const ROWS_PER_STATEMENT = 40;

export async function insertChunks(db: Db, rows: ChunkRow[]): Promise<void> {
  for (let off = 0; off < rows.length; off += ROWS_PER_STATEMENT) {
    const batch = rows.slice(off, off + ROWS_PER_STATEMENT);
    const values: string[] = [];
    const params: unknown[] = [];
    for (const r of batch) {
      const n = params.length;
      values.push(
        `($${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},$${n + 6},` +
          `$${n + 7},$${n + 8},$${n + 9},$${n + 10},$${n + 11},$${n + 12}::vector)`,
      );
      params.push(
        r.repoId, r.path, r.lang, r.symbol, r.symbolKind, r.startLine,
        r.endLine, r.content, r.context, r.contentHash, r.tokenCount,
        toSqlVector(r.embedding),
      );
    }
    await db.query(
      `INSERT INTO chunks
         (repo_id, path, lang, symbol, symbol_kind, start_line, end_line,
          content, context, content_hash, token_count, embedding)
       VALUES ${values.join(",")}
       ON CONFLICT (repo_id, content_hash) DO NOTHING`,
      params,
    );
  }
}
