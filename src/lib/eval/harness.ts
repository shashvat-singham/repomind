import { getDb } from "@/lib/db/client";
import { toSqlVector } from "@/lib/db/vector";
import { embedBatched } from "@/lib/models/embeddings";
import { countTokens } from "@/lib/obs/tokens";
import { chunkFile } from "@/lib/ingest/chunker";
import { hybridRetrieve, type RetrievedChunk } from "@/lib/retrieval/hybrid";
import { rerank } from "@/lib/retrieval/rerank";
import {
  recallAtK, hitAtK, precisionAtK, reciprocalRank, ndcgAtK, mean,
  type AggregateMetrics,
} from "@/lib/eval/metrics";
import { FIXTURE_FILES } from "../../../evals/fixture-repo";
import { GOLDEN_SET, type GoldenCase } from "../../../evals/golden";

/**
 * The eval harness. Ingests the fixture into the DB, then for each golden case
 * runs retrieval and scores it. Crucially it evaluates THREE configurations —
 * dense-only, lexical-only, and the full hybrid+rerank pipeline — so the numbers
 * show *why* hybrid retrieval earns its complexity, not just that it works.
 */

const EVAL_REPO_ID = "eval/fixture@main";

export interface EvalConfig {
  name: string;
  retrieve: (query: string) => Promise<RetrievedChunk[]>;
}

export interface EvalReport {
  generatedAt: string;
  embeddingModel: string;
  backend: string;
  perConfig: { config: string; metrics: AggregateMetrics }[];
  perCase: {
    id: string;
    question: string;
    probes: string;
    hybridHit: boolean;
    hybridRR: number;
    topPath: string | null;
  }[];
}

async function ingestFixture(): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO repos (id, owner, name, ref, status) VALUES ($1,'eval','fixture','main','indexing')
     ON CONFLICT (owner, name, ref) DO UPDATE SET status='indexing'`,
    [EVAL_REPO_ID],
  );
  // Clean slate so metrics are reproducible run to run.
  await db.query(`DELETE FROM chunks WHERE repo_id=$1`, [EVAL_REPO_ID]);

  const chunks = Object.entries(FIXTURE_FILES).flatMap(([path, src]) => chunkFile(path, src));
  const embedText = chunks.map(
    (c) => `${c.path} ${c.symbol ?? ""} ${c.symbolKind ?? ""}\n${c.content}`,
  );
  const vectors = await embedBatched(embedText);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    await db.query(
      `INSERT INTO chunks
         (repo_id, path, lang, symbol, symbol_kind, start_line, end_line,
          content, context, content_hash, token_count, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)
       ON CONFLICT (repo_id, content_hash) DO NOTHING`,
      [
        EVAL_REPO_ID, c.path, c.lang, c.symbol, c.symbolKind, c.startLine,
        c.endLine, c.content, `In ${c.path}`, c.contentHash,
        countTokens(c.content), toSqlVector(vectors[i]!),
      ],
    );
  }
  await db.query(`UPDATE repos SET status='ready' WHERE id=$1`, [EVAL_REPO_ID]);
}

function relevanceFor(gc: GoldenCase) {
  return (hit: { path: string }) => gc.relevantPaths.includes(hit.path);
}

/**
 * The golden set is file-level, but retrieval returns multiple chunks per file.
 * Collapse the ranked list to first-occurrence-per-path before scoring so the IR
 * metrics are computed over distinct files (otherwise nDCG can exceed 1 because
 * DCG counts several relevant chunks while IDCG caps at the file count).
 */
function dedupeByPath(ranked: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  const out: RetrievedChunk[] = [];
  for (const r of ranked) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(r);
  }
  return out;
}

async function scoreConfig(cfg: EvalConfig): Promise<AggregateMetrics> {
  const recall5: number[] = [], recall10: number[] = [], hit5: number[] = [];
  const prec5: number[] = [], rr: number[] = [], ndcg10: number[] = [];
  for (const gc of GOLDEN_SET) {
    const ranked = dedupeByPath(await cfg.retrieve(gc.question));
    const isRel = relevanceFor(gc);
    const total = gc.relevantPaths.length;
    recall5.push(recallAtK(ranked, isRel, total, 5));
    recall10.push(recallAtK(ranked, isRel, total, 10));
    hit5.push(hitAtK(ranked, isRel, 5));
    prec5.push(precisionAtK(ranked, isRel, 5));
    rr.push(reciprocalRank(ranked, isRel));
    ndcg10.push(ndcgAtK(ranked, isRel, total, 10));
  }
  return {
    n: GOLDEN_SET.length,
    recallAt5: mean(recall5),
    recallAt10: mean(recall10),
    hitAt5: mean(hit5),
    precisionAt5: mean(prec5),
    mrr: mean(rr),
    ndcgAt10: mean(ndcg10),
  };
}

/** Dense-only retrieval, for the ablation baseline. */
async function denseOnly(query: string): Promise<RetrievedChunk[]> {
  const [vec] = await embedBatched([query], 1);
  const db = await getDb();
  const rows = await db.query<{ path: string; symbol: string | null }>(
    `SELECT path, symbol FROM chunks
     WHERE repo_id=$1 AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector LIMIT 10`,
    [EVAL_REPO_ID, toSqlVector(vec!)],
  );
  return rows.map((r, i) => padRow(r, i));
}

/** Lexical-only retrieval, for the ablation baseline. */
async function lexicalOnly(query: string): Promise<RetrievedChunk[]> {
  const terms = (query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((t) => t.length > 2).join(" | ");
  const db = await getDb();
  if (!terms) return [];
  const rows = await db.query<{ path: string; symbol: string | null }>(
    `SELECT c.path, c.symbol
     FROM chunks c, to_tsquery('english', $2) q
     WHERE c.repo_id=$1 AND c.tsv @@ q
     ORDER BY ts_rank_cd(c.tsv, q) DESC LIMIT 10`,
    [EVAL_REPO_ID, terms],
  );
  return rows.map((r, i) => padRow(r, i));
}

async function hybridReranked(query: string): Promise<RetrievedChunk[]> {
  const candidates = await hybridRetrieve({ repoId: EVAL_REPO_ID, query, topK: 18 });
  const ranked = await rerank(query, candidates, 10);
  return ranked;
}

function padRow(r: { path: string; symbol: string | null }, i: number): RetrievedChunk {
  return {
    id: i, path: r.path, lang: "typescript", symbol: r.symbol, symbolKind: null,
    startLine: 1, endLine: 1, content: "", context: "",
    rrf: 1 / (i + 1), denseRank: i + 1, lexRank: null,
  };
}

export async function runEval(): Promise<EvalReport> {
  await ingestFixture();
  const db = await getDb();

  const configs: EvalConfig[] = [
    { name: "dense-only", retrieve: denseOnly },
    { name: "lexical-only", retrieve: lexicalOnly },
    { name: "hybrid (RRF)", retrieve: hybridReranked },
  ];

  const perConfig: EvalReport["perConfig"] = [];
  for (const cfg of configs) {
    perConfig.push({ config: cfg.name, metrics: await scoreConfig(cfg) });
  }

  const perCase: EvalReport["perCase"] = [];
  for (const gc of GOLDEN_SET) {
    const ranked = dedupeByPath(await hybridReranked(gc.question));
    const isRel = relevanceFor(gc);
    perCase.push({
      id: gc.id,
      question: gc.question,
      probes: gc.probes,
      hybridHit: hitAtK(ranked, isRel, 5) === 1,
      hybridRR: reciprocalRank(ranked, isRel),
      topPath: ranked[0]?.path ?? null,
    });
  }

  const { EMBED_DIM } = await import("@/lib/config");
  return {
    generatedAt: new Date().toISOString(),
    embeddingModel: `${(await import("@/lib/models/embeddings")).getEmbeddingProvider().id} (${EMBED_DIM}d)`,
    backend: db.backend,
    perConfig,
    perCase,
  };
}
