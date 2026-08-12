import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Hermetic, fast DB for CI: in-memory PGlite, no disk artifacts.
    env: { PGLITE_DIR: "memory" },
    // PGlite migrations + wasm boot need headroom on a cold run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
  },
});
