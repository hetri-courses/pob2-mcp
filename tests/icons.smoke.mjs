/**
 * Smoke: passive + gem + slot icon resolution and CDN fetch.
 * Verifies URL patterns hold for a variety of node + gem types.
 */
import { IconResolver, passiveIconRefFromPath, gemIconRef, slotIconRef } from "../build/icons.js";
import { searchNodes } from "../build/treeData.js";
import { getGem } from "../build/gemData.js";
import path from "node:path";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const cacheDir = "D:\\pob2-mcp\\generated\\.icon-cache";

const resolver = new IconResolver(cacheDir);

async function probe(label, ref) {
  if (!ref) { console.log(`  [${label}] no ref`); return; }
  const t0 = Date.now();
  const r = await resolver.embed(ref);
  const ms = Date.now() - t0;
  if (!r) {
    console.log(`  [${label}] ✗ FAILED  ${ref.src}`);
  } else {
    console.log(`  [${label}] ✓ ${r.bytes} bytes (${r.fetched ? 'fetched' : 'cached'}) in ${ms}ms  ${ref.cacheKey}`);
  }
}

console.log("=== Passive icons (from tree.json paths) ===");
// We need the raw icon path. Read from tree.json directly.
const fs = await import("node:fs");
const tree = JSON.parse(fs.readFileSync(path.join(forkPath, "TreeData", "0_4", "tree.json"), "utf8"));
const probes = [
  ["Hollow Palm (keystone)", 64601, "keystone"],
  ["Concussive Attack (notable)", 36931, "notable"],
  ["Shock Chance (normal)", 12925, "normal"],
];
for (const [label, id, type] of probes) {
  const n = tree.nodes[String(id)];
  if (!n) { console.log(`  [${label}] node not in tree.json`); continue; }
  await probe(label, passiveIconRefFromPath(n.icon, type));
}

console.log("\n=== Gem icons ===");
for (const name of ["Tempest Bell", "Flicker Strike", "Falling Thunder", "Twister", "Ice Bite Support", "Lightning Penetration Support"]) {
  const gem = getGem(forkPath, name);
  if (!gem) { console.log(`  [${name}] not in gem DB`); continue; }
  await probe(name, gemIconRef(gem));
}

console.log("\n=== Slot icons (local PoB2 PNGs, no network) ===");
for (const slot of ["Weapon 1", "Helmet", "Body Armour", "Amulet", "Belt"]) {
  await probe(slot, slotIconRef(forkPath, slot));
}

console.log("\n=== Done. Cache dir:", cacheDir, "===");
