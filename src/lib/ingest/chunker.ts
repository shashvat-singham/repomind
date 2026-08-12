import { createHash } from "node:crypto";

/**
 * AST-aware code chunker.
 *
 * A naive RAG pipeline slices files into fixed 500-token windows, which cuts
 * functions in half and destroys the very structure a code question is about.
 * RepoMind instead splits on *symbol boundaries* — functions, classes, methods,
 * types — so each chunk is a semantically complete unit with a real name we can
 * cite ("`getUserToken` in auth/session.ts:40").
 *
 * We use language-specific brace/indent heuristics rather than a full parser per
 * language: that keeps the ingest path dependency-free and fast, degrades
 * gracefully to a sliding window for anything unrecognised, and — crucially —
 * still recovers the symbol name and line range, which is what retrieval and
 * citations actually need. Oversized symbols are further split with overlap so
 * no single chunk blows the embedding token budget.
 */

export interface CodeChunk {
  path: string;
  lang: string;
  symbol: string | null;
  symbolKind: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}

const MAX_CHUNK_LINES = 120;
const OVERLAP_LINES = 12;
const MIN_CHUNK_CHARS = 24;

export function detectLang(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", go: "go", rs: "rust", java: "java", rb: "ruby",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", swift: "swift", kt: "kotlin", scala: "scala",
    md: "markdown", mdx: "markdown", json: "json", yaml: "yaml", yml: "yaml",
    toml: "toml", sql: "sql", sh: "bash", css: "css", html: "html",
  };
  return map[ext] ?? "text";
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** Signature patterns per language family → [regex, kind]. */
const SIGNATURES: { langs: Set<string>; patterns: [RegExp, string][] }[] = [
  {
    langs: new Set(["typescript", "javascript"]),
    patterns: [
      [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/, "function"],
      [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/, "class"],
      [/^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/, "interface"],
      [/^\s*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/, "type"],
      [/^\s*(?:export\s+)?enum\s+([A-Za-z0-9_$]+)/, "enum"],
      [/^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/, "function"],
      [/^\s*(?:public|private|protected|static|async|\s)*\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?::[^{]+)?\{/, "method"],
    ],
  },
  {
    langs: new Set(["python"]),
    patterns: [
      [/^\s*def\s+([A-Za-z0-9_]+)/, "function"],
      [/^\s*async\s+def\s+([A-Za-z0-9_]+)/, "function"],
      [/^\s*class\s+([A-Za-z0-9_]+)/, "class"],
    ],
  },
  {
    langs: new Set(["go"]),
    patterns: [
      [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/, "function"],
      [/^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/, "type"],
    ],
  },
  {
    langs: new Set(["rust"]),
    patterns: [
      [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/, "function"],
      [/^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/, "struct"],
      [/^\s*(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/, "enum"],
      [/^\s*(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/, "trait"],
      [/^\s*impl(?:<[^>]*>)?\s+([A-Za-z0-9_]+)/, "impl"],
    ],
  },
  {
    langs: new Set(["java", "csharp", "cpp", "c", "kotlin", "scala", "swift", "php"]),
    patterns: [
      [/^\s*(?:public|private|protected|internal|static|final|abstract|\s)*\s*(?:class|interface|struct|enum)\s+([A-Za-z0-9_]+)/, "class"],
      [/^\s*(?:public|private|protected|internal|static|final|virtual|override|async|\s)*[A-Za-z0-9_<>,.\[\]]+\s+([A-Za-z0-9_]+)\s*\([^;]*\)\s*\{/, "method"],
    ],
  },
];

function matchSignature(line: string, lang: string): { symbol: string; kind: string } | null {
  for (const group of SIGNATURES) {
    if (!group.langs.has(lang)) continue;
    for (const [re, kind] of group.patterns) {
      const m = re.exec(line);
      if (m && m[1]) return { symbol: m[1], kind };
    }
  }
  return null;
}

/**
 * Detect symbol boundaries and produce one chunk per top-level symbol. Lines
 * before the first symbol (imports, module docstring) become a leading chunk so
 * nothing is dropped.
 */
export function chunkFile(path: string, source: string): CodeChunk[] {
  const lang = detectLang(path);
  const lines = source.split("\n");

  // Structured languages: split on symbol signatures at low indentation.
  if (lang !== "text" && lang !== "markdown" && lang !== "json") {
    const boundaries: { line: number; symbol: string; kind: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      const indent = raw.length - raw.trimStart().length;
      // Only top-level (unindented) signatures start a new chunk, so a class
      // stays whole with its methods instead of fragmenting into one-line
      // stubs. Oversized top-level symbols are windowed later by pushRange.
      if (indent > 0) continue;
      const sig = matchSignature(raw, lang);
      if (sig) boundaries.push({ line: i, symbol: sig.symbol, kind: sig.kind });
    }

    if (boundaries.length > 0) {
      const chunks: CodeChunk[] = [];
      const first = boundaries[0]!;
      if (first.line > 0) {
        pushRange(chunks, path, lang, lines, 0, first.line - 1, null, "preamble");
      }
      for (let b = 0; b < boundaries.length; b++) {
        const cur = boundaries[b]!;
        const next = boundaries[b + 1];
        const end = next ? next.line - 1 : lines.length - 1;
        pushRange(chunks, path, lang, lines, cur.line, end, cur.symbol, cur.kind);
      }
      return chunks.filter((c) => c.content.trim().length >= MIN_CHUNK_CHARS);
    }
  }

  // Markdown: split on headings so each section is a coherent chunk.
  if (lang === "markdown") {
    return chunkMarkdown(path, lines);
  }

  // Fallback: sliding window with overlap.
  return slidingWindow(path, lang, lines, 0, null, "file");
}

function pushRange(
  out: CodeChunk[],
  path: string,
  lang: string,
  lines: string[],
  start: number,
  end: number,
  symbol: string | null,
  kind: string,
): void {
  const span = end - start + 1;
  if (span <= MAX_CHUNK_LINES) {
    out.push(makeChunk(path, lang, lines, start, end, symbol, kind));
    return;
  }
  // Oversized symbol → window it with overlap, keeping the symbol name on each.
  const windows = slidingWindow(path, lang, lines, start, symbol, kind, end);
  out.push(...windows);
}

function slidingWindow(
  path: string,
  lang: string,
  lines: string[],
  start: number,
  symbol: string | null,
  kind: string,
  end = lines.length - 1,
): CodeChunk[] {
  const out: CodeChunk[] = [];
  let i = start;
  while (i <= end) {
    const winEnd = Math.min(i + MAX_CHUNK_LINES - 1, end);
    out.push(makeChunk(path, lang, lines, i, winEnd, symbol, kind));
    if (winEnd >= end) break;
    i = winEnd - OVERLAP_LINES + 1;
  }
  return out.filter((c) => c.content.trim().length >= MIN_CHUNK_CHARS);
}

function chunkMarkdown(path: string, lines: string[]): CodeChunk[] {
  const out: CodeChunk[] = [];
  let sectionStart = 0;
  let heading: string | null = null;
  const flush = (end: number) => {
    if (end < sectionStart) return;
    pushRange(out, path, "markdown", lines, sectionStart, end, heading, "section");
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,3}\s+(.+)/.exec(lines[i] ?? "");
    if (m) {
      flush(i - 1);
      sectionStart = i;
      heading = m[1]!.trim();
    }
  }
  flush(lines.length - 1);
  return out.filter((c) => c.content.trim().length >= MIN_CHUNK_CHARS);
}

function makeChunk(
  path: string,
  lang: string,
  lines: string[],
  start: number,
  end: number,
  symbol: string | null,
  kind: string,
): CodeChunk {
  const content = lines.slice(start, end + 1).join("\n");
  return {
    path,
    lang,
    symbol,
    // Carry the structural kind even when there's no symbol name (preamble,
    // markdown section, whole-file window) — it's useful metadata downstream.
    symbolKind: kind,
    startLine: start + 1, // 1-indexed for humans + citations
    endLine: end + 1,
    content,
    contentHash: sha1(`${path}:${start}:${content}`),
  };
}
