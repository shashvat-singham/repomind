import { getDb } from "@/lib/db/client";
import { currentEmbedModelId } from "@/lib/config";
import { toSqlVector } from "@/lib/db/vector";
import { embedBatched } from "@/lib/models/embeddings";

/**
 * Semantic answer cache. Two users rarely phrase the same question identically,
 * so a string-equality cache barely hits. We instead embed the question and
 * reuse a previous answer when the nearest cached question is within a cosine
 * threshold — scoped per repo. This turns "what does the auth middleware do?"
 * and "explain the authentication middleware" into a single paid generation.
 *
 * The savings are real and measured: every hit is logged with cache_hit=true so
 * the observability panel can show deflected cost.
 */

const SIMILARITY_THRESHOLD = 0.92; // cosine; tuned to avoid false reuse

export interface CachedAnswer {
  answer: unknown;
  question: string;
  similarity: number;
}

export async function lookupCache(
  repoId: string,
  question: string,
): Promise<CachedAnswer | null> {
  const [vec] = await embedBatched([question], 1);
  const db = await getDb();
  const rows = await db.query<{
    question: string;
    answer_json: unknown;
    distance: number;
  }>(
    `SELECT question, answer_json, (embedding <=> $2::vector) AS distance
     FROM semantic_cache
     WHERE repo_id = $1 AND embed_model = $3
     ORDER BY embedding <=> $2::vector
     LIMIT 1`,
    [repoId, toSqlVector(vec!), currentEmbedModelId()],
  );
  const top = rows[0];
  if (!top) return null;
  const similarity = 1 - Number(top.distance);
  if (similarity < SIMILARITY_THRESHOLD) return null;

  await db.query(
    `UPDATE semantic_cache SET hits = hits + 1
     WHERE repo_id = $1 AND question = $2`,
    [repoId, top.question],
  );
  return {
    answer: typeof top.answer_json === "string" ? JSON.parse(top.answer_json) : top.answer_json,
    question: top.question,
    similarity,
  };
}

export async function storeCache(
  repoId: string,
  question: string,
  answer: unknown,
): Promise<void> {
  const [vec] = await embedBatched([question], 1);
  const db = await getDb();
  await db.query(
    `INSERT INTO semantic_cache (repo_id, question, embedding, answer_json, embed_model)
     VALUES ($1, $2, $3::vector, $4, $5)`,
    [repoId, question, toSqlVector(vec!), JSON.stringify(answer), currentEmbedModelId()],
  );
}
