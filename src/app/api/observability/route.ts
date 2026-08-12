import { getObsSummary } from "@/lib/obs/log";

export const runtime = "nodejs";

/** Aggregate telemetry for the observability dashboard. */
export async function GET() {
  try {
    const summary = await getObsSummary();
    return Response.json(summary);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
