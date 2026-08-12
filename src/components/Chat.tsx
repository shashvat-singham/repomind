"use client";
import { useRef, useState } from "react";
import type { ChatEvent, Citation, Usage } from "@/lib/types";
import { postEventStream } from "@/lib/useEventStream";
import { AnswerText } from "./AnswerText";

interface Turn {
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  usage?: Usage;
  trace: { tool: string; args: Record<string, unknown> }[];
  status?: string;
}

const STARTERS = [
  "What does this repo do, and what's the entry point?",
  "How is authentication implemented?",
  "Where is the database schema defined?",
  "Explain the request lifecycle end to end.",
];

export function Chat({
  repoId,
  ready,
  onCite,
}: {
  repoId: string | null;
  ready: boolean;
  onCite: (c: Citation) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  async function ask(question: string) {
    if (!repoId || !question.trim() || busy) return;
    setBusy(true);
    setInput("");
    const history = turns
      .filter((t) => t.text)
      .map((t) => ({ role: t.role, content: t.text }));

    setTurns((prev) => [
      ...prev,
      { role: "user", text: question, citations: [], trace: [] },
      { role: "assistant", text: "", citations: [], trace: [], status: "starting…" },
    ]);
    scrollToBottom();

    const update = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        next[i] = fn(next[i]!);
        return next;
      });

    try {
      await postEventStream<ChatEvent>(
        "/api/chat",
        { repoId, question, history },
        (ev) => {
          if (ev.type === "status") {
            update((t) => ({ ...t, status: ev.detail ?? ev.stage }));
          } else if (ev.type === "trace") {
            update((t) => ({ ...t, trace: [...t.trace, { tool: ev.tool, args: ev.args }] }));
          } else if (ev.type === "token") {
            update((t) => ({ ...t, text: t.text + ev.text, status: undefined }));
            scrollToBottom();
          } else if (ev.type === "citations") {
            update((t) => ({ ...t, citations: ev.items }));
          } else if (ev.type === "done") {
            update((t) => ({ ...t, usage: ev.usage, status: undefined }));
          } else if (ev.type === "error") {
            update((t) => ({ ...t, text: t.text || `⚠ ${ev.message}`, status: undefined }));
          }
        },
      );
    } catch (e) {
      update((t) => ({ ...t, text: t.text || `⚠ ${(e as Error).message}`, status: undefined }));
    } finally {
      setBusy(false);
      scrollToBottom();
    }
  }

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">Ask anything about the codebase</div>
            <p style={{ color: "var(--muted)", fontSize: 14, maxWidth: 460, margin: "0 auto 18px" }}>
              Every answer is grounded in retrieved code with clickable citations back to the exact file and line.
            </p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} className="btn" disabled={!ready} onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} className={`turn turn-${t.role}`}>
            {t.role === "user" ? (
              <div className="bubble-user">{t.text}</div>
            ) : (
              <div className="bubble-assistant">
                {t.trace.length > 0 && (
                  <div className="trace">
                    {t.trace.map((tr, j) => (
                      <span key={j} className="trace-step">
                        <span className="trace-dot" /> {tr.tool}
                        {tr.args.query ? (
                          <span className="trace-arg">“{String(tr.args.query).slice(0, 42)}”</span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                )}
                {t.status && (
                  <div className="status-line">
                    <span className="pulse">●</span> {t.status}
                  </div>
                )}
                {t.text && <AnswerText text={t.text} citations={t.citations} onCite={onCite} />}

                {t.citations.length > 0 && (
                  <div className="cites">
                    {t.citations.map((c, j) => (
                      <button key={j} className="cite-card" onClick={() => onCite(c)}>
                        <span className="cite-num">{j + 1}</span>
                        <span className="cite-path mono">{c.path}</span>
                        <span className="cite-lines">:{c.startLine}</span>
                      </button>
                    ))}
                  </div>
                )}

                {t.usage && (
                  <div className="usage">
                    <span className={`chip ${t.usage.mode === "openai" ? "chip-live" : ""}`}>
                      {t.usage.mode === "openai" ? "LLM agent" : "local synthesis"}
                    </span>
                    <span>{t.usage.totalMs} ms</span>
                    {t.usage.mode === "openai" && (
                      <>
                        <span>{t.usage.tokensIn + t.usage.tokensOut} tok</span>
                        <span>${t.usage.costUsd.toFixed(5)}</span>
                      </>
                    )}
                    <span>{t.citations.length} sources</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          className="input"
          placeholder={ready ? "Ask about this repository…" : "Index a repository to begin"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!ready || busy}
        />
        <button className="btn btn-primary" disabled={!ready || busy || !input.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>

      <style>{`
        .chat { display:flex; flex-direction:column; height:100%; }
        .chat-scroll { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
        .chat-empty { margin:auto; text-align:center; padding:24px; }
        .chat-empty-title { font-size:20px; font-weight:600; margin-bottom:8px; }
        .starters { display:grid; gap:8px; max-width:520px; margin:0 auto; }
        .starters .btn { text-align:left; }
        .turn-user { display:flex; justify-content:flex-end; }
        .bubble-user { background:linear-gradient(180deg,#243056,#1b2340); border:1px solid #33406b; padding:10px 14px;
                       border-radius:14px 14px 4px 14px; max-width:80%; font-size:14px; }
        .bubble-assistant { max-width:100%; }
        .trace { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
        .trace-step { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:var(--muted);
                      background:var(--panel-2); border:1px solid var(--border); border-radius:999px; padding:3px 9px; }
        .trace-dot { width:6px; height:6px; border-radius:50%; background:var(--accent-2); }
        .trace-arg { color:#9aa3ba; }
        .status-line { display:flex; align-items:center; gap:8px; color:var(--accent); font-size:13px; margin:6px 0; }
        .status-line .pulse { color:var(--accent-2); }
        .cites { display:flex; flex-direction:column; gap:6px; margin-top:14px; }
        .cite-card { display:flex; align-items:center; gap:10px; text-align:left; background:var(--panel-2);
                     border:1px solid var(--border); border-radius:10px; padding:8px 10px; cursor:pointer; transition:border-color .15s; }
        .cite-card:hover { border-color:var(--accent); }
        .cite-num { width:20px; height:20px; flex:none; display:grid; place-items:center; background:#1c2136;
                    border:1px solid #33406b; border-radius:6px; color:var(--accent); font-size:11px; font-family:ui-monospace,monospace; }
        .cite-path { font-size:12.5px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cite-lines { color:var(--muted); font-size:12px; margin-left:auto; }
        .usage { display:flex; flex-wrap:wrap; gap:12px; margin-top:12px; font-size:11.5px; color:var(--muted); align-items:center; }
        .chip-live { color:var(--accent-2); border-color:#2c5b4c; }
        .composer { display:flex; gap:10px; padding:14px; border-top:1px solid var(--border); background:var(--panel); }
      `}</style>
    </div>
  );
}
