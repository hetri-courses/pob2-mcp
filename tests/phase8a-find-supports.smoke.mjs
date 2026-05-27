/**
 * Phase 8A: find actual PoE2 support gem names.
 *
 * Iterate Gems.lua via the existing gemData loader; surface any "support"-typed
 * gem so we know what to feed add_gem.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadGems } from "../build/gemData.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

const cached = loadGems(forkPath);
const gems = cached.all;
console.log(`Loaded ${gems.length} gems total`);

const supports = gems.filter((g) => g.isSupport);
console.log(`Found ${supports.length} support gems`);

// Show the first 30 supports by name with their tags
for (const g of supports.slice(0, 40)) {
  console.log(`  ${g.name}  [${(g.tags ?? []).join(",")}]`);
}

console.log("\n--- support gems referencing 'lightning' or 'elemental' ---");
const lightningish = supports.filter((g) =>
  /lightning|elemental|shock/i.test(g.name) || (g.tags ?? []).some((t) => /lightning|elemental/i.test(t)),
);
for (const g of lightningish) {
  console.log(`  ${g.name}  [${(g.tags ?? []).join(",")}]  id=${g.id ?? "?"}  gameId=${g.gameId ?? "?"}`);
}

console.log("\n--- any gem name containing 'added' or 'increase' ---");
const matches = gems.filter((g) => /added|increase|extra/i.test(g.name));
for (const g of matches.slice(0, 30)) {
  console.log(`  ${g.name}  [${(g.tags ?? []).join(",")}]`);
}
