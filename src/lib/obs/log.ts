import { getDb } from "@/lib/db/client";

/** Persist one answered-question record for the live observability panel. */
export async function logQuery(row: {
  repoId: string;
  question: string;
  mode: string;
  latencyMs: number;
  retrieveMs: number;
  generateMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cacheHit: boolean;
  nRetrieved: number;
  injection: boolean;
}): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO query_log
        (repo_id, question, mode, latency_ms, retrieve_ms, generate_ms,
         tokens_in, tokens_out, cost_usd, cache_hit, n_retrieved, injection)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.repoId, row.question.slice(0, 500), row.mode, row.latencyMs,
        row.retrieveMs, row.generateMs, row.tokensIn, row.tokensOut,
        row.costUsd, row.cacheHit, row.nRetrieved, row.injection,
      ],
    );
  } catch {
    // Never let telemetry break a request.
  }
}

export interface ObsSummary {
  totalQueries: number;
  cacheHits: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  costSavedUsd: number;
  injectionsBlocked: number;
  recent: {
    question: string;
    mode: string;
    latencyMs: number;
    costUsd: number;
    cacheHit: boolean;
    createdAt: string;
  }[];
}

export async function getObsSummary(): Promise<ObsSummary> {
  const db = await getDb();
  const agg = await db.query<{
    total: string; hits: string; avg_latency: string;
    total_cost: string; injections: string;
  }>(
    `SELECT count(*)::text AS total,
            sum(CASE WHEN cache_hit THEN 1 ELSE 0 END)::text AS hits,
            COALESCE(avg(latency_ms),0)::text AS avg_latency,
            COALESCE(sum(cost_usd),0)::text AS total_cost,
            sum(CASE WHEN injection THEN 1 ELSE 0 END)::text AS injections
     FROM query_log`,
  );
  // p95 latency; PGlite supports percentile_cont.
  const p95 = await db.query<{ p95: string | null }>(
    `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::text AS p95 FROM query_log`,
  ).catch(() => [{ p95: null }]);

  // Cost the cache hits WOULD have incurred at the average non-cached cost.
  const saved = await db.query<{ saved: string }>(
    `SELECT COALESCE(
        (SELECT avg(cost_usd) FROM query_log WHERE NOT cache_hit AND cost_usd > 0) *
        (SELECT count(*) FROM query_log WHERE cache_hit), 0)::text AS saved`,
  ).catch(() => [{ saved: "0" }]);

  const recent = await db.query<{
    question: string; mode: string; latency_ms: number;
    cost_usd: number; cache_hit: boolean; created_at: string;
  }>(
    `SELECT question, mode, latency_ms, cost_usd, cache_hit, created_at
     FROM query_log ORDER BY created_at DESC LIMIT 12`,
  );

  const total = Number(agg[0]?.total ?? 0);
  const hits = Number(agg[0]?.hits ?? 0);
  return {
    totalQueries: total,
    cacheHits: hits,
    cacheHitRate: total > 0 ? hits / total : 0,
    avgLatencyMs: Math.round(Number(agg[0]?.avg_latency ?? 0)),
    p95LatencyMs: Math.round(Number(p95[0]?.p95 ?? 0)),
    totalCostUsd: Number(agg[0]?.total_cost ?? 0),
    costSavedUsd: Number(saved[0]?.saved ?? 0),
    injectionsBlocked: Number(agg[0]?.injections ?? 0),
    recent: recent.map((r) => ({
      question: r.question,
      mode: r.mode,
      latencyMs: Number(r.latency_ms),
      costUsd: Number(r.cost_usd),
      cacheHit: r.cache_hit,
      createdAt: r.created_at,
    })),
  };
}
