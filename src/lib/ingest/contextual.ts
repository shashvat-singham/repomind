import { generateText } from "ai";
import { getChatModel, extractiveSummary } from "@/lib/models/llm";
import type { CodeChunk } from "@/lib/ingest/chunker";

/**
 * Contextual Retrieval (after Anthropic's technique): before embedding a chunk,
 * prepend a short, situating description of where it lives and what it does.
 * A bare function body is ambiguous ("what does `handle` handle?"); the same
 * body prefixed with "This is the request handler for the /login route in
 * auth/routes.ts, which validates credentials and issues a session cookie"
 * embeds into a far more retrievable point in space. Anthropic reported this
 * cuts failed-retrieval rate substantially, and it's cheap because the context
 * is generated once at ingest, not per query.
 *
 * With an LLM available we generate the context with a tiny, cache-friendly
 * prompt. Without one, we synthesise a deterministic context from the file path,
 * symbol name/kind, and an extractive line — no hallucination, still useful.
 */

export interface EnrichedChunk extends CodeChunk {
  context: string;
  /** What gets embedded: context + a header + the code. */
  embedText: string;
}

function deterministicContext(chunk: CodeChunk, repoSlug: string): string {
  const where = chunk.symbol
    ? `The ${chunk.symbolKind ?? "symbol"} \`${chunk.symbol}\``
    : `Lines ${chunk.startLine}-${chunk.endLine}`;
  const gist = extractiveSummary(stripCode(chunk.content), chunk.symbol ?? chunk.path, 1);
  const base = `${where} in ${chunk.path} of repository ${repoSlug} (${chunk.lang}).`;
  return gist ? `${base} ${gist}` : base;
}

/** Remove obvious syntax noise so the extractive summary picks prose/comments. */
function stripCode(content: string): string {
  return content
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") || t.startsWith("#") || /[a-z]{4,}/i.test(t);
    })
    .join(" ")
    .slice(0, 800);
}

async function llmContext(chunk: CodeChunk, repoSlug: string): Promise<string> {
  const model = getChatModel();
  if (!model) return deterministicContext(chunk, repoSlug);
  try {
    const { text } = await generateText({
      model,
      // Keep this deterministic and short; it runs once per chunk at ingest.
      temperature: 0,
      system:
        "You situate a code chunk for a search index. In 1-2 sentences, say what this code does and how it fits its file/module. Name the key symbols. No preamble, no code fences.",
      prompt: `Repository: ${repoSlug}\nFile: ${chunk.path}\nSymbol: ${chunk.symbol ?? "(top of file)"}\n\n\`\`\`${chunk.lang}\n${chunk.content.slice(0, 1600)}\n\`\`\`\n\nContext:`,
    });
    return text.trim() || deterministicContext(chunk, repoSlug);
  } catch {
    return deterministicContext(chunk, repoSlug);
  }
}

export async function enrichChunk(
  chunk: CodeChunk,
  repoSlug: string,
  useLLM: boolean,
): Promise<EnrichedChunk> {
  const context = useLLM
    ? await llmContext(chunk, repoSlug)
    : deterministicContext(chunk, repoSlug);
  const header = chunk.symbol
    ? `${chunk.path} — ${chunk.symbolKind} ${chunk.symbol} (lines ${chunk.startLine}-${chunk.endLine})`
    : `${chunk.path} (lines ${chunk.startLine}-${chunk.endLine})`;
  const embedText = `${context}\n\n${header}\n${chunk.content}`;
  return { ...chunk, context, embedText };
}
