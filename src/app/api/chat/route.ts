import { NextRequest } from "next/server";
import { runAgent, type AgentEvent } from "@/lib/agent/engine";
import { screenQuestion } from "@/lib/agent/guardrails";
import { lookupCache, storeCache } from "@/lib/agent/cache";
import { rateLimit, clientKey } from "@/lib/agent/ratelimit";
import { hasLLM } from "@/lib/models/llm";
import { logQuery } from "@/lib/obs/log";
import { sseFromGenerator } from "@/lib/sse";
import type { SearchHit } from "@/lib/agent/tools-core";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Streaming chat endpoint. Wraps the answer engine with the full production
 * pipeline: rate limiting → injection screening → semantic cache → answer
 * stream → telemetry. Everything is emitted as SSE for the live UI.
 */
export async function POST(req: NextRequest) {
  const { repoId, question, history } = (await req.json()) as {
    repoId?: string;
    question?: string;
    history?: { role: "user" | "assistant"; content: string }[];
  };

  if (!repoId || !question) {
    return Response.json({ error: "repoId and question are required" }, { status: 400 });
  }

  const rl = rateLimit(clientKey(req));
  if (!rl.allowed) {
    return Response.json(
      { error: `Rate limit reached. Try again in ${Math.ceil(rl.resetInMs / 1000)}s.` },
      { status: 429 },
    );
  }

  const guard = screenQuestion(question);

  const gen = orchestrate(repoId, guard.clean, guard.injection, history);
  return sseFromGenerator(gen);
}

async function* orchestrate(
  repoId: string,
  question: string,
  injection: boolean,
  history?: { role: "user" | "assistant"; content: string }[],
): AsyncGenerator<AgentEvent> {
  const started = Date.now();

  if (injection) {
    yield {
      type: "status",
      stage: "generating",
      detail: "⚠ possible prompt-injection detected — answering with hardened guard",
    };
  }

  // 1) Semantic cache (skip when there's conversation history — context matters).
  if (!history || history.length === 0) {
    yield { type: "status", stage: "cache", detail: "checking semantic cache" };
    try {
      const cached = await lookupCache(repoId, question);
      if (cached) {
        const payload = cached.answer as { answer: string; citations: SearchHit[] };
        yield {
          type: "status",
          stage: "generating",
          detail: `cache hit (${(cached.similarity * 100).toFixed(0)}% similar to "${cached.question.slice(0, 60)}")`,
        };
        if (payload.citations) yield { type: "citations", items: payload.citations };
        for (const chunk of payload.answer.match(/\S+\s*/g) ?? [payload.answer]) {
          yield { type: "token", text: chunk };
        }
        yield {
          type: "done",
          answer: payload.answer,
          usage: {
            mode: "local",
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            retrieveMs: 0,
            generateMs: 0,
            totalMs: Date.now() - started,
          },
        };
        await logQuery({
          repoId, question, mode: "cache", latencyMs: Date.now() - started,
          retrieveMs: 0, generateMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
          cacheHit: true, nRetrieved: payload.citations?.length ?? 0, injection,
        });
        return;
      }
    } catch {
      /* cache is best-effort */
    }
  }

  // 2) Run the agent, forwarding every event and capturing the final answer.
  let finalAnswer = "";
  let citations: SearchHit[] = [];
  let usage: Extract<AgentEvent, { type: "done" }>["usage"] | null = null;

  for await (const ev of runAgent({ repoId, question, history })) {
    if (ev.type === "citations") citations = ev.items;
    if (ev.type === "done") {
      finalAnswer = ev.answer;
      usage = ev.usage;
    }
    yield ev;
  }

  // 3) Persist to cache + telemetry (only cache substantive, no-history answers).
  // A "local" answer while an LLM is configured means the model call failed and
  // we degraded. Caching that would keep serving the fallback long after the
  // provider recovers, so skip it.
  const degraded = hasLLM && usage?.mode === "local";
  if (finalAnswer && !degraded && (!history || history.length === 0)) {
    await storeCache(repoId, question, { answer: finalAnswer, citations }).catch(() => {});
  }
  if (usage) {
    await logQuery({
      repoId, question, mode: usage.mode, latencyMs: usage.totalMs,
      retrieveMs: usage.retrieveMs, generateMs: usage.generateMs,
      tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd,
      cacheHit: false, nRetrieved: citations.length, injection,
    });
  }
}
