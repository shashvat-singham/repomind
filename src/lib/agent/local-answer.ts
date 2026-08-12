import { extractiveSummary } from "@/lib/models/llm";
import type { SearchHit } from "@/lib/agent/tools-core";

/**
 * Deterministic answer synthesis for the no-LLM path. It cannot reason like a
 * model, so it does the honest thing: it tells you exactly what the retriever
 * found, where, and quotes the most on-point lines — with citation markers the
 * UI turns into clickable links. Every sentence is traceable to a real chunk, so
 * there is nothing to hallucinate. The prose is templated but the *content* is
 * fully driven by hybrid retrieval, which is the part being demonstrated.
 */
export function synthesizeLocalAnswer(question: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return "I couldn't find anything in this repository that matches your question. Try naming a specific symbol, file, or feature — or re-index the repo if it looks incomplete.";
  }

  const top = hits[0]!;
  const where = top.symbol
    ? `\`${top.symbol}\` in **${top.path}** (lines ${top.startLine}–${top.endLine})`
    : `**${top.path}** (lines ${top.startLine}–${top.endLine})`;

  const lead = extractiveSummary(stripToProse(top.snippet), question, 2);
  const lines: string[] = [];

  lines.push(
    `The most relevant code is ${where} [1].` +
      (lead ? ` ${capitalize(lead)}` : ""),
  );
  lines.push("");
  lines.push("Here are the key locations I found, ranked by relevance:");
  lines.push("");

  hits.slice(0, 6).forEach((h, i) => {
    const label = h.symbol
      ? `\`${h.symbol}\`${h.symbolKind ? ` (${h.symbolKind})` : ""}`
      : "code";
    lines.push(
      `${i + 1}. ${label} — \`${h.path}:${h.startLine}\` [${i + 1}]` +
        `  ·  relevance ${(h.score * 100).toFixed(0)}%`,
    );
  });

  lines.push("");
  lines.push("Most on-point excerpt:");
  lines.push("");
  lines.push("```" + top.lang);
  lines.push(top.snippet.split("\n").slice(0, 18).join("\n"));
  lines.push("```");
  lines.push("");
  lines.push(
    "_Answer synthesized locally from hybrid retrieval (no LLM key set). " +
      "Add an OpenAI key to enable the full agentic loop with natural-language reasoning over these same citations._",
  );

  return lines.join("\n");
}

/** Keep comment/prose lines, drop pure-syntax noise, for the summary pass. */
function stripToProse(code: string): string {
  return code
    .split("\n")
    .map((l) => l.replace(/^\s*[/*#-]+\s?/, "").trim())
    .filter((l) => l.length > 0 && /[a-z]{4,}/i.test(l))
    .join(" ")
    .slice(0, 600);
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
