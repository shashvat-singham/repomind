import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

/**
 * Serves the committed eval report (evals/results.json), produced by
 * `npm run eval` and regenerated in CI. We serve the committed artifact rather
 * than running the full eval inside a serverless request, which would be slow
 * and burn tokens on every page load — the benchmark is a build-time output.
 */
export async function GET() {
  try {
    const path = join(process.cwd(), "evals", "results.json");
    const raw = await readFile(path, "utf8");
    return new Response(raw, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    });
  } catch {
    return Response.json(
      { error: "No eval results yet. Run `npm run eval` to generate evals/results.json." },
      { status: 404 },
    );
  }
}
