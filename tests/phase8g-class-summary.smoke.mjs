/** Phase 8G.1: just list all classes + ascendancies compactly. */
import { readFileSync } from "node:fs";
import path from "node:path";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const raw = JSON.parse(readFileSync(path.join(forkPath, "TreeData", "0_4", "tree.json"), "utf8"));

console.log("Classes:");
for (const c of raw.classes ?? []) {
  const ascs = (c.ascendancies ?? []).map((a) => `${a.name} (id=${a.id}, internal=${a.internalId})`).join(", ");
  console.log(`  ${c.name} (integerId=${c.integerId}, base str/dex/int=${c.base_str}/${c.base_dex}/${c.base_int})`);
  if (ascs) console.log(`    ascendancies: ${ascs}`);
}
