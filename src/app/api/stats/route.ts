import { NextRequest } from "next/server";
import { repoStats } from "@/lib/agent/tools-core";

export const runtime = "nodejs";

/** Returns the language/file/chunk breakdown for one repo (for the UI panel). */
export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get("repoId");
  if (!repoId) return Response.json({ error: "repoId required" }, { status: 400 });
  try {
    const stats = await repoStats(repoId);
    return Response.json(stats);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
