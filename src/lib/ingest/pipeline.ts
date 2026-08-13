import { getDb } from "@/lib/db/client";
import { insertChunks } from "@/lib/db/chunks";
import { EmbeddingQuotaError, embedBatched, getEmbeddingProvider } from "@/lib/models/embeddings";
import { hasLLM } from "@/lib/models/llm";
import { config } from "@/lib/config";
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
  /** Rate limit hit: the index is partially built and resumes on the next pass. */
  | { type: "partial"; repoId: string; chunks: number; retryAfterMs: number; message: string }
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

  // What model were the stored vectors produced with? Read this BEFORE the
  // upsert overwrites it.
  const prior = await db.query<{ embed_model: string | null }>(
    `SELECT embed_model FROM repos WHERE id = $1`,
    [id],
  );
  const priorModel = prior[0]?.embed_model ?? null;
  const modelChanged = priorModel !== null && priorModel !== provider.id;

  await db.query(
    `INSERT INTO repos (id, owner, name, ref, commit_sha, status, embed_model)
     VALUES ($1,$2,$3,$4,$5,'indexing',$6)
     ON CONFLICT (owner, name, ref)
     DO UPDATE SET status='indexing', commit_sha=$5, embed_model=$6, error=NULL`,
    [id, ref.owner, ref.name, resolved.ref, resolved.sha, provider.id],
  );

  // A provider switch invalidates every stored vector: the content is identical,
  // so the incremental path would reuse all of it and the ON CONFLICT DO NOTHING
  // insert would leave the old embeddings in place — while the repo now claims to
  // be indexed with the new model. The old chunks therefore have to go, but NOT
  // yet: deleting up front means a provider that refuses the very first embedding
  // call (quota, outage, bad key) destroys a working index and leaves nothing.
  // The delete happens in `flush`, once embeddings are actually in hand.
  let clearedForNewModel = !modelChanged;

  // Existing hashes → skip re-embedding unchanged chunks (incremental reindex).
  const existing = modelChanged
    ? []
    : await db.query<{ content_hash: string }>(
        `SELECT content_hash FROM chunks WHERE repo_id = $1`,
        [id],
      );
  const existingHashes = new Set(existing.map((r) => r.content_hash));
  const seenHashes = new Set<string>();

  let fileCount = 0;
  let tokens = 0;
  let reused = 0;
  const pending: EnrichedChunk[] = [];
  // Sized against the tightest provider limit we know of: Gemini's free tier
  // allows 100 embed requests per minute and counts each item in a batch
  // separately, so a pass gets ~one batch of this size through per minute.
  const BATCH = 96;

  // Set when a rate limit stops this pass; the caller resumes later. Held in an
  // object because it is assigned inside `flush`, and narrowing a plain `let`
  // does not survive the closure.
  const pause: { hit: { retryAfterMs: number; message: string } | null } = { hit: null };

  const flush = async function* () {
    if (pending.length === 0) return;
    const texts = pending.map((c) => c.embedText);
    yield { type: "embedding" as const, done: 0, total: pending.length };
    let vectors: number[][];
    try {
      vectors = await embedBatched(texts, BATCH);
    } catch (e) {
      if (e instanceof EmbeddingQuotaError) {
        // Not a failure: stop cleanly and leave `pending` unwritten. Everything
        // already inserted stays, and the next pass re-derives these same chunks
        // and embeds them then.
        pause.hit = { retryAfterMs: e.retryAfterMs, message: e.message };
        return;
      }
      throw e;
    }
    // Embedding succeeded, so the provider works — now it is safe to drop the
    // vectors from the previous model.
    if (!clearedForNewModel) {
      await db.query(`DELETE FROM chunks WHERE repo_id = $1`, [id]);
      clearedForNewModel = true;
    }
    await insertChunks(
      db,
      pending.map((c, i) => ({
        repoId: id,
        path: c.path,
        lang: c.lang,
        symbol: c.symbol,
        symbolKind: c.symbolKind,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        context: c.context,
        contentHash: c.contentHash,
        tokenCount: countTokens(c.embedText),
        embedding: vectors[i]!,
      })),
    );
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
        const enriched = await enrichChunk(chunk, slug, hasLLM && config.contextualLLM);
        tokens += countTokens(enriched.embedText);
        pending.push(enriched);
        if (pending.length >= BATCH) {
          yield* flush();
          if (pause.hit) break;
        }
      }
      if (pause.hit) break;
    }
    if (!pause.hit) yield* flush();

    if (pause.hit) {
      // Partial index: skip the prune (we never finished walking the repo, so
      // `seenHashes` would delete chunks that are simply further down the tree)
      // and leave the repo in 'indexing' so nothing queries a half-built index.
      const soFar = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chunks WHERE repo_id = $1`,
        [id],
      );
      const built = Number(soFar[0]?.n ?? 0);
      await db.query(
        `UPDATE repos SET status='indexing', file_count=$2, chunk_count=$3 WHERE id=$1`,
        [id, fileCount, built],
      );
      yield {
        type: "partial",
        repoId: id,
        chunks: built,
        retryAfterMs: pause.hit.retryAfterMs,
        message: pause.hit.message,
      };
      return;
    }

    // Prune chunks that no longer exist in the repo (deleted/renamed files).
    if (seenHashes.size > 0) {
      // Pass the kept hashes as ONE json parameter rather than N bind
      // placeholders. A large repo yields thousands of chunks, and a NOT IN with
      // thousands of placeholders both blows past sane statement sizes and, on
      // Neon's HTTP driver, ships every hash as a separate bound parameter.
      await db.query(
        `DELETE FROM chunks
          WHERE repo_id = $1
            AND content_hash NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`,
        [id, JSON.stringify([...seenHashes])],
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
    // Report the count that survived rather than leaving the pre-failure number
    // on screen — a half-written index must not look intact.
    const left = await db
      .query<{ n: string }>(`SELECT count(*)::text AS n FROM chunks WHERE repo_id = $1`, [id])
      .catch(() => [{ n: "0" }]);
    await db.query(
      `UPDATE repos SET status='error', error=$2, chunk_count=$3 WHERE id=$1`,
      [id, (e as Error).message.slice(0, 500), Number(left[0]?.n ?? 0)],
    );
    yield { type: "error", message: (e as Error).message };
  }
}
