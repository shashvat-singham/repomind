import { streamText, stepCountIs, type ModelMessage } from "ai";
import { getChatModel } from "@/lib/models/llm";
import { config } from "@/lib/config";
import { countTokens, estimateCost } from "@/lib/obs/tokens";
import { buildTools, SYSTEM_PROMPT, type ToolContext } from "@/lib/agent/tools";
import { searchCode, type SearchHit } from "@/lib/agent/tools-core";
import { synthesizeLocalAnswer } from "@/lib/agent/local-answer";
import type { SearchHit as Hit } from "@/lib/agent/tools-core";

/**
 * The answer engine. Emits a single, transport-agnostic event stream consumed by
 * both the SSE chat route and the eval harness. Two execution paths behind the
 * same events:
 *
 *   • LLM path (OpenAI key present): a real agentic loop — the model decides
 *     which repo tools to call, up to a step budget, then writes a grounded
 *     answer that streams token-by-token.
 *   • Local path (no key): deterministic retrieve → extractive synthesis, so the
 *     product is fully demonstrable offline with the same citations and trace.
 */

export type AgentEvent =
  | { type: "status"; stage: "cache" | "retrieving" | "reranking" | "generating"; detail?: string }
  | { type: "trace"; tool: string; args: Record<string, unknown>; resultCount?: number }
  | { type: "token"; text: string }
  | { type: "citations"; items: SearchHit[] }
  | {
      type: "done";
      answer: string;
      usage: {
        mode: "openai" | "local";
        tokensIn: number;
        tokensOut: number;
        costUsd: number;
        retrieveMs: number;
        generateMs: number;
        totalMs: number;
      };
    }
  | { type: "error"; message: string };

export interface AskInput {
  repoId: string;
  question: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

export async function* runAgent(input: AskInput): AsyncGenerator<AgentEvent> {
  const model = getChatModel();
  if (model) {
    yield* runLLM(input, model);
  } else {
    yield* runLocal(input);
  }
}

// ── LLM agentic path ────────────────────────────────────────────────────────

async function* runLLM(
  input: AskInput,
  model: NonNullable<ReturnType<typeof getChatModel>>,
): AsyncGenerator<AgentEvent> {
  const t0 = Date.now();
  const ctx: ToolContext = { repoId: input.repoId, citations: [], trace: [] };
  const tools = buildTools(ctx);

  yield { type: "status", stage: "retrieving", detail: "agent selecting tools" };

  const messages: ModelMessage[] = [
    ...(input.history ?? []).map(
      (m): ModelMessage => ({ role: m.role, content: m.content }),
    ),
    { role: "user", content: input.question },
  ];

  let answer = "";
  let firstToken = 0;
  try {
    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      // Bounded agent loop: the model may call tools then must answer.
      stopWhen: stepCountIs(6),
      temperature: 0,
    });

    let emittedTraceCount = 0;
    for await (const part of result.fullStream) {
      if (part.type === "tool-call") {
        // Surface any new tool-trace entries the execute() callbacks recorded.
        while (emittedTraceCount < ctx.trace.length) {
          const t = ctx.trace[emittedTraceCount]!;
          yield { type: "trace", tool: t.tool, args: t.args, resultCount: t.resultCount };
          emittedTraceCount++;
        }
      } else if (part.type === "text-delta") {
        if (firstToken === 0) {
          firstToken = Date.now();
          yield { type: "status", stage: "generating" };
        }
        answer += part.text;
        yield { type: "token", text: part.text };
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    // Drain any trailing trace entries.
    while (emittedTraceCount < ctx.trace.length) {
      const t = ctx.trace[emittedTraceCount]!;
      yield { type: "trace", tool: t.tool, args: t.args, resultCount: t.resultCount };
      emittedTraceCount++;
    }

    const usage = await Promise.resolve(result.usage).catch(() => null);
    yield { type: "citations", items: dedupeCitations(ctx.citations) };
    const tokensIn = usage?.inputTokens ?? countTokens(input.question + SYSTEM_PROMPT);
    const tokensOut = usage?.outputTokens ?? countTokens(answer);
    yield {
      type: "done",
      answer,
      usage: {
        mode: "openai",
        tokensIn,
        tokensOut,
        costUsd: estimateCost(config.chatModel, tokensIn, tokensOut),
        retrieveMs: (firstToken || Date.now()) - t0,
        generateMs: Date.now() - (firstToken || Date.now()),
        totalMs: Date.now() - t0,
      },
    };
  } catch (e) {
    // Any LLM/tool failure degrades to the local path rather than 500ing.
    yield { type: "status", stage: "generating", detail: "LLM unavailable — using local synthesis" };
    yield* runLocal(input);
  }
}

// ── Local deterministic path ────────────────────────────────────────────────

async function* runLocal(input: AskInput): AsyncGenerator<AgentEvent> {
  const t0 = Date.now();
  yield { type: "status", stage: "retrieving" };
  yield { type: "trace", tool: "search_code", args: { query: input.question, k: 8 } };

  let hits: Hit[] = [];
  try {
    hits = await searchCode(input.repoId, input.question, 8);
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
    return;
  }
  const retrieveMs = Date.now() - t0;
  yield { type: "status", stage: "reranking" };
  yield { type: "citations", items: hits };

  yield { type: "status", stage: "generating" };
  const gStart = Date.now();
  const answer = synthesizeLocalAnswer(input.question, hits);
  // Stream it out in word chunks so the UI feels live even offline.
  for (const chunk of chunkText(answer)) {
    yield { type: "token", text: chunk };
  }

  yield {
    type: "done",
    answer,
    usage: {
      mode: "local",
      tokensIn: countTokens(input.question),
      tokensOut: countTokens(answer),
      costUsd: 0,
      retrieveMs,
      generateMs: Date.now() - gStart,
      totalMs: Date.now() - t0,
    },
  };
}

function chunkText(text: string): string[] {
  // Split into ~5-word chunks, preserving whitespace.
  const parts = text.match(/\S+\s*/g) ?? [text];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 4) {
    out.push(parts.slice(i, i + 4).join(""));
  }
  return out;
}

function dedupeCitations(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = `${h.path}:${h.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out.slice(0, 10);
}
