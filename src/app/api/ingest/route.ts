import { NextRequest } from "next/server";
import { ingestRepo } from "@/lib/ingest/pipeline";
import { rateLimit, clientKey } from "@/lib/agent/ratelimit";
import { sseFromGenerator } from "@/lib/sse";

export const runtime = "nodejs";
// 60s is the Vercel Hobby ceiling. Ingestion streams the tarball and embeds
// locally, so typical repos finish well under this; very large repos are bounded
// by the MAX_FILES cap in the ingest pipeline.
export const maxDuration = 60;

/**
 * Kicks off repo ingestion and streams live progress (resolving → files →
 * embedding → done) as SSE so the UI can render a real-time trace.
 */
export async function POST(req: NextRequest) {
  const { repo } = (await req.json()) as { repo?: string };
  if (!repo) {
    return Response.json({ error: "repo is required (owner/name or a github URL)" }, { status: 400 });
  }

  // Ingestion is heavier than chat — use a tighter budget.
  const rl = rateLimit(`ingest:${clientKey(req)}`, 6);
  if (!rl.allowed) {
    return Response.json(
      { error: `Too many ingests. Try again in ${Math.ceil(rl.resetInMs / 1000)}s.` },
      { status: 429 },
    );
  }

  return sseFromGenerator(ingestRepo(repo));
}
