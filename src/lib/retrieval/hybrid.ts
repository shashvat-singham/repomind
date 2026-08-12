import { getDb } from "@/lib/db/client";
import { toSqlVector } from "@/lib/db/vector";
import { embedBatched } from "@/lib/models/embeddings";

/**
 * Hybrid retrieval: dense vector search AND lexical full-text search, fused with
 * Reciprocal Rank Fusion — all in one SQL statement.
 *
 * Why both? Dense embeddings capture meaning ("where do we check the password?")
 * but miss exact tokens (a specific error string, an env var name, a rare API).
 * Lexical BM25-style search nails exact tokens but misses paraphrase. RRF
 * combines their *rankings* (not their incomparable raw scores) so a result that
 * ranks decently in either list floats to the top — robust and parameter-light.
 *
 * Doing the fusion inside Postgres means one round trip and lets the query
 * planner use the HNSW and GIN indexes together, instead of pulling two result
 * sets to the app and merging them in JS.
 */

export interface RetrievedChunk {
  id: number;
  path: string;
  lang: string;
  symbol: string | null;
  symbolKind: string | null;
  startLine: number;
  endLine: number;
  content: string;
  context: string;
  rrf: number;
  denseRank: number | null;
  lexRank: number | null;
}

export interface RetrieveOptions {
  repoId: string;
  query: string;
  /** Final number of chunks to return. */
  topK?: number;
  /** How deep each of the two lists goes before fusion. */
  perList?: number;
  /** RRF damping constant; 60 is the value from the original RRF paper. */
  rrfK?: number;
  /** Optional path substring filter (for scoped agent searches). */
  pathLike?: string;
}

/**
 * Build an OR-joined tsquery from the question. Code search wants *recall* on
 * the lexical arm — any rare shared token (an error string, an API name, an env
 * var) should surface the chunk, and RRF fusion + reranking sort out precision.
 * AND-semantics (websearch_to_tsquery) is too strict here because code tokens
 * like `stripe.paymentIntents.create` don't split the way prose does. We also
 * split camelCase/dotted identifiers so `paymentIntents` contributes `payment`
 * and `intents` as separate OR terms. Returns "" when nothing usable remains.
 */
function toOrTsQuery(q: string): string {
  const rawTokens = q.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const expanded = new Set<string>();
  for (const tok of rawTokens) {
    if (tok.length < 2) continue;
    expanded.add(tok);
    // break snake_case and split embedded digits/words for extra recall
    for (const part of tok.split("_")) if (part.length >= 2) expanded.add(part);
  }
  // camelCase parts from the original text
  for (const m of q.match(/[A-Z]?[a-z]{2,}|[0-9]{2,}/g) ?? []) {
    expanded.add(m.toLowerCase());
  }
  const terms = [...expanded].slice(0, 40);
  return terms.join(" | ");
}

export async function hybridRetrieve(
  opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
  const { repoId, query } = opts;
  const topK = opts.topK ?? 12;
  const perList = opts.perList ?? 40;
  const rrfK = opts.rrfK ?? 60;

  const [vec] = await embedBatched([query], 1);
  const vecLiteral = toSqlVector(vec!);
  const ftsQuery = toOrTsQuery(query);

  const pathFilter = opts.pathLike ? "AND path ILIKE $7" : "";
  const params: unknown[] = [vecLiteral, repoId, perList, ftsQuery, rrfK, topK];
  if (opts.pathLike) params.push(`%${opts.pathLike}%`);

  // If FTS query is empty (all stopwords/punctuation), degrade to pure dense.
  const lexicalCte = ftsQuery
    ? `lexical AS (
         SELECT c.id,
                row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS rank
         FROM chunks c, to_tsquery('english', $4) q
         WHERE c.repo_id = $2 AND c.tsv @@ q ${pathFilter}
         ORDER BY ts_rank_cd(c.tsv, q) DESC
         LIMIT $3
       )`
    : `lexical AS (SELECT NULL::bigint AS id, NULL::bigint AS rank WHERE false)`;

  const sql = `
    WITH dense AS (
      SELECT c.id,
             row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
      FROM chunks c
      WHERE c.repo_id = $2 AND c.embedding IS NOT NULL ${pathFilter}
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3
    ),
    ${lexicalCte},
    fused AS (
      SELECT COALESCE(d.id, l.id) AS id,
             d.rank AS dense_rank,
             l.rank AS lex_rank,
             COALESCE(1.0 / ($5 + d.rank), 0) +
             COALESCE(1.0 / ($5 + l.rank), 0) AS rrf
      FROM dense d
      FULL OUTER JOIN lexical l ON d.id = l.id
    )
    SELECT c.id, c.path, c.lang, c.symbol, c.symbol_kind,
           c.start_line, c.end_line, c.content, c.context,
           f.rrf, f.dense_rank, f.lex_rank
    FROM fused f
    JOIN chunks c ON c.id = f.id
    ORDER BY f.rrf DESC
    LIMIT $6
  `;

  const db = await getDb();
  const rows = await db.query<RawRow>(sql, params);
  return rows.map(mapRow);
}

interface RawRow {
  id: number;
  path: string;
  lang: string;
  symbol: string | null;
  symbol_kind: string | null;
  start_line: number;
  end_line: number;
  content: string;
  context: string;
  rrf: number;
  dense_rank: number | null;
  lex_rank: number | null;
}

function mapRow(r: RawRow): RetrievedChunk {
  return {
    id: Number(r.id),
    path: r.path,
    lang: r.lang,
    symbol: r.symbol,
    symbolKind: r.symbol_kind,
    startLine: Number(r.start_line),
    endLine: Number(r.end_line),
    content: r.content,
    context: r.context,
    rrf: Number(r.rrf),
    denseRank: r.dense_rank === null ? null : Number(r.dense_rank),
    lexRank: r.lex_rank === null ? null : Number(r.lex_rank),
  };
}
