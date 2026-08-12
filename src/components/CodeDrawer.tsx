"use client";
import { useEffect, useState } from "react";
import type { Citation } from "@/lib/types";
import { Highlight } from "./Highlight";

/**
 * Slide-in code viewer opened from a citation. Shows the cited snippet
 * immediately, then lazily fetches and reveals the full file (with the cited
 * lines highlighted) so the answer is always one click from its source — the
 * feature that turns "trust me" into "see for yourself".
 */
export function CodeDrawer({
  repoId,
  citation,
  onClose,
}: {
  repoId: string;
  citation: Citation | null;
  onClose: () => void;
}) {
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFull, setShowFull] = useState(false);

  useEffect(() => {
    setFull(null);
    setShowFull(false);
  }, [citation?.path, citation?.startLine]);

  if (!citation) return null;

  const loadFull = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/file?repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(citation.path)}`,
      );
      const data = (await res.json()) as { content: string; found: boolean };
      setFull(data.found ? data.content : citation.snippet);
      setShowFull(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer card">
        <header className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 13, color: "var(--accent)", overflowWrap: "anywhere" }}>
              {citation.path}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
              {citation.symbol ? (
                <>
                  <span className="chip">{citation.symbolKind ?? "symbol"}</span>{" "}
                  <span className="mono">{citation.symbol}</span> ·{" "}
                </>
              ) : null}
              lines {citation.startLine}–{citation.endLine} · relevance {(citation.score * 100).toFixed(0)}%
            </div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="drawer-body">
          <Highlight
            code={showFull && full ? full : citation.snippet}
            startLine={showFull && full ? 1 : citation.startLine}
            highlightRange={[citation.startLine, citation.endLine]}
          />
        </div>

        <footer className="drawer-foot">
          {!showFull ? (
            <button className="btn" onClick={loadFull} disabled={loading}>
              {loading ? "Loading…" : "Open full file"}
            </button>
          ) : (
            <button className="btn" onClick={() => setShowFull(false)}>
              Show cited snippet only
            </button>
          )}
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{citation.lang}</span>
        </footer>
      </aside>
      <style>{`
        .drawer-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:40; animation:fade .15s ease; }
        .drawer { position:fixed; top:0; right:0; height:100vh; width:min(680px, 94vw); z-index:41;
                  border-radius:0; display:flex; flex-direction:column; animation:slide .2s ease; }
        .drawer-head { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; padding:14px 16px; border-bottom:1px solid var(--border); }
        .drawer-body { flex:1; overflow:auto; }
        .drawer-foot { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-top:1px solid var(--border); }
        @keyframes slide { from { transform:translateX(30px); opacity:0; } to { transform:none; opacity:1; } }
        @keyframes fade { from { opacity:0; } to { opacity:1; } }
      `}</style>
    </>
  );
}
