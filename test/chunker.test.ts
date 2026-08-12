import { describe, it, expect } from "vitest";
import { chunkFile, detectLang } from "@/lib/ingest/chunker";

describe("detectLang", () => {
  it("maps common extensions", () => {
    expect(detectLang("src/a.ts")).toBe("typescript");
    expect(detectLang("main.py")).toBe("python");
    expect(detectLang("lib.rs")).toBe("rust");
    expect(detectLang("README.md")).toBe("markdown");
    expect(detectLang("Makefile")).toBe("text");
  });
});

describe("chunkFile (TypeScript)", () => {
  const src = `import { z } from "zod";

export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private total = 0;
  add(n: number) {
    this.total += n;
    return this;
  }
}

export const multiply = (a: number, b: number) => a * b;
`;

  it("splits on symbol boundaries and names the symbols", () => {
    const chunks = chunkFile("src/math.ts", src);
    const symbols = chunks.map((c) => c.symbol).filter(Boolean);
    expect(symbols).toContain("add");
    expect(symbols).toContain("Calculator");
    expect(symbols).toContain("multiply");
  });

  it("produces 1-indexed, non-overlapping-ish line ranges within the file", () => {
    const chunks = chunkFile("src/math.ts", src);
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
    // the `add` function chunk should start at its declaration line
    const addChunk = chunks.find((c) => c.symbol === "add" && c.symbolKind === "function");
    expect(addChunk).toBeDefined();
    expect(src.split("\n")[addChunk!.startLine - 1]).toContain("function add");
  });

  it("captures import preamble as its own chunk", () => {
    const chunks = chunkFile("src/math.ts", src);
    const preamble = chunks.find((c) => c.symbolKind === "preamble");
    expect(preamble?.content).toContain("import");
  });
});

describe("chunkFile (Python)", () => {
  it("detects def and class", () => {
    const py = `import os

def load_config(path):
    return open(path).read()

class Server:
    def start(self):
        pass
`;
    const chunks = chunkFile("app.py", py);
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toContain("load_config");
    expect(symbols).toContain("Server");
  });
});

describe("chunkFile (fallback)", () => {
  it("windows unknown languages without dropping content", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkFile("data.txt", text);
    expect(chunks.length).toBeGreaterThan(1);
    // every original line should appear in at least one chunk
    expect(chunks.some((c) => c.content.includes("line 0"))).toBe(true);
    expect(chunks.some((c) => c.content.includes("line 299"))).toBe(true);
  });
});
