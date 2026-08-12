"use client";
import React from "react";

/**
 * Tiny, dependency-free syntax highlighter for the code drawer. A full grammar
 * engine (Shiki/Prism) would bloat the client bundle for what is a supporting
 * view; this covers the token classes that matter for reading code at a glance —
 * comments, strings, keywords, numbers — across the languages we index, and
 * renders with line numbers. Deliberately approximate, intentionally light.
 */

const KEYWORDS = new Set([
  "import", "from", "export", "default", "const", "let", "var", "function", "return",
  "class", "interface", "type", "enum", "extends", "implements", "public", "private",
  "protected", "static", "async", "await", "new", "if", "else", "for", "while", "switch",
  "case", "break", "continue", "throw", "try", "catch", "finally", "def", "self", "None",
  "True", "False", "func", "struct", "impl", "trait", "pub", "fn", "package", "go", "defer",
  "null", "undefined", "void", "boolean", "number", "string", "in", "of", "as", "yield",
]);

function classFor(token: string): string | null {
  if (KEYWORDS.has(token)) return "kw";
  if (/^\d/.test(token)) return "num";
  return null;
}

function renderLine(line: string, key: number): React.ReactNode {
  // Full-line comment.
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return <span key={key} className="hl-comment">{line}</span>;
  }
  const parts: React.ReactNode[] = [];
  // Split on strings first, then tokenise the rest.
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push(...tokenise(line.slice(last, m.index), key * 1000 + idx++));
    parts.push(<span key={`s${key}-${idx++}`} className="hl-str">{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(...tokenise(line.slice(last), key * 1000 + idx++));
  return <>{parts}</>;
}

function tokenise(text: string, baseKey: number): React.ReactNode[] {
  return text.split(/(\b)/).map((tok, i) => {
    const cls = classFor(tok);
    return cls ? (
      <span key={`${baseKey}-${i}`} className={`hl-${cls}`}>{tok}</span>
    ) : (
      <React.Fragment key={`${baseKey}-${i}`}>{tok}</React.Fragment>
    );
  });
}

export function Highlight({
  code,
  startLine = 1,
  highlightRange,
}: {
  code: string;
  startLine?: number;
  highlightRange?: [number, number];
}) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <pre className="hl mono">
      <code>
        {lines.map((line, i) => {
          const lineNo = startLine + i;
          const active =
            highlightRange && lineNo >= highlightRange[0] && lineNo <= highlightRange[1];
          return (
            <div key={i} className={`hl-line${active ? " hl-active" : ""}`}>
              <span className="hl-gutter">{lineNo}</span>
              <span className="hl-code">{renderLine(line, i)}</span>
            </div>
          );
        })}
      </code>
      <style>{`
        .hl { margin:0; padding:0.5rem 0; overflow:auto; font-size:12.5px; line-height:1.55; background:transparent; }
        .hl-line { display:flex; padding:0 0.75rem; white-space:pre; }
        .hl-active { background:rgba(110,168,254,0.10); box-shadow: inset 2px 0 0 var(--accent); }
        .hl-gutter { color:#4b5163; user-select:none; width:2.5rem; text-align:right; padding-right:1rem; flex:none; }
        .hl-code { flex:1; }
        .hl-comment { color:#5f6675; font-style:italic; }
        .hl-str { color:#7ee2c9; }
        .hl-kw { color:#c792ea; }
        .hl-num { color:#f78c6c; }
      `}</style>
    </pre>
  );
}
