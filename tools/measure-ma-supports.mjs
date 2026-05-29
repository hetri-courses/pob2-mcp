/**
 * Measure real support-gem DPS rankings for the Martial Artist guide's skills.
 *
 * PoB 0.16.0 ships the 0.5 calc + tree natively (calc defaults to treeVersion
 * "0_5") AND the Martial Artist ascendancy, and fixes Palm skills scaling with
 * unarmed/Quarterstaff damage + crit. So we now synthesize a real Monk /
 * Martial Artist on 0.5 and suggest_gem_link to rank supports by measured DPS.
 *
 * MUST run with POB_TREE_VERSION=0_5 so the Node tree-tools (which pick the
 * allocated nodes) speak the same tree the calc engine runs. (The old version
 * of this script ran in plain 0.4 because that's all the calc had — relying on
 * the 0_4 default is exactly what produced bogus "Palm doesn't scale" results.)
 *
 * Writes data/ma-supports.json for build-ma-guide.mjs to consume.
 *
 * Run: POB_TREE_VERSION=0_5 node tools/measure-ma-supports.mjs
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

const TREE_VERSION = process.env.POB_TREE_VERSION;
if (!TREE_VERSION) {
  console.error("Refusing to run without POB_TREE_VERSION set — the Node tree-tools would default to 0_4 and");
  console.error("disagree with the calc engine. Run: POB_TREE_VERSION=0_5 node tools/measure-ma-supports.mjs");
  process.exit(1);
}

const ASCENDANCY = "Martial Artist";
// Physical Quarterstaff strikes valid for the unarmed Hollow Palm build.
const SKILLS = ["Killing Palm", "Staggering Palm"];

const gems = loadGems(forkPath);
const b = new LuaBridge({ forkPath, timeoutMs: 180_000 });
await b.start();

const out = { generatedAt: new Date().toISOString(), calcVersion: TREE_VERSION, ascendancy: ASCENDANCY, skills: {} };

for (const skill of SKILLS) {
  console.log(`\n=== ${skill} ===`);
  try {
    // Crit-leaning geared Monk so crit/phys supports surface (budget high enough
    // to pull crit notables via the stat-text heuristic).
    const r = await synthesizeBuild(b, forkPath, {
      className: "Monk",
      ascendancyName: ASCENDANCY,
      level: 90,
      mainSkillName: skill,
      goal: "dps",
      treePointBudget: 55,
      supportCount: 0,
      refineWithCalc: false,
    });
    // Test ALL engine-compatible supports (cap well above the ~224 screened),
    // so ranking is by real measured DPS rather than the tag-overlap heuristic
    // — otherwise a strong but low-tag-overlap support (e.g. Uul-Netol's
    // Embrace) can fall outside a small cut. Slower, but this is one-time data.
    const link = await suggestGemLink(b, forkPath, { maxCandidates: 400, limit: 25 });
    const supports = link.proposals.map((p) => {
      const gem = gems.all.find((x) => x.name === p.candidate.name);
      return {
        name: p.candidate.name,
        delta: p.delta,
        pct: p.pct,
        // tier + gemFamily so a level-phased guide can group tiers (Brutality
        // I/II/III) and pick the one a character can actually use — higher tier
        // = stronger but obtained later. (Support gems carry no character-level
        // requirement in the data; tier is the honest progression gate.)
        tier: p.candidate.tier ?? (gem ? gem.tier : null),
        gemFamily: p.candidate.gemFamily ?? (gem ? gem.gemFamily ?? null : null),
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
