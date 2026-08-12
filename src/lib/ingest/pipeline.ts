import { getDb } from "@/lib/db/client";
import { toSqlVector } from "@/lib/db/vector";
import { embedBatched, getEmbeddingProvider } from "@/lib/models/embeddings";
import { hasLLM } from "@/lib/models/llm";
import { countTokens } from "@/lib/obs/tokens";
import { chunkFile } from "@/lib/ingest/chunker";
import { enrichChunk, type EnrichedChunk } from "@/lib/ingest/contextual";
import {
  parseRepoInput,
  resolveRef,
  streamRepoFiles,
  type RepoRef,
} from "@/lib/ingest/github";

/**
 * End-to-end ingestion: GitHub tarball → AST chunks → contextual enrichment →
 * embeddings → pgvector upsert. Emits progress events so the UI can render a
 * live trace. Incremental by content hash: re-ingesting a repo only embeds
 * chunks whose content actually changed, and prunes chunks that disappeared.
 */

export type IngestEvent =
  | { type: "resolving"; slug: string }
  | { type: "resolved"; ref: string; sha: string | null }
  | { type: "file"; path: string; fileCount: number }
  | { type: "chunking"; chunks: number }
  | { type: "embedding"; done: number; total: number }
  | { type: "upserting"; done: number; total: number }
  | { type: "done"; repoId: string; files: number; chunks: number; reused: number; tokens: number; ms: number }
  | { type: "error"; message: string };

export function repoId(ref: RepoRef, resolvedRef: string): string {
  return `${ref.owner}/${ref.name}@${resolvedRef}`.toLowerCase();
}

export async function* ingestRepo(input: string): AsyncGenerator<IngestEvent> {
  const started = Date.now();
  let ref: RepoRef;
  try {
    ref = parseRepoInput(input);
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
    return;
  }

  const slug = `${ref.owner}/${ref.name}`;
  yield { type: "resolving", slug };

  let resolved: { ref: string; sha: string | null };
  try {
    resolved = await resolveRef(ref);
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
    return;
  }
  yield { type: "resolved", ref: resolved.ref, sha: resolved.sha };

  const id = repoId(ref, resolved.ref);
  const db = await getDb();
  const provider = getEmbeddingProvider();

  await db.query(
    `INSERT INTO repos (id, owner, name, ref, commit_sha, status, embed_model)
     VALUES ($1,$2,$3,$4,$5,'indexing',$6)
     ON CONFLICT (owner, name, ref)
     DO UPDATE SET status='indexing', commit_sha=$5, embed_model=$6, error=NULL`,
    [id, ref.owner, ref.name, resolved.ref, resolved.sha, provider.id],
  );

  // Existing hashes → skip re-embedding unchanged chunks (incremental reindex).
  const existing = await db.query<{ content_hash: string }>(
    `SELECT content_hash FROM chunks WHERE repo_id = $1`,
    [id],
  );
  const existingHashes = new Set(existing.map((r) => r.content_hash));
  const seenHashes = new Set<string>();

  let fileCount = 0;
  let tokens = 0;
  let reused = 0;
  const pending: EnrichedChunk[] = [];
  const BATCH = 64;

  const flush = async function* () {
    if (pending.length === 0) return;
    const texts = pending.map((c) => c.embedText);
    yield { type: "embedding" as const, done: 0, total: pending.length };
    const vectors = await embedBatched(texts, 96);
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]!;
      const vec = vectors[i]!;
      await db.query(
        `INSERT INTO chunks
           (repo_id, path, lang, symbol, symbol_kind, start_line, end_line,
            content, context, content_hash, token_count, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)
         ON CONFLICT (repo_id, content_hash) DO NOTHING`,
        [
          id, c.path, c.lang, c.symbol, c.symbolKind, c.startLine, c.endLine,
          c.content, c.context, c.contentHash, countTokens(c.embedText),
          toSqlVector(vec),
        ],
      );
    }
    yield { type: "upserting" as const, done: pending.length, total: pending.length };
    pending.length = 0;
  };

  try {
    for await (const file of streamRepoFiles(ref, resolved.ref)) {
      fileCount++;
      yield { type: "file", path: file.path, fileCount };
      const chunks = chunkFile(file.path, file.content);
      for (const chunk of chunks) {
        seenHashes.add(chunk.contentHash);
        if (existingHashes.has(chunk.contentHash)) {
          reused++;
          continue; // unchanged since last ingest
        }
        const enriched = await enrichChunk(chunk, slug, hasLLM);
        tokens += countTokens(enriched.embedText);
        pending.push(enriched);
        if (pending.length >= BATCH) {
          yield* flush();
        }
      }
    }
    yield* flush();

    // Prune chunks that no longer exist in the repo (deleted/renamed files).
    if (seenHashes.size > 0) {
      const keep = [...seenHashes];
      // Delete in one statement using a NOT IN over the kept hashes.
      const placeholders = keep.map((_, i) => `$${i + 2}`).join(",");
      await db.query(
        `DELETE FROM chunks WHERE repo_id = $1 AND content_hash NOT IN (${placeholders})`,
        [id, ...keep],
      );
    }

    const countRow = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM chunks WHERE repo_id = $1`,
      [id],
    );
    const chunkCount = Number(countRow[0]?.n ?? 0);

    await db.query(
      `UPDATE repos SET status='ready', file_count=$2, chunk_count=$3, indexed_at=now()
       WHERE id = $1`,
      [id, fileCount, chunkCount],
    );

    yield {
      type: "done",
      repoId: id,
      files: fileCount,
      chunks: chunkCount,
      reused,
      tokens,
      ms: Date.now() - started,
    };
  } catch (e) {
    await db.query(`UPDATE repos SET status='error', error=$2 WHERE id=$1`, [
      id,
      (e as Error).message.slice(0, 500),
    ]);
    yield { type: "error", message: (e as Error).message };
  }
}
