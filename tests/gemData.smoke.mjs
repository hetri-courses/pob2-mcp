/**
 * Phase 5B smoke: gem data parser + search.
 */
import { loadGems, searchGems, getGem, gemStats } from "../build/gemData.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

console.log("=== Load gem data ===");
const t0 = Date.now();
const data = loadGems(forkPath);
console.log(`Loaded ${data.all.length} gems in ${Date.now() - t0}ms`);

console.log("\n=== Counts ===");
const stats = gemStats(forkPath);
console.log(`Total: ${stats.total}, unique tags: ${stats.uniqueTags}`);
for (const [type, n] of Object.entries(stats.byType)) console.log(`  ${type}: ${n}`);

console.log("\n=== Search: 'tempest bell' ===");
let hits = searchGems(forkPath, "tempest bell");
for (const h of hits.slice(0, 3)) {
  console.log(`  [${h.matchedOn}] id=${h.id}`);
  console.log(`    name=${h.name}  type=${h.gemType}  tier=${h.tier}  maxLvl=${h.naturalMaxLevel}`);
  console.log(`    tags: ${h.tagString ?? h.tags.join(", ")}`);
  console.log(`    req: Str=${h.reqStr} Dex=${h.reqDex} Int=${h.reqInt}`);
}

console.log("\n=== Search: 'lightning' support gems ===");
hits = searchGems(forkPath, "lightning", { supportOnly: true, limit: 5 });
for (const h of hits) {
  console.log(`  ${h.name} (${h.gemFamily ?? "—"}) — tags: ${h.tagString ?? ""}`);
}

console.log("\n=== Search: 'flicker' ===");
hits = searchGems(forkPath, "flicker", { limit: 3 });
for (const h of hits) {
  console.log(`  ${h.name} [${h.gemType}] — ${h.tagString}`);
}

console.log("\n=== Search by tag: lightning attack gems ===");
hits = searchGems(forkPath, "lightning", { matchTags: true, gemType: "Attack", limit: 5 });
for (const h of hits) {
  console.log(`  ${h.name} — ${h.tagString}`);
}

console.log("\n=== Look up by name: 'Twister' ===");
const twister = getGem(forkPath, "Twister");
if (twister) {
  console.log(`  ${twister.name} [${twister.gemType}] tier ${twister.tier}`);
  console.log(`  tags: ${twister.tagString}`);
  console.log(`  req: Int=${twister.reqInt}`);
} else {
  console.log("  not found");
}

console.log("\n=== Cache test ===");
const t1 = Date.now();
loadGems(forkPath);
console.log(`Second load: ${Date.now() - t1}ms`);
