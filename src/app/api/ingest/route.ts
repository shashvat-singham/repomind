import { NextRequest } from "next/server";
import { ingestRepo } from "@/lib/ingest/pipeline";
import { rateLimit, clientKey } from "@/lib/agent/ratelimit";
import { sseFromGenerator } from "@/lib/sse";

export const runtime = "nodejs";
export const maxDuration = 300;

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
