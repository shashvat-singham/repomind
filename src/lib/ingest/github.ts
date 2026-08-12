import { extract } from "tar-stream";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { config } from "@/lib/config";

/**
 * Fetches a GitHub repo as a single gzipped tarball and streams it, rather than
 * making one API call per file. One HTTP request pulls the whole tree, which is
 * dramatically faster and cheaper on rate limit than the contents API. We never
 * write to disk — the tar is decoded in memory and filtered as it streams.
 */

export interface RepoRef {
  owner: string;
  name: string;
  ref: string; // branch, tag, or sha; "HEAD" resolves to the default branch
}

export interface RepoFile {
  path: string;
  content: string;
  bytes: number;
}

export function parseRepoInput(input: string): RepoRef {
  const trimmed = input.trim().replace(/\.git$/, "");
  // Accept full URLs, owner/name, and owner/name/tree/branch forms.
  const url = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/tree\/([^/]+))?$/);
  if (url) {
    return { owner: url[1]!, name: url[2]!, ref: url[3] ?? "HEAD" };
  }
  const short = trimmed.match(/^([^/\s]+)\/([^/@\s]+)(?:@(.+))?$/);
  if (short) {
    return { owner: short[1]!, name: short[2]!, ref: short[3] ?? "HEAD" };
  }
  throw new Error(
    `Could not parse "${input}". Use owner/name, owner/name@ref, or a github.com URL.`,
  );
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "vendor",
  "target", ".venv", "venv", "__pycache__", ".idea", ".vscode",
  "coverage", ".turbo", ".cache", "bin", "obj",
]);

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "rs", "java", "rb", "c", "h", "cpp", "cc", "hpp",
  "cs", "php", "swift", "kt", "scala", "sql", "sh",
  "md", "mdx", "json", "yaml", "yml", "toml", "css", "html",
]);

const MAX_FILE_BYTES = 200_000; // skip huge generated/minified files
const MAX_FILES = 1500; // safety cap so one giant repo can't exhaust a request

function shouldIndex(path: string, bytes: number): boolean {
  if (bytes > MAX_FILE_BYTES || bytes === 0) return false;
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const name = parts[parts.length - 1] ?? "";
  if (name.endsWith(".min.js") || name.endsWith(".min.css")) return false;
  if (name.endsWith(".lock") || name === "package-lock.json" || name === "yarn.lock") return false;
  if (name.endsWith(".map")) return false;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return CODE_EXTS.has(ext);
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "RepoMind-Ingestor",
    Accept: "application/vnd.github+json",
  };
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
}

/** Resolve HEAD → the repo's actual default branch + latest commit sha. */
export async function resolveRef(
  ref: RepoRef,
): Promise<{ ref: string; sha: string | null }> {
  const res = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.name}`,
    { headers: ghHeaders() },
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Repo ${ref.owner}/${ref.name} not found (or private).`);
    if (res.status === 403) throw new Error("GitHub rate limit hit. Set GITHUB_TOKEN to raise it.");
    throw new Error(`GitHub API error ${res.status}.`);
  }
  const json = (await res.json()) as { default_branch: string };
  const branch = ref.ref === "HEAD" ? json.default_branch : ref.ref;
  // Best-effort sha; not fatal if it fails.
  let sha: string | null = null;
  try {
    const b = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.name}/commits/${branch}`,
      { headers: ghHeaders() },
    );
    if (b.ok) sha = ((await b.json()) as { sha: string }).sha.slice(0, 12);
  } catch {
    /* ignore */
  }
  return { ref: branch, sha };
}

/**
 * Streams the tarball for a ref and yields indexable files. Async generator so
 * the caller can embed/insert incrementally and report progress without holding
 * the whole repo in memory at once.
 */
export async function* streamRepoFiles(
  ref: RepoRef,
  resolvedRef: string,
): AsyncGenerator<RepoFile> {
  const url = `https://codeload.github.com/${ref.owner}/${ref.name}/tar.gz/${resolvedRef}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok || !res.body) {
    throw new Error(`Could not download tarball (${res.status}) for ${ref.owner}/${ref.name}@${resolvedRef}.`);
  }

  const gunzip = createGunzip();
  const tar = extract();
  // Bridge the web ReadableStream → node stream → gunzip → tar.
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.pipe(gunzip).pipe(tar);

  let emitted = 0;
  for await (const entry of tar as unknown as AsyncIterable<TarEntry>) {
    const header = entry.header;
    if (header.type !== "file") {
      entry.resume();
      continue;
    }
    // GitHub tars are rooted at "<repo>-<sha>/..."; strip that first segment.
    const rel = header.name.split("/").slice(1).join("/");
    const bytes = header.size ?? 0;
    if (!rel || !shouldIndex(rel, bytes) || emitted >= MAX_FILES) {
      entry.resume();
      continue;
    }
    const chunks: Buffer[] = [];
    for await (const c of entry as unknown as AsyncIterable<Buffer>) chunks.push(c);
    const buf = Buffer.concat(chunks);
    // Skip files that look binary (a NUL byte in the first 8KB) despite a
    // code-ish extension — e.g. a checked-in binary renamed to a code ext.
    if (buf.subarray(0, 8192).includes(0)) {
      entry.resume();
      continue;
    }
    const content = buf.toString("utf8");
    emitted++;
    yield { path: rel, content, bytes };
  }
}

interface TarEntry {
  header: { name: string; type: string; size?: number };
  resume(): void;
}
