/** Verify suggest_gem_link gives real DPS-ranked supports for a Staff Monk skill. */
import { LuaBridge } from "../build/luaBridge.js";
import { synthesizeBuild } from "../build/buildGen.js";
import { suggestGemLink } from "../build/theorycraft.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 180_000 });
await b.start();

// Build a Monk (no ascendancy — Martial Artist isn't in the 0.4 calc tree)
// with Killing Palm + gear so DPS is measurable, then rank supports.
console.log("Synthesizing Monk + Killing Palm (gear on)…");
const r = await synthesizeBuild(b, forkPath, {
  className: "Monk",
  level: 90,
  mainSkillName: "Killing Palm",
  treePointBudget: 30,
  supportCount: 0,        // we'll rank manually below
  refineWithCalc: false,
});
console.log(`  baseline DPS=${r.summary.finalDPS}, mainSkill=${r.summary.mainSkill}`);

console.log("\nsuggest_gem_link (real calc DPS deltas) for Killing Palm:");
const link = await suggestGemLink(b, forkPath, { maxCandidates: 40, limit: 12 });
console.log(`  screened ${link.considered.candidatesScreened} via ${link.considered.screenSource}, tested ${link.considered.candidatesTested}`);
for (const [i, p] of link.proposals.entries()) {
  const sign = p.delta > 0 ? "+" : "";
  console.log(`  ${i + 1}. ${p.candidate.name.padEnd(22)} ${sign}${p.delta} (${p.pct ?? "?"}%)  [${p.candidate.tags.join(",")}]`);
}

await b.stop();
