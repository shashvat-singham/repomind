"use client";
import React from "react";
import type { Citation } from "@/lib/types";
import { Highlight } from "./Highlight";

/**
 * Renders a streamed answer: fenced code blocks get highlighted, inline `code`
 * and **bold** are styled, and bracketed citation markers like [2] become
 * clickable chips that open the matching source in the drawer. This is what
 * makes every claim in the answer traceable to a line of code.
 */
export function AnswerText({
  text,
  citations,
  onCite,
}: {
  text: string;
  citations: Citation[];
  onCite: (c: Citation) => void;
}) {
  const blocks = splitFences(text);
  return (
    <div className="answer">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <div key={i} className="answer-code card">
            <Highlight code={b.content} />
          </div>
        ) : (
          <p key={i} className="answer-p">
            {renderInline(b.content, citations, onCite)}
          </p>
        ),
      )}
      <style>{`
        .answer { font-size:14.5px; line-height:1.65; }
        .answer-p { margin:0 0 0.7rem; white-space:pre-wrap; }
        .answer-code { margin:0.5rem 0 0.8rem; overflow:hidden; background:var(--panel-2); }
        .answer code.inline { background:var(--panel-2); border:1px solid var(--border); border-radius:5px; padding:1px 5px; font-size:0.86em; }
        .cite { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; padding:0 4px;
                margin:0 1px; font-size:11px; border-radius:5px; border:1px solid #33406b; background:#1c2136; color:var(--accent);
                cursor:pointer; vertical-align:middle; font-family:ui-monospace,monospace; }
        .cite:hover { background:#243056; }
      `}</style>
    </div>
  );
}

function splitFences(text: string): { type: "text" | "code"; content: string }[] {
  const out: { type: "text" | "code"; content: string }[] = [];
  const re = /```[a-z0-9]*\n?([\s\S]*?)```/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", content: text.slice(last, m.index) });
    out.push({ type: "code", content: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", content: text.slice(last) });
  return out;
}

function renderInline(
  text: string,
  citations: Citation[],
  onCite: (c: Citation) => void,
): React.ReactNode[] {
  // Tokenise on **bold**, `code`, and [n] citation markers.
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      parts.push(<code key={k++} className="inline mono">{tok.slice(1, -1)}</code>);
    } else {
      const n = Number(tok.slice(1, -1));
      const c = citations[n - 1];
      parts.push(
        c ? (
          <span key={k++} className="cite" title={`${c.path}:${c.startLine}`} onClick={() => onCite(c)}>
            {n}
          </span>
        ) : (
          <span key={k++}>{tok}</span>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
