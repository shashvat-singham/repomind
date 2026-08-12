import { describe, it, expect, beforeAll } from "vitest";
import { rm } from "node:fs/promises";
import { getDb } from "@/lib/db/client";
import { toSqlVector } from "@/lib/db/vector";
import { embedBatched } from "@/lib/models/embeddings";
import { countTokens } from "@/lib/obs/tokens";
import { chunkFile } from "@/lib/ingest/chunker";
import { hybridRetrieve } from "@/lib/retrieval/hybrid";
import { rerank } from "@/lib/retrieval/rerank";

/**
 * Full local-stack integration test: boots PGlite with pgvector, ingests a small
 * synthetic repo through the real chunk→embed→upsert path, then exercises hybrid
 * retrieval + rerank. No network, no API keys. This is the test that proves the
 * whole retrieval spine works, and it runs in CI.
 */

const REPO_ID = "test/fixture@main";

const FILES: Record<string, string> = {
  "src/auth.ts": `import { db } from "./db";

// Verifies a user's password and issues a session token on success.
export async function login(username: string, password: string): Promise<string | null> {
  const user = await db.findUser(username);
  if (!user) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return issueSessionToken(user.id);
}

export function issueSessionToken(userId: string): string {
  return "session_" + userId + "_" + Date.now();
}
`,
  "src/payments.ts": `// Charges a customer's card via the Stripe API and records the invoice.
export async function chargeCustomer(customerId: string, amountCents: number) {
  const intent = await stripe.paymentIntents.create({ customer: customerId, amount: amountCents });
  await recordInvoice(customerId, amountCents, intent.id);
  return intent;
}
`,
  "src/geometry.ts": `export const PI = 3.14159;
export function areaOfCircle(radius: number): number {
  return PI * radius * radius;
}
`,
};

beforeAll(async () => {
  // Fresh data dir so the test is hermetic.
  process.env.PGLITE_DIR = ".repomind-data/test-pg";
  await rm(".repomind-data/test-pg", { recursive: true, force: true }).catch(() => {});

  const db = await getDb();
  await db.query(
    `INSERT INTO repos (id, owner, name, ref, status) VALUES ($1,'test','fixture','main','indexing')
     ON CONFLICT (owner, name, ref) DO NOTHING`,
    [REPO_ID],
  );

  const allChunks = Object.entries(FILES).flatMap(([path, src]) => chunkFile(path, src));
  const vectors = await embedBatched(
    allChunks.map((c) => `${c.path} ${c.symbol ?? ""} ${c.content}`),
  );
  for (let i = 0; i < allChunks.length; i++) {
    const c = allChunks[i]!;
    await db.query(
      `INSERT INTO chunks
         (repo_id, path, lang, symbol, symbol_kind, start_line, end_line,
          content, context, content_hash, token_count, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)
       ON CONFLICT (repo_id, content_hash) DO NOTHING`,
      [
        REPO_ID, c.path, c.lang, c.symbol, c.symbolKind, c.startLine, c.endLine,
        c.content, `In ${c.path}`, c.contentHash, countTokens(c.content),
        toSqlVector(vectors[i]!),
      ],
    );
  }
  await db.query(`UPDATE repos SET status='ready' WHERE id=$1`, [REPO_ID]);
}, 60_000);

describe("hybrid retrieval over PGlite", () => {
  it("finds the auth code for an auth question", async () => {
    const results = await hybridRetrieve({
      repoId: REPO_ID,
      query: "how does user login and password verification work",
      topK: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("src/auth.ts");
    expect(results.some((r) => r.symbol === "login")).toBe(true);
  });

  it("uses lexical signal to find an exact token (Stripe)", async () => {
    const results = await hybridRetrieve({
      repoId: REPO_ID,
      query: "Stripe paymentIntents charge",
      topK: 5,
    });
    expect(results[0]!.path).toBe("src/payments.ts");
    // this hit should have a lexical rank, proving the FTS arm fired
    expect(results[0]!.lexRank).not.toBeNull();
  });

  it("returns RRF scores in descending order", async () => {
    const results = await hybridRetrieve({
      repoId: REPO_ID,
      query: "session token",
      topK: 5,
    });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.rrf).toBeGreaterThanOrEqual(results[i]!.rrf);
    }
  });

  it("rerank keeps the most relevant chunk on top", async () => {
    const candidates = await hybridRetrieve({
      repoId: REPO_ID,
      query: "charge a customer's credit card",
      topK: 8,
    });
    const ranked = await rerank("charge a customer's credit card", candidates, 3);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.path).toBe("src/payments.ts");
  });

  it("scopes results with a path filter", async () => {
    const results = await hybridRetrieve({
      repoId: REPO_ID,
      query: "function",
      topK: 10,
      pathLike: "geometry",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.path.includes("geometry"))).toBe(true);
  });
});
