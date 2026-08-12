/**
 * Eval runner + CI regression gate.
 *
 *   npm run eval          # run, print a table, write evals/results.json
 *   npm run eval -- --ci  # additionally FAIL (exit 1) if below thresholds
 *
 * The gate is what makes retrieval quality a first-class, defended invariant:
 * a PR that regresses recall or MRR on the golden set breaks the build.
 */
import { writeFile } from "node:fs/promises";
import { runEval } from "@/lib/eval/harness";

// Thresholds are set against the local hashing-embedding baseline so CI is
// hermetic. With OpenAI embeddings the real numbers are materially higher; these
// are a floor that must not regress, not a target.
const HYBRID = "hybrid (RRF)";
const GATE = { recallAt5: 0.75, mrr: 0.6, ndcgAt10: 0.65 };

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

function bar(x: number, width = 18): string {
  const filled = Math.max(0, Math.min(width, Math.round(x * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function main() {
  process.env.PGLITE_DIR ??= "memory";
  const ci = process.argv.includes("--ci");
  console.log("\n  RepoMind — retrieval eval\n  " + "─".repeat(52));

  const report = await runEval();
  console.log(`  backend: ${report.backend}   embeddings: ${report.embeddingModel}`);
  console.log(`  golden cases: ${report.perConfig[0]?.metrics.n}\n`);

  console.log("  Configuration      Recall@5   MRR      nDCG@10  Hit@5");
  console.log("  " + "─".repeat(52));
  for (const { config, metrics } of report.perConfig) {
    console.log(
      "  " +
        config.padEnd(18) +
        pct(metrics.recallAt5).padStart(7) +
        "  " +
        metrics.mrr.toFixed(3).padStart(6) +
        "   " +
        pct(metrics.ndcgAt10).padStart(7) +
        "  " +
        pct(metrics.hitAt5).padStart(6),
    );
  }

  const hybrid = report.perConfig.find((c) => c.config === HYBRID)!.metrics;
  console.log("\n  Hybrid pipeline quality");
  console.log("  " + "─".repeat(52));
  console.log(`  Recall@5   ${bar(hybrid.recallAt5)}  ${pct(hybrid.recallAt5)}`);
  console.log(`  MRR        ${bar(hybrid.mrr)}  ${hybrid.mrr.toFixed(3)}`);
  console.log(`  nDCG@10    ${bar(hybrid.ndcgAt10)}  ${pct(hybrid.ndcgAt10)}`);

  const misses = report.perCase.filter((c) => !c.hybridHit);
  if (misses.length) {
    console.log("\n  Misses (no relevant file in top 5):");
    for (const m of misses) console.log(`   ✗ [${m.probes}] ${m.question}`);
  } else {
    console.log("\n  ✓ Every golden question retrieved a relevant file in the top 5.");
  }

  await writeFile("evals/results.json", JSON.stringify(report, null, 2));
  console.log("\n  → wrote evals/results.json\n");

  if (ci) {
    const gate = GATE;
    const failures: string[] = [];
    if (hybrid.recallAt5 < gate.recallAt5)
      failures.push(`recall@5 ${pct(hybrid.recallAt5)} < ${pct(gate.recallAt5)}`);
    if (hybrid.mrr < gate.mrr) failures.push(`mrr ${hybrid.mrr.toFixed(3)} < ${gate.mrr}`);
    if (hybrid.ndcgAt10 < gate.ndcgAt10)
      failures.push(`ndcg@10 ${pct(hybrid.ndcgAt10)} < ${pct(gate.ndcgAt10)}`);
    if (failures.length) {
      console.error("  ✗ CI GATE FAILED:\n   - " + failures.join("\n   - ") + "\n");
      process.exit(1);
    }
    console.log("  ✓ CI gate passed.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
