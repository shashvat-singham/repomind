"use client";
import { useEffect, useState } from "react";

type Tab = "stats" | "eval" | "obs";

interface Stats {
  files: number;
  chunks: number;
  languages: { lang: string; chunks: number }[];
  topFiles: { path: string; chunks: number }[];
}

interface EvalReport {
  generatedAt: string;
  embeddingModel: string;
  backend: string;
  perConfig: { config: string; metrics: { recallAt5: number; mrr: number; ndcgAt10: number; hitAt5: number; n: number } }[];
  perCase: { id: string; question: string; probes: string; hybridHit: boolean; hybridRR: number }[];
}

interface Obs {
  totalQueries: number;
  cacheHits: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  costSavedUsd: number;
  injectionsBlocked: number;
  recent: { question: string; mode: string; latencyMs: number; costUsd: number; cacheHit: boolean }[];
}

const LANG_COLORS: Record<string, string> = {
  typescript: "#6ea8fe", javascript: "#ffcc66", python: "#7ee2c9", go: "#67d0e0",
  rust: "#ff8a65", java: "#e0a06d", markdown: "#9aa3ba", json: "#c792ea",
};
function langColor(l: string): string {
  return LANG_COLORS[l] ?? "#7c8398";
}

export function InsightsPanel({ repoId, refreshKey }: { repoId: string | null; refreshKey: number }) {
  const [tab, setTab] = useState<Tab>("stats");
  const [stats, setStats] = useState<Stats | null>(null);
  const [evalReport, setEvalReport] = useState<EvalReport | null>(null);
  const [obs, setObs] = useState<Obs | null>(null);

  useEffect(() => {
    if (repoId) {
      fetch(`/api/stats?repoId=${encodeURIComponent(repoId)}`).then((r) => r.json()).then(setStats).catch(() => {});
    }
  }, [repoId, refreshKey]);

  useEffect(() => {
    fetch("/api/eval").then((r) => (r.ok ? r.json() : null)).then(setEvalReport).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "obs") {
      fetch("/api/observability").then((r) => r.json()).then(setObs).catch(() => {});
    }
  }, [tab, refreshKey]);

  return (
    <div className="insights">
      <div className="tabs">
        {(["stats", "eval", "obs"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "stats" ? "Repository" : t === "eval" ? "Retrieval evals" : "Observability"}
          </button>
        ))}
      </div>

      <div className="insights-body">
        {tab === "stats" && <StatsView stats={stats} repoId={repoId} />}
        {tab === "eval" && <EvalView report={evalReport} />}
        {tab === "obs" && <ObsView obs={obs} />}
      </div>

      <style>{`
        .insights { display:flex; flex-direction:column; height:100%; }
        .tabs { display:flex; gap:4px; padding:12px 14px 0; border-bottom:1px solid var(--border); }
        .tab { background:transparent; border:none; color:var(--muted); font-size:12.5px; padding:8px 12px;
               border-bottom:2px solid transparent; cursor:pointer; }
        .tab.active { color:var(--text); border-bottom-color:var(--accent); }
        .insights-body { flex:1; overflow-y:auto; padding:16px; }
        .kpi-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px; }
        .kpi { background:linear-gradient(180deg,var(--panel-3),var(--panel-2)); border:1px solid var(--border-2);
               border-radius:12px; padding:12px 13px; transition:border-color .15s, box-shadow .15s; }
        .kpi:hover { border-color:var(--accent); box-shadow:var(--glow); }
        .kpi-val { font-size:23px; font-weight:750; letter-spacing:-0.03em; }
        .kpi-lab { font-size:11px; color:var(--muted); margin-top:2px; }
        .kpi-accent { color:var(--accent-2); }
        .panel-title { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin:14px 0 8px; }
        .bar-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:12px; }
        .bar-label { width:84px; flex:none; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .bar-track { flex:1; height:8px; background:var(--panel-2); border-radius:999px; overflow:hidden; }
        .bar-fill { height:100%; border-radius:999px; }
        .bar-val { width:38px; text-align:right; flex:none; color:var(--muted); font-family:ui-monospace,monospace; font-size:11px; }
        .empty-msg { color:var(--muted); font-size:13px; text-align:center; padding:30px 10px; }
        .file-row { display:flex; justify-content:space-between; font-size:12px; padding:5px 0; border-bottom:1px solid var(--border); }
        .file-row .mono { color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:210px; }
        .metric-table { width:100%; font-size:12px; border-collapse:collapse; }
        .metric-table th { text-align:right; color:var(--muted); font-weight:500; padding:6px 4px; font-size:11px; }
        .metric-table th:first-child, .metric-table td:first-child { text-align:left; }
        .metric-table td { padding:7px 4px; border-top:1px solid var(--border); font-family:ui-monospace,monospace; }
        .row-best td { color:var(--accent-2); }
        .row-best td:first-child { font-weight:600; }
        .case-row { display:flex; align-items:center; gap:8px; font-size:12px; padding:5px 0; }
        .case-ok { color:var(--accent-2); }
        .case-bad { color:var(--danger); }
        .recent { font-size:12px; }
        .recent-row { display:flex; align-items:center; gap:8px; padding:6px 0; border-top:1px solid var(--border); }
        .recent-q { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      `}</style>
    </div>
  );
}

function StatsView({ stats, repoId }: { stats: Stats | null; repoId: string | null }) {
  if (!repoId) return <div className="empty-msg">Select or index a repository to see its shape.</div>;
  if (!stats) return <div className="empty-msg">Loading…</div>;
  const maxLang = Math.max(...stats.languages.map((l) => l.chunks), 1);
  const maxFile = Math.max(...stats.topFiles.map((f) => f.chunks), 1);
  return (
    <div>
      <div className="kpi-grid">
        <div className="kpi"><div className="kpi-val">{stats.files}</div><div className="kpi-lab">files indexed</div></div>
        <div className="kpi"><div className="kpi-val kpi-accent">{stats.chunks}</div><div className="kpi-lab">AST chunks</div></div>
      </div>
      <div className="panel-title">Language distribution</div>
      {stats.languages.map((l) => (
        <div key={l.lang} className="bar-row">
          <span className="bar-label">{l.lang}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(l.chunks / maxLang) * 100}%`, background: langColor(l.lang) }} /></span>
          <span className="bar-val">{l.chunks}</span>
        </div>
      ))}
      <div className="panel-title">Largest files (by chunks)</div>
      {stats.topFiles.map((f) => (
        <div key={f.path} className="bar-row">
          <span className="bar-track" style={{ maxWidth: 60 }}><span className="bar-fill" style={{ width: `${(f.chunks / maxFile) * 100}%`, background: "var(--accent)" }} /></span>
          <span className="mono" style={{ flex: 1, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
          <span className="bar-val">{f.chunks}</span>
        </div>
      ))}
    </div>
  );
}

function EvalView({ report }: { report: EvalReport | null }) {
  if (!report) return <div className="empty-msg">Run <span className="mono">npm run eval</span> to generate the benchmark.</div>;
  const best = report.perConfig.reduce((a, b) => (b.metrics.mrr > a.metrics.mrr ? b : a));
  const misses = report.perCase.filter((c) => !c.hybridHit);
  return (
    <div>
      <div className="panel-title">Ablation — {report.perConfig[0]?.metrics.n} golden questions</div>
      <table className="metric-table">
        <thead><tr><th>config</th><th>R@5</th><th>MRR</th><th>nDCG</th><th>Hit@5</th></tr></thead>
        <tbody>
          {report.perConfig.map((c) => (
            <tr key={c.config} className={c.config === best.config ? "row-best" : ""}>
              <td>{c.config}</td>
              <td>{(c.metrics.recallAt5 * 100).toFixed(0)}%</td>
              <td>{c.metrics.mrr.toFixed(3)}</td>
              <td>{(c.metrics.ndcgAt10 * 100).toFixed(0)}%</td>
              <td>{(c.metrics.hitAt5 * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8 }}>
        Hybrid RRF fusion wins on every metric. {report.backend} · {report.embeddingModel}
      </div>

      <div className="panel-title">Per-question hit@5</div>
      {report.perCase.map((c) => (
        <div key={c.id} className="case-row">
          <span className={c.hybridHit ? "case-ok" : "case-bad"}>{c.hybridHit ? "✓" : "✗"}</span>
          <span className="chip" style={{ fontSize: 10 }}>{c.probes}</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.question}</span>
        </div>
      ))}
      {misses.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--accent-2)", marginTop: 10 }}>
          ✓ Every golden question retrieves a relevant file in the top 5.
        </div>
      )}
    </div>
  );
}

function ObsView({ obs }: { obs: Obs | null }) {
  if (!obs) return <div className="empty-msg">Loading telemetry…</div>;
  if (obs.totalQueries === 0) return <div className="empty-msg">Ask a few questions — live cost, latency, and cache metrics appear here.</div>;
  return (
    <div>
      <div className="kpi-grid">
        <div className="kpi"><div className="kpi-val">{obs.totalQueries}</div><div className="kpi-lab">questions answered</div></div>
        <div className="kpi"><div className="kpi-val kpi-accent">{(obs.cacheHitRate * 100).toFixed(0)}%</div><div className="kpi-lab">semantic cache hit rate</div></div>
        <div className="kpi"><div className="kpi-val">{obs.avgLatencyMs}<span style={{ fontSize: 13 }}>ms</span></div><div className="kpi-lab">avg latency · p95 {obs.p95LatencyMs}ms</div></div>
        <div className="kpi"><div className="kpi-val kpi-accent">${obs.costSavedUsd.toFixed(4)}</div><div className="kpi-lab">cost saved by cache</div></div>
      </div>
      {obs.injectionsBlocked > 0 && (
        <div style={{ fontSize: 12, color: "var(--warn)", marginBottom: 10 }}>
          ⚠ {obs.injectionsBlocked} prompt-injection attempt{obs.injectionsBlocked > 1 ? "s" : ""} flagged
        </div>
      )}
      <div className="panel-title">Recent questions</div>
      <div className="recent">
        {obs.recent.map((r, i) => (
          <div key={i} className="recent-row">
            <span className={`chip ${r.cacheHit ? "chip-on" : ""}`} style={{ fontSize: 10 }}>{r.cacheHit ? "cache" : r.mode}</span>
            <span className="recent-q">{r.question}</span>
            <span style={{ color: "var(--muted)", fontFamily: "ui-monospace,monospace", fontSize: 11 }}>{r.latencyMs}ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}
