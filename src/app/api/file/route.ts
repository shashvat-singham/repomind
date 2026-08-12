import { NextRequest } from "next/server";
import { readFile } from "@/lib/agent/tools-core";

export const runtime = "nodejs";

/** Returns a reconstructed file for the citation code drawer. */
export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get("repoId");
  const path = req.nextUrl.searchParams.get("path");
  if (!repoId || !path) {
    return Response.json({ error: "repoId and path required" }, { status: 400 });
  }
  const file = await readFile(repoId, path);
  return Response.json(file);
}
