/**
 * Phase 8A stress: with maxCandidates=60, do we find ANY supports with
 * non-trivial deltas? If yes, our screening works and the issue is ranking.
 * If no, something deeper is wrong.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";
import { suggestGemLink } from "../build/theorycraft.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const bridge = new LuaBridge({ forkPath, timeoutMs: 120_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "stress" } });

console.log("Running suggestGemLink with maxCandidates=60...");
const r = await suggestGemLink(bridge, forkPath, { maxCandidates: 60, limit: 20 });
console.log(`  main active: ${r.mainActiveSkill}  tags=${r.mainActiveTags.join(", ")}`);
console.log(`  baseline ${r.targetMetric}: ${r.baseline}`);
console.log(`  screened: ${r.considered.candidatesScreened}, tested: ${r.considered.candidatesTested}, source: ${r.considered.screenSource}`);
console.log(`  elapsed: ${r.elapsedMs}ms\n`);

// Show all proposals — including 0-delta — to spot the cutoff
const nonZero = r.proposals.filter((p) => p.delta !== 0);
const zero = r.proposals.filter((p) => p.delta === 0);
console.log(`Non-zero proposals: ${nonZero.length}`);
for (const [i, p] of nonZero.entries()) {
  const sign = p.delta > 0 ? "+" : "";
  console.log(`  ${i + 1}. ${p.candidate.name} (tier ${p.candidate.tier})`);
  console.log(`     Δ=${sign}${p.delta} (${p.pct}%)   tags: ${p.candidate.tags.join(", ")}`);
}
console.log(`\nZero-delta count in top-${r.proposals.length}: ${zero.length}`);

await bridge.stop();
