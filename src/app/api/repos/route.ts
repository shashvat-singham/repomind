import { listRepos } from "@/lib/agent/tools-core";
import { currentMode } from "@/lib/config";

export const runtime = "nodejs";

/** Lists indexed repos and reports which backend/model mode the app is in. */
export async function GET() {
  try {
    const repos = await listRepos();
    return Response.json({ repos, mode: currentMode() });
  } catch (e) {
    return Response.json(
      { repos: [], mode: currentMode(), error: (e as Error).message },
      { status: 200 },
    );
  }
}
