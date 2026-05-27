/**
 * Phase 6D smoke: suggest_gem_link on the Monk lvl 13 fixture.
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
const bridge = new LuaBridge({ forkPath, timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

// Confirm what main group looks like before
const skills = await bridge.send({ action: "get_skills" });
const main = (skills.skills.groups ?? []).find((g) => g.index === skills.skills.mainSocketGroup);
console.log(`Main group #${main?.index} '${main?.label ?? ""}' [${main?.slot ?? "—"}]`);
for (const g of main?.gems ?? []) {
  console.log(`  ${g.isSupport ? "└─ support" : "▶  active "}: ${g.nameSpec} L${g.level} Q${g.quality}%`);
}

console.log("\n=== suggest_gem_link (target=TotalDPS, simLevel=20) ===");
const r = await suggestGemLink(bridge, forkPath, { maxCandidates: 30, limit: 8 });
console.log(`  main active: ${r.mainActiveSkill}  tags=${r.mainActiveTags.join(", ") || "(none)"}`);
console.log(`  baseline ${r.targetMetric}: ${r.baseline}`);
console.log(`  considered: screened ${r.considered.candidatesScreened}, tested ${r.considered.candidatesTested}`);
console.log(`  elapsed: ${r.elapsedMs}ms\n`);

for (const [i, p] of r.proposals.entries()) {
  const sign = p.delta > 0 ? "+" : "";
  console.log(`  ${i + 1}. ${p.candidate.name} (tier ${p.candidate.tier})`);
  console.log(`     ${p.baselineMetric} → ${p.withCandidateMetric}  (${sign}${p.delta}${p.pct != null ? `, ${p.pct}%` : ""})`);
  console.log(`     tags: ${p.candidate.tags.join(", ")}`);
}

// Confirm non-persistence: main group should still have same gems
const skillsAfter = await bridge.send({ action: "get_skills" });
const mainAfter = (skillsAfter.skills.groups ?? []).find((g) => g.index === r.groupIndex);
const sameGems = (main?.gems ?? []).length === (mainAfter?.gems ?? []).length;
console.log(`\n  Main group gem count unchanged: ${sameGems ? "✓" : "✗"} (${main?.gems?.length} → ${mainAfter?.gems?.length})`);

await bridge.stop();
