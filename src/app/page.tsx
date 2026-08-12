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

  const loadRepos = useCallback(async () => {
    try {
      const res = await fetch("/api/repos");
      const data = (await res.json()) as { repos: RepoInfo[]; mode: Mode };
      setRepos(data.repos);
      setMode(data.mode);
      setSelected((cur) => cur ?? data.repos.find((r) => r.status === "ready")?.id ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const selectedRepo = repos.find((r) => r.id === selected) ?? null;
  const ready = selectedRepo?.status === "ready";

  return (
    <div className="app">
      <aside className="col-side">
        <Sidebar
          repos={repos}
          mode={mode}
          selected={selected}
          onSelect={setSelected}
          onIngested={() => {
            loadRepos();
            setRefreshKey((k) => k + 1);
          }}
        />
      </aside>

      <main className="col-main">
        <div className="main-head">
          <div>
            <div className="main-title">
              {selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "No repository selected"}
            </div>
            <div className="main-sub">
              {selectedRepo
                ? `${selectedRepo.ref} · hybrid RAG · ${mode?.models === "openai" ? "agentic tool loop" : "local synthesis"}`
                : "Index a public GitHub repo to start asking questions"}
            </div>
          </div>
          {selectedRepo && (
            <div className="head-badges">
              <span className="chip">{selectedRepo.chunks} chunks</span>
              <span className={`chip ${ready ? "chip-on" : ""}`}>{selectedRepo.status}</span>
            </div>
          )}
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
