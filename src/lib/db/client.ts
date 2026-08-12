import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config, usingCloudDb } from "@/lib/config";

/**
 * One database interface, two backends.
 *
 *   • Local / CI  → PGlite: Postgres compiled to wasm, running in-process, with
 *                   the pgvector extension. Persists to disk so an ingested repo
 *                   survives a dev-server restart. No container, no service.
 *   • Production  → Neon serverless Postgres over HTTP (edge-friendly).
 *
 * Both speak the same SQL and the same `$1` placeholder syntax, so the rest of
 * the codebase is backend-agnostic — it only ever sees {@link Db}.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Backend identifier, surfaced in the UI so the demo shows which mode it's in. */
  readonly backend: "pglite" | "neon";
}

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  dbPromise ??= usingCloudDb ? initNeon() : initPglite();
  return dbPromise;
}

// ── Neon ────────────────────────────────────────────────────────────────────

async function initNeon(): Promise<Db> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(config.databaseUrl);
  const db: Db = {
    backend: "neon",
    async query<T>(text: string, params: unknown[] = []) {
      // neon()'s .query() runs a parametrised statement and returns rows.
      const rows = (await sql.query(text, params)) as T[];
      return rows;
    },
  };
  await migrate(db);
  return db;
}

// ── PGlite ──────────────────────────────────────────────────────────────────

async function initPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  // Read the dir lazily (not from the frozen config snapshot) so tests can point
  // it at an in-memory instance. "memory" ⇒ ephemeral; anything else persists.
  const dir = process.env.PGLITE_DIR ?? config.pgliteDir;
  let dataDir: string;
  if (dir === "memory" || dir === "memory://") {
    dataDir = "memory://";
  } else {
    // PGlite's node fs layer does not create parent directories, so do it here.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    dataDir = dir;
  }
  const pg = new PGlite({ dataDir, extensions: { vector } });
  await pg.waitReady;
  const db: Db = {
    backend: "pglite",
    async query<T>(text: string, params: unknown[] = []) {
      const res = await pg.query<T>(text, params as unknown[]);
      return res.rows;
    },
  };
  await migrate(db);
  return db;
}

// ── Migrations ──────────────────────────────────────────────────────────────

let migrated = false;

async function migrate(db: Db): Promise<void> {
  if (migrated) return;
  const schemaPath = join(process.cwd(), "src", "lib", "db", "schema.sql");
  const schema = await readFile(schemaPath, "utf8");
  // Split on blank lines: each block is a single statement, which keeps us
  // compatible with Neon's one-statement-per-HTTP-call driver.
  const statements = schema
    .split(/\n\s*\n/)
    .map((s) => stripComments(s).trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await db.query(stmt);
  }

  // ANN index is best-effort: HNSW needs pgvector ≥ 0.5. If the running build
  // is older we fall back to exact (sequential) scan, which is correct and
  // perfectly fast at demo/repo scale — we just log the downgrade.
  await tryCreateAnnIndex(db);

  migrated = true;
}

async function tryCreateAnnIndex(db: Db): Promise<void> {
  try {
    await db.query(
      `CREATE INDEX IF NOT EXISTS chunks_hnsw_idx
         ON chunks USING hnsw (embedding vector_cosine_ops)
         WITH (m = 16, ef_construction = 64)`,
    );
  } catch {
    try {
      await db.query(
        `CREATE INDEX IF NOT EXISTS chunks_ivf_idx
           ON chunks USING ivfflat (embedding vector_cosine_ops)
           WITH (lists = 100)`,
      );
    } catch {
      // No ANN index available — exact search still works via the query planner.
      console.warn("[repomind] No ANN index; using exact vector scan.");
    }
  }
}

function stripComments(block: string): string {
  return block
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/** Test-only hook so the in-memory harness can reset the singleton. */
export function __resetDbForTests(): void {
  dbPromise = null;
  migrated = false;
}
