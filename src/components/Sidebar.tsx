"use client";
import { useState } from "react";
import type { IngestEvent, RepoInfo, Mode } from "@/lib/types";
import { postEventStream } from "@/lib/useEventStream";

const SAMPLES = ["tiangolo/fastapi", "expressjs/express", "pallets/flask", "honojs/hono"];

export function Sidebar({
  repos,
  mode,
  selected,
  onSelect,
  onIngested,
}: {
  repos: RepoInfo[];
  mode: Mode | null;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Refreshes the repo list and resolves with it, so we can verify the write. */
  onIngested: () => Promise<RepoInfo[]>;
}) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ files: number; done: number; total: number } | null>(null);

  async function ingest(target: string) {
    if (!target.trim() || busy) return;
    setBusy(true);
    setLog([]);
    setProgress({ files: 0, done: 0, total: 0 });
    const push = (s: string) => setLog((p) => [...p.slice(-40), s]);
    let indexedId: string | null = null;

    try {
      await postEventStream<IngestEvent>("/api/ingest", { repo: target }, (ev) => {
        switch (ev.type) {
          case "resolving": push(`resolving ${ev.slug}…`); break;
          case "resolved": push(`✓ ${ev.ref}${ev.sha ? ` @ ${ev.sha}` : ""}`); break;
          case "file":
            setProgress((p) => ({ ...(p ?? { done: 0, total: 0 }), files: ev.fileCount }));
            if (ev.fileCount % 10 === 0) push(`scanned ${ev.fileCount} files…`);
            break;
          case "embedding":
            setProgress((p) => ({ ...(p ?? { files: 0 }), done: 0, total: ev.total }));
            break;
          case "upserting":
            setProgress((p) => ({ ...(p ?? { files: 0 }), done: ev.done, total: ev.total }));
            break;
          case "done":
            push(`✓ indexed ${ev.chunks} chunks from ${ev.files} files in ${(ev.ms / 1000).toFixed(1)}s`);
            if (ev.reused) push(`  (${ev.reused} chunks reused — incremental)`);
            setProgress(null);
            indexedId = ev.repoId;
            onSelect(ev.repoId);
            break;
          case "error": push(`✗ ${ev.message}`); break;
        }
      });

      // The ingest can succeed and still be unreachable: on a serverless host
      // without a shared database, the write lands in one instance's /tmp while
      // the next request is served by another. Verify instead of assuming.
      if (indexedId) {
        const after = await onIngested();
        if (!after.some((r) => r.id === indexedId)) {
          push(`✗ indexed, but the server can't see this repo — the write went to`);
          push(`  one instance's local storage. Set DATABASE_URL (Neon) for a`);
          push(`  shared index; until then only the demo repo is answerable.`);
        }
      }
    } catch (e) {
      push(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sidebar">
      <div className="brand">
        <div className="brand-mark">◈</div>
        <div>
          <div className="brand-name">RepoMind</div>
          <div className="brand-sub">codebase intelligence</div>
        </div>
      </div>

      {mode && (
        <div className="modes">
          <span className={`chip ${mode.db === "neon" ? "chip-on" : ""}`} title="Vector store">
            {mode.db === "neon" ? "Neon + pgvector" : "PGlite + pgvector"}
          </span>
          <span className={`chip ${mode.models !== "local" ? "chip-on" : ""}`} title="Model provider">
            {mode.models === "openai" ? "OpenAI" : mode.models === "gemini" ? "Gemini" : "local models"}
          </span>
        </div>
      )}

      {mode?.ephemeral && (
        <div className="warn-note">
          Each server instance holds its own index in <span className="mono">/tmp</span>, so a repo
          you index here may not be visible to the next request. Set{" "}
          <span className="mono">DATABASE_URL</span> (Neon) for a shared, durable index. The demo
          repo below is seeded on every instance and always works.
        </div>
      )}

      <div className="section-label">Index a repository</div>
      <form
        onSubmit={(e) => { e.preventDefault(); ingest(repo); }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          className="input"
          placeholder="owner/name or GitHub URL"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          disabled={busy}
        />
        <button className="btn btn-primary" disabled={busy || !repo.trim()}>
          {busy ? "…" : "Index"}
        </button>
      </form>
      <div className="samples">
        {SAMPLES.map((s) => (
          <button key={s} className="sample" disabled={busy} onClick={() => { setRepo(s); ingest(s); }}>
            {s}
          </button>
        ))}
      </div>

      {(busy || log.length > 0) && (
        <div className="ingest-log card">
          {progress && progress.total > 0 && (
            <div className="prog">
              <div className="prog-bar" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
          )}
          {progress && (
            <div className="prog-meta">
              {progress.files} files · {progress.total > 0 ? `${progress.done}/${progress.total} chunks` : "scanning"}
            </div>
          )}
          <div className="log-lines mono">
            {log.map((l, i) => <div key={i} className={l.startsWith("✗") ? "log-err" : ""}>{l}</div>)}
          </div>
        </div>
      )}

      <div className="section-label">Indexed repos</div>
      <div className="repo-list">
        {repos.length === 0 && <div className="empty-hint">None yet — index one above.</div>}
        {repos.map((r) => {
          // Indexed under a different embedding model: its vectors are in
          // another space, so searching them would return noise.
          const stale = !!mode && !!r.embedModel && r.embedModel !== mode.embedModel;
          return (
            <button
              key={r.id}
              className={`repo-item ${selected === r.id ? "active" : ""}`}
              onClick={() => onSelect(r.id)}
            >
              <div className="repo-name mono">{r.owner}/{r.name}</div>
              <div className="repo-meta">
                <span className={`dot dot-${stale ? "error" : r.status}`} />
                {r.ref} · {r.files} files · {r.chunks} chunks
              </div>
              {stale && (
                <div className="repo-stale">
                  indexed with {r.embedModel} — re-index to use {mode.embedModel}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="side-foot">
        <a href="/api/mcp" className="mcp-badge" title="Model Context Protocol endpoint">
          ⚡ MCP server live at <span className="mono">/api/mcp</span>
        </a>
      </div>

      <style>{`
        .sidebar { display:flex; flex-direction:column; gap:14px; height:100%; overflow-y:auto; padding:18px; }
        .brand { display:flex; align-items:center; gap:12px; }
        .brand-mark { width:40px; height:40px; border-radius:11px; display:grid; place-items:center; font-size:21px;
                      background:linear-gradient(135deg,#3350a8,#1fae86); color:#fff;
                      box-shadow:0 0 0 1px rgba(110,168,254,0.25), 0 10px 26px -10px rgba(110,168,254,0.6); }
        .brand-name { font-weight:750; font-size:17px; letter-spacing:-0.02em;
                      background:linear-gradient(90deg,#fff,#a9c0ff); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
        .brand-sub { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; }
        .modes { display:flex; gap:6px; flex-wrap:wrap; }
        .chip-on { color:var(--accent-2); border-color:#2c5b4c; }
        .section-label { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin-top:6px; }
        .warn-note { font-size:11.5px; line-height:1.55; color:var(--warn); border:1px solid #5c4a1f;
                     background:rgba(92,74,31,0.12); border-radius:9px; padding:9px 10px; }
        .samples { display:flex; flex-wrap:wrap; gap:6px; }
        .sample { font-size:11.5px; color:var(--muted); background:transparent; border:1px dashed var(--border);
                  border-radius:999px; padding:3px 9px; cursor:pointer; }
        .sample:hover:not(:disabled) { color:var(--accent); border-color:var(--accent); }
        .ingest-log { padding:10px; }
        .prog { height:5px; background:var(--panel-2); border-radius:999px; overflow:hidden; margin-bottom:6px; }
        .prog-bar { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent-2)); transition:width .3s ease; }
        .prog-meta { font-size:11px; color:var(--muted); margin-bottom:6px; }
        .log-lines { font-size:11px; color:var(--muted); max-height:140px; overflow:auto; line-height:1.6; }
        .log-err { color:var(--danger); }
        .repo-list { display:flex; flex-direction:column; gap:6px; }
        .empty-hint { font-size:12px; color:var(--muted); }
        .repo-item { text-align:left; background:var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:9px 11px; cursor:pointer; transition:border-color .15s, background .15s, transform .12s; }
        .repo-item:hover { border-color:var(--border-2); transform:translateX(2px); }
        .repo-item.active { border-color:var(--accent); background:#172038; box-shadow:inset 3px 0 0 var(--accent), var(--glow); }
        .repo-name { font-size:13px; }
        .repo-meta { font-size:11px; color:var(--muted); display:flex; align-items:center; gap:6px; margin-top:3px; }
        .repo-stale { font-size:10.5px; line-height:1.45; color:var(--danger); margin-top:4px; }
        .dot { width:7px; height:7px; border-radius:50%; background:var(--muted); }
        .dot-ready { background:var(--accent-2); }
        .dot-indexing { background:var(--warn); }
        .dot-error { background:var(--danger); }
        .side-foot { margin-top:auto; padding-top:10px; }
        .mcp-badge { display:block; font-size:11.5px; color:var(--muted); text-decoration:none; border:1px solid var(--border);
                     border-radius:8px; padding:8px 10px; background:var(--panel-2); }
        .mcp-badge:hover { border-color:var(--accent-2); color:var(--text); }
      `}</style>
    </div>
  );
}
