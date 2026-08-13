import type { Db } from "@/lib/db/client";
import { insertChunks } from "@/lib/db/chunks";
import { embedBatched } from "@/lib/models/embeddings";
import { countTokens } from "@/lib/obs/tokens";
import { chunkFile } from "@/lib/ingest/chunker";
import { FIXTURE_FILES } from "../../../evals/fixture-repo";

/**
 * Seed-on-boot for a ready-to-query demo repository.
 *
 * On Vercel without a shared Postgres (DATABASE_URL unset), PGlite lives in each
 * instance's ephemeral /tmp — so a repo you ingest on one instance isn't visible
 * to a chat request routed to another. Rather than let the demo look empty, every
 * instance seeds an identical, realistic demo codebase on first boot. Because the
 * local embedding is deterministic, all instances produce the same index with no
 * network and no keys. Ingesting real repos still works within an instance; this
 * just guarantees there's always something to ask about immediately.
 *
 * With a real DATABASE_URL (Neon) this runs once and is shared, as normal.
 */

const DEMO_REPO_ID = "demo/acme-service@main";

export async function seedDemoRepo(db: Db): Promise<void> {
  const existing = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM chunks WHERE repo_id = $1`,
    [DEMO_REPO_ID],
  );
  if (Number(existing[0]?.n ?? 0) > 0) return; // already seeded

  await db.query(
    `INSERT INTO repos (id, owner, name, ref, status, embed_model)
     VALUES ($1,'demo','acme-service','main','indexing','local')
     ON CONFLICT (owner, name, ref) DO UPDATE SET status='indexing'`,
    [DEMO_REPO_ID],
  );

  const chunks = Object.entries(FIXTURE_FILES).flatMap(([path, src]) => chunkFile(path, src));
  const embedText = chunks.map(
    (c) => `${c.path} ${c.symbol ?? ""} ${c.symbolKind ?? ""}\n${c.content}`,
  );
  const vectors = await embedBatched(embedText);
  await insertChunks(
    db,
    chunks.map((c, i) => ({
      repoId: DEMO_REPO_ID,
      path: c.path,
      lang: c.lang,
      symbol: c.symbol,
      symbolKind: c.symbolKind,
      startLine: c.startLine,
      endLine: c.endLine,
      content: c.content,
      context: `In ${c.path}`,
      contentHash: c.contentHash,
      tokenCount: countTokens(c.content),
      embedding: vectors[i]!,
    })),
  );

  const count = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM chunks WHERE repo_id = $1`,
    [DEMO_REPO_ID],
  );
  await db.query(
    `UPDATE repos SET status='ready', file_count=$2, chunk_count=$3, indexed_at=now()
     WHERE id = $1`,
    [DEMO_REPO_ID, Object.keys(FIXTURE_FILES).length, Number(count[0]?.n ?? 0)],
  );
}
