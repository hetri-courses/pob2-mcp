/**
 * Measure real support-gem DPS rankings for the Martial Artist guide's skills.
 *
 * Runs in PLAIN 0.4 (do NOT set POB_TREE_VERSION) so the Node tree-tools and
 * the Lua calc engine agree on 0_4 — synthesize a representative geared Monk
 * per skill, then suggest_gem_link to rank supports by measured DPS.
 *
 * Writes data/ma-supports.json for build-ma-guide.mjs to consume, so guide
 * regeneration stays fast + deterministic (no bridge spawn there).
 *
 * Run: node tools/measure-ma-supports.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LuaBridge } from "../build/luaBridge.js";
import { synthesizeBuild } from "../build/buildGen.js";
import { suggestGemLink } from "../build/theorycraft.js";
import { loadGems } from "../build/gemData.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

// Physical Quarterstaff strikes valid for the unarmed Hollow Palm build.
const SKILLS = ["Killing Palm", "Staggering Palm"];

const gems = loadGems(forkPath);
const b = new LuaBridge({ forkPath, timeoutMs: 180_000 });
await b.start();

const out = { generatedAt: new Date().toISOString(), calcVersion: "0_4", skills: {} };

for (const skill of SKILLS) {
  console.log(`\n=== ${skill} ===`);
  try {
    // Crit-leaning geared Monk so crit/phys supports surface (budget high enough
    // to pull crit notables via the stat-text heuristic).
    const r = await synthesizeBuild(b, forkPath, {
      className: "Monk",
      level: 90,
      mainSkillName: skill,
      goal: "dps",
      treePointBudget: 55,
      supportCount: 0,
      refineWithCalc: false,
    });
    const link = await suggestGemLink(b, forkPath, { maxCandidates: 50, limit: 25 });
    const supports = link.proposals.map((p) => {
      const gem = gems.all.find((x) => x.name === p.candidate.name);
      return {
        name: p.candidate.name,
        delta: p.delta,
        pct: p.pct,
        tags: p.candidate.tags,
        grantedEffectId: gem ? gem.grantedEffectId : null,
      };
    });
    out.skills[skill] = { baseline: r.summary.finalDPS ?? link.baseline, supports };
    console.log(`  baseline=${out.skills[skill].baseline}`);
    for (const s of supports.filter((x) => x.delta > 0)) console.log(`  +${s.delta} (${s.pct}%)  ${s.name}`);
  } catch (e) {
    console.log(`  FAILED: ${(e instanceof Error ? e.message : String(e))}`);
    out.skills[skill] = { baseline: 0, supports: [], error: String(e) };
  }
}

await b.stop();

const dataDir = path.join(here, "..", "data");
mkdirSync(dataDir, { recursive: true });
const outPath = path.join(dataDir, "ma-supports.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${outPath}`);
for (const [s, d] of Object.entries(out.skills)) {
  console.log(`  ${s}: ${d.supports.filter((x) => x.delta > 0).length} positive / ${d.supports.length} tested`);
}
