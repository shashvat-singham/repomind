import { getDb } from "@/lib/db/client";
import { hybridRetrieve, type RetrievedChunk } from "@/lib/retrieval/hybrid";
import { rerank } from "@/lib/retrieval/rerank";

/**
 * Repo capabilities, as plain functions over the database. Both the chat agent
 * (via AI SDK `tool()`) and the MCP server wrap these — one implementation, two
 * transports — so an MCP client in Cursor gets exactly what the web agent gets.
 */

export interface SearchHit {
  path: string;
  symbol: string | null;
  symbolKind: string | null;
  startLine: number;
  endLine: number;
  lang: string;
  score: number;
  snippet: string;
}

/** Semantic + lexical hybrid search, reranked. The agent's primary tool. */
export async function searchCode(
  repoId: string,
  query: string,
  k = 8,
  pathLike?: string,
): Promise<SearchHit[]> {
  const candidates = await hybridRetrieve({
    repoId,
    query,
    topK: Math.max(k * 3, 18),
    pathLike,
  });
  const ranked = await rerank(query, candidates, k);
  return ranked.map(toHit);
}

function toHit(c: RetrievedChunk & { score?: number }): SearchHit {
  return {
    path: c.path,
    symbol: c.symbol,
    symbolKind: c.symbolKind,
    startLine: c.startLine,
    endLine: c.endLine,
    lang: c.lang,
    score: Number((c.score ?? c.rrf).toFixed(4)),
    snippet: c.content.length > 1200 ? c.content.slice(0, 1200) + "\n…" : c.content,
  };
}

/** Read a file (optionally a line range) reconstructed from its chunks. */
export async function readFile(
  repoId: string,
  path: string,
  startLine?: number,
  endLine?: number,
): Promise<{ path: string; lang: string; content: string; found: boolean }> {
  const db = await getDb();
  const rows = await db.query<{
    lang: string;
    start_line: number;
    end_line: number;
    content: string;
  }>(
    `SELECT lang, start_line, end_line, content
     FROM chunks WHERE repo_id = $1 AND path = $2
     ORDER BY start_line ASC`,
    [repoId, path],
  );
  if (rows.length === 0) return { path, lang: "text", content: "", found: false };

  // Chunks can overlap (windowed symbols); stitch by line number, de-duplicating.
  const lines: string[] = [];
  for (const r of rows) {
    const parts = r.content.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const ln = Number(r.start_line) + i;
      lines[ln] = parts[i]!;
    }
  }
  let out = lines
    .map((l, i) => ({ l, i }))
    .filter((x) => x.l !== undefined);
  if (startLine !== undefined) out = out.filter((x) => x.i >= startLine);
  if (endLine !== undefined) out = out.filter((x) => x.i <= endLine);
  const content = out.map((x) => x.l).join("\n");
  return { path, lang: rows[0]!.lang, content, found: true };
}

/** List symbols (functions/classes/types) — optionally filtered by name. */
export async function listSymbols(
  repoId: string,
  nameLike?: string,
  limit = 50,
): Promise<{ path: string; symbol: string; kind: string; startLine: number }[]> {
  const db = await getDb();
  const params: unknown[] = [repoId];
  let where = `repo_id = $1 AND symbol IS NOT NULL`;
  if (nameLike) {
    params.push(`%${nameLike}%`);
    where += ` AND symbol ILIKE $2`;
  }
  params.push(limit);
  const rows = await db.query<{
    path: string;
    symbol: string;
    symbol_kind: string;
    start_line: number;
  }>(
    `SELECT path, symbol, symbol_kind, start_line
     FROM chunks WHERE ${where}
     ORDER BY symbol ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    path: r.path,
    symbol: r.symbol,
    kind: r.symbol_kind,
    startLine: Number(r.start_line),
  }));
}

/** High-level repo shape: languages, file count, biggest files. */
export async function repoStats(repoId: string): Promise<{
  files: number;
  chunks: number;
  languages: { lang: string; chunks: number }[];
  topFiles: { path: string; chunks: number }[];
}> {
  const db = await getDb();
  const [langs, files, totals] = await Promise.all([
    db.query<{ lang: string; n: string }>(
      `SELECT lang, count(*)::text AS n FROM chunks WHERE repo_id=$1
       GROUP BY lang ORDER BY count(*) DESC`,
      [repoId],
    ),
    db.query<{ path: string; n: string }>(
      `SELECT path, count(*)::text AS n FROM chunks WHERE repo_id=$1
       GROUP BY path ORDER BY count(*) DESC LIMIT 10`,
      [repoId],
    ),
    db.query<{ files: string; chunks: string }>(
      `SELECT count(DISTINCT path)::text AS files, count(*)::text AS chunks
       FROM chunks WHERE repo_id=$1`,
      [repoId],
    ),
  ]);
  return {
    files: Number(totals[0]?.files ?? 0),
    chunks: Number(totals[0]?.chunks ?? 0),
    languages: langs.map((l) => ({ lang: l.lang, chunks: Number(l.n) })),
    topFiles: files.map((f) => ({ path: f.path, chunks: Number(f.n) })),
  };
}

/**
 * Drop an indexed repo. Chunks go with it via the ON DELETE CASCADE on
 * `chunks.repo_id`; cached answers are removed explicitly because
 * `semantic_cache` has no foreign key, and an answer about a repo that no longer
 * exists is only a way to resurrect it. `query_log` rows are left alone on
 * purpose — they are the cost/latency history, not repo state.
 */
export async function deleteRepo(repoId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `DELETE FROM repos WHERE id = $1 RETURNING id`,
    [repoId],
  );
  if (rows.length === 0) return false;
  await db.query(`DELETE FROM semantic_cache WHERE repo_id = $1`, [repoId]);
  return true;
}

/** List all repos currently indexed (for the picker + MCP discovery). */
export async function listRepos(): Promise<
  { id: string; owner: string; name: string; ref: string; status: string; files: number; chunks: number; indexedAt: string | null; embedModel: string | null }[]
> {
  const db = await getDb();
  const rows = await db.query<{
    id: string; owner: string; name: string; ref: string; status: string;
    file_count: number; chunk_count: number; indexed_at: string | null;
    embed_model: string | null;
  }>(
    `SELECT id, owner, name, ref, status, file_count, chunk_count, indexed_at, embed_model
     FROM repos ORDER BY indexed_at DESC NULLS LAST, created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    owner: r.owner,
    name: r.name,
    ref: r.ref,
    status: r.status,
    files: Number(r.file_count),
    chunks: Number(r.chunk_count),
    indexedAt: r.indexed_at,
    embedModel: r.embed_model,
  }));
}
