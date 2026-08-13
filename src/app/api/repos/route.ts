import { NextRequest } from "next/server";
import { deleteRepo, listRepos } from "@/lib/agent/tools-core";
import { config, currentMode } from "@/lib/config";
import { clientKey, rateLimit } from "@/lib/agent/ratelimit";

export const runtime = "nodejs";

/** The always-available demo index; removing it would empty a fresh instance. */
const DEMO_REPO_ID = "demo/acme-service@main";

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

/**
 * Removes an indexed repo and its chunks.
 *
 * This is the one destructive route in the API. It is rate limited, refuses the
 * seeded demo repo, and requires `Authorization: Bearer <ADMIN_TOKEN>` when that
 * variable is set. With it unset the route is open, like the rest of this demo's
 * API — set ADMIN_TOKEN on any deployment where that is not acceptable.
 */
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "id query parameter is required" }, { status: 400 });
  }

  if (config.adminToken) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${config.adminToken}`) {
      return Response.json(
        { error: "Removing repositories is protected on this deployment." },
        { status: 401 },
      );
    }
  }

  const rl = rateLimit(`delete:${clientKey(req)}`, 10);
  if (!rl.allowed) {
    return Response.json(
      { error: `Too many requests. Try again in ${Math.ceil(rl.resetInMs / 1000)}s.` },
      { status: 429 },
    );
  }

  if (id === DEMO_REPO_ID) {
    return Response.json(
      { error: "The demo repository can't be removed — it is re-seeded on every boot." },
      { status: 400 },
    );
  }

  try {
    const removed = await deleteRepo(id);
    if (!removed) return Response.json({ error: `No indexed repo with id "${id}".` }, { status: 404 });
    return Response.json({ removed: id });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
