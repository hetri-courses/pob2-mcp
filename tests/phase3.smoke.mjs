/**
 * Phase 3B + 3C smoke test.
 *
 * Validates:
 *   - get_tree, get_skills, get_items, get_config
 *   - calc_with (no node manipulation — that path crashes PoB2's calc engine,
 *     known limitation to investigate in a follow-up phase)
 *   - compare_builds flow: load A, snapshot, load B, snapshot, diff
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCodeA = readFileSync(
  path.join(here, "fixtures", "sample-build.code.txt"),
  "utf8"
).trim();
const buildCodeB =
  "eJyVUltPwjAUfudXnPR5OkBMeNggagIhESUZ6qMp2xGade1su0X-vae7IJj44Nu5fpfTRvOvQkKNxgqtYja6HjJAlepMqH3MXraLqymbzwbRhrvD88d9JaTvjGcDgKjJQGKNMmZjWkwlt_aJFxiztVY5A25TVNnDT3mlap2jYVBwoRKd5uiWRlclMbOwAd0aRB9QmJSYghNO0uIWrWPgqPnaax2-TzrKVRaz6QWbr4wYKJ2hpSgYBzfBJLjtOMKeJEpyIaXt-XwCku-8nzUJZGCldjF7Q15qBSN_Gr6TSODOVNi6uEudqLHZ9ZwtFqEtsQBFpr0Lr78oyQIsZGXMkYD9vFfZNfr62TU_Ky6FO7bJJXH4B8uj2B-cogeCDSp0hju6FCRVWWrjzkhPc2djp6l_SYjCxnl71v6aUfj7u3wDiT_D8Q==";

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
console.log("Starting bridge...");
const t0 = Date.now();
await bridge.start();
console.log(`Ready after ${Date.now() - t0}ms`);

// Load build A
const xmlA = decodeBuildCode(buildCodeA);
await bridge.send({ action: "load_build_xml", params: { xml: xmlA, name: "Monk lvl 13" } });
console.log("\n=== 3B: read tools ===");

const tree = await bridge.send({ action: "get_tree" });
console.log(
  `get_tree: treeVersion=${tree.tree?.treeVersion} classId=${tree.tree?.classId} ascend=${tree.tree?.ascendClassId} nodes=${tree.tree?.nodes?.length}`
);

const skills = await bridge.send({ action: "get_skills" });
console.log(`get_skills: ${(skills.skills?.groups ?? []).length} groups`);
for (const g of (skills.skills?.groups ?? []).slice(0, 3)) {
  console.log(`  [${g.index}] ${g.slot ?? "—"}: ${(g.skills || []).join(" + ") || "(empty)"}`);
}

const items = await bridge.send({ action: "get_items" });
console.log(`get_items: ${items.items?.length} items`);

const config = await bridge.send({ action: "get_config" });
console.log(`get_config: ${JSON.stringify(config.config)}`);

console.log("\n=== 3C: calc_with (cycle fix + node manipulation) ===");
const treeBefore = await bridge.send({ action: "get_tree" });
const statsBefore = (await bridge.send({ action: "get_stats" })).stats;
const lastThree = (treeBefore.tree?.nodes ?? []).slice(-3);
const whatIf = await bridge.send({
  action: "calc_with",
  params: { removeNodes: lastThree },
});
if (whatIf.ok) {
  const dLife = (whatIf.output.Life ?? 0) - (statsBefore.Life ?? 0);
  const dDPS = (whatIf.output.TotalDPS ?? 0) - (statsBefore.TotalDPS ?? 0);
  console.log(`  remove nodes ${JSON.stringify(lastThree)}: ΔLife=${dLife}, ΔDPS=${dDPS.toFixed(3)}`);
} else {
  console.log("  ERROR:", whatIf.error);
}
const statsAfter = (await bridge.send({ action: "get_stats" })).stats;
console.log(`  baseline preserved? Life ${statsAfter.Life} == ${statsBefore.Life}? ${statsAfter.Life === statsBefore.Life}`);

console.log("\n=== 3C: compare_builds flow ===");
const statsA = (await bridge.send({ action: "get_stats" })).stats;
const xmlB = decodeBuildCode(buildCodeB);
await bridge.send({ action: "load_build_xml", params: { xml: xmlB, name: "Monk/Invoker lvl 20" } });
const statsB = (await bridge.send({ action: "get_stats" })).stats;

const interesting = [
  "Life", "Mana", "TotalDPS", "CombinedDPS", "TotalEHP", "Speed",
  "Spirit", "SpiritUnreserved", "PhysicalDamageReduction", "MovementSpeedMod",
];
console.log("Stat                    | Monk lvl 13     | Monk/Invoker 20 | Δ");
console.log("------------------------|-----------------|-----------------|-----------");
for (const k of interesting) {
  const a = statsA?.[k];
  const b = statsB?.[k];
  if (typeof a === "number" && typeof b === "number") {
    const d = b - a;
    const sign = d > 0 ? "+" : "";
    console.log(
      `${k.padEnd(23)} | ${String(a).padEnd(15)} | ${String(b).padEnd(15)} | ${sign}${d.toFixed(2)}`
    );
  }
}

await bridge.stop();
console.log("\n=== Phase 3 smoke complete ===\n");
