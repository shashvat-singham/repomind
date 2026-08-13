/**
 * One-off repair: an earlier re-ingest flipped a repo's `embed_model` to the new
 * provider without re-embedding, because the incremental path reused chunks by
 * content hash. Point every repo back at the model its vectors were actually
 * produced with, so the stale-index guard tells the truth and a re-ingest
 * genuinely re-embeds.
 *
 *   node scripts/fix-embed-model.mjs <actual-model-id>
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const url =
  process.env.DATABASE_URL ??
  (readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.+)$/m) ?? [])[1];
if (!url) throw new Error("DATABASE_URL not found (env or .env.local)");

const actual = process.argv[2];
if (!actual) throw new Error("usage: node scripts/fix-embed-model.mjs <model-id>");

const sql = neon(url.trim());
const before = await sql.query(`SELECT id, embed_model FROM repos ORDER BY id`);
console.log("before:", before);

await sql.query(`UPDATE repos SET embed_model = $1`, [actual]);

const after = await sql.query(`SELECT id, embed_model FROM repos ORDER BY id`);
console.log("after:", after);
