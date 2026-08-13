"use client";
import { useCallback, useEffect, useState } from "react";
import type { Citation, Mode, RepoInfo } from "@/lib/types";
import { Sidebar } from "@/components/Sidebar";
import { Chat } from "@/components/Chat";
import { InsightsPanel } from "@/components/InsightsPanel";
import { CodeDrawer } from "@/components/CodeDrawer";

export default function Home() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [mode, setMode] = useState<Mode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Returns the fresh list so callers (the ingest flow) can check whether the
  // repo they just wrote is actually visible to the server.
  const loadRepos = useCallback(async (): Promise<RepoInfo[]> => {
    try {
      const res = await fetch("/api/repos");
      const data = (await res.json()) as { repos: RepoInfo[]; mode: Mode };
      setRepos(data.repos);
      setMode(data.mode);
      setSelected((cur) => cur ?? data.repos.find((r) => r.status === "ready")?.id ?? null);
      return data.repos;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const selectedRepo = repos.find((r) => r.id === selected) ?? null;
  // Selected, but the server doesn't know it — an ingest that landed on another
  // instance. Say so, rather than showing the same blank state as "nothing yet".
  const unreachable = selected !== null && selectedRepo === null;
  // Indexed under a different embedding provider — its vectors can't be searched
  // with the current one, so answering would be noise dressed up as citations.
  const staleIndex =
    !!selectedRepo && !!mode && !!selectedRepo.embedModel &&
    selectedRepo.embedModel !== mode.embedModel;
  const ready = selectedRepo?.status === "ready" && !staleIndex;

  return (
    <div className="app">
      <aside className="col-side">
        <Sidebar
          repos={repos}
          mode={mode}
          selected={selected}
          onSelect={setSelected}
          onIngested={() => {
            setRefreshKey((k) => k + 1);
            return loadRepos();
          }}
          onRemoved={(id) => {
            // Don't leave the app pointing at something that no longer exists —
            // that is the "unavailable on this instance" state, and it would be
            // misleading here.
            setSelected((cur) => (cur === id ? null : cur));
            setCitation(null);
          }}
        />
      </aside>

      <main className="col-main">
        <div className="main-head">
          <div>
            <div className="main-title">
              {selectedRepo
                ? `${selectedRepo.owner}/${selectedRepo.name}`
                : unreachable
                  ? selected.split("@")[0]
                  : "No repository selected"}
            </div>
            <div className="main-sub">
              {selectedRepo
                ? staleIndex
                  ? `Indexed with ${selectedRepo.embedModel}, but this deployment now embeds with ${mode?.embedModel}. Re-index it to ask questions.`
                  : `${selectedRepo.ref} · hybrid RAG · ${mode?.models !== "local" ? "agentic tool loop" : "local synthesis"}`
                : unreachable
                  ? "Indexed, but this server instance can't see it — nothing here can be answered. Details in the sidebar."
                  : "Index a public GitHub repo to start asking questions"}
            </div>
          </div>
          {selectedRepo ? (
            <div className="head-badges">
              <span className="chip">{selectedRepo.chunks} chunks</span>
              <span className={`chip ${ready ? "chip-on" : staleIndex ? "chip-warn" : ""}`}>
                {staleIndex ? "stale index" : selectedRepo.status}
              </span>
            </div>
          ) : unreachable ? (
            <div className="head-badges">
              <span className="chip chip-warn">unavailable on this instance</span>
            </div>
          ) : null}
        </div>
        <div className="main-chat">
          <Chat repoId={selected} ready={!!ready} onCite={setCitation} />
        </div>
      </main>

      <aside className="col-insights">
        <InsightsPanel repoId={selected} refreshKey={refreshKey} />
      </aside>

      {citation && selected && (
        <CodeDrawer repoId={selected} citation={citation} onClose={() => setCitation(null)} />
      )}

      <style>{`
        .app { display:grid; grid-template-columns:300px 1fr 380px; height:100vh; overflow:hidden; }
        .col-side { border-right:1px solid var(--border); background:linear-gradient(180deg, rgba(21,24,36,0.5), var(--panel)); min-width:0; backdrop-filter:blur(6px); }
        .col-main { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:var(--bg); }
        .col-insights { border-left:1px solid var(--border); background:var(--panel); min-width:0; min-height:0; overflow:hidden; }
        .main-head { display:flex; align-items:center; justify-content:space-between; padding:16px 22px;
                     border-bottom:1px solid var(--border); background:linear-gradient(180deg, rgba(15,17,24,0.7), transparent); }
        .main-title { font-size:16px; font-weight:650; letter-spacing:-0.02em; }
        .main-sub { font-size:12px; color:var(--muted); margin-top:2px; }
        .head-badges { display:flex; gap:6px; }
        .chip-on { color:var(--accent-2); border-color:#2c5b4c; }
        .chip-warn { color:var(--warn); border-color:#5c4a1f; }
        .main-chat { flex:1; min-height:0; overflow:hidden; }
        @media (max-width: 1100px) {
          .app { grid-template-columns:260px 1fr; }
          .col-insights { display:none; }
        }
        @media (max-width: 760px) {
          .app { grid-template-columns:1fr; grid-template-rows:auto 1fr; }
          .col-side { border-right:none; border-bottom:1px solid var(--border); max-height:40vh; }
        }
      `}</style>
    </div>
  );
}
