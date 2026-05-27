/**
 * Phase 8C audit: inspect tree.json structure to understand node geometry.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const treeJsonPath = path.join(forkPath, "TreeData", "0_4", "tree.json");
const raw = JSON.parse(readFileSync(treeJsonPath, "utf8"));

console.log("Top-level keys:", Object.keys(raw).sort().slice(0, 30));
console.log();

// Constants we need
console.log("constants:", JSON.stringify(raw.constants ?? {}, null, 2).slice(0, 1000));
console.log();

// Groups (positioning data lives here)
const groupIds = Object.keys(raw.groups ?? {});
console.log(`groups count: ${groupIds.length}`);
if (groupIds.length) {
  const sampleGid = groupIds[0];
  console.log(`sample group [${sampleGid}]:`, JSON.stringify(raw.groups[sampleGid], null, 2));
}
console.log();

// A normal node
const nodeIds = Object.keys(raw.nodes ?? {});
console.log(`nodes count: ${nodeIds.length}`);
// Find a few representative nodes
const interesting = ["10000", "55342", "12925", "61486"]; // class-start, normal, notable, jewel?
for (const id of interesting) {
  const n = raw.nodes[id];
  if (n) console.log(`node ${id}: ${JSON.stringify(n).slice(0, 400)}`);
}

// Find first non-ascendancy normal/notable/keystone for coord testing
let normalCount = 0;
for (const [id, n] of Object.entries(raw.nodes)) {
  if (n.group != null && !n.ascendancyName && !n.classStartIndex) {
    if (n.isNotable && normalCount < 3) {
      console.log(`\nnotable ${id}: group=${n.group} orbit=${n.orbit} orbitIndex=${n.orbitIndex} name='${n.name}'`);
      normalCount++;
    }
  }
  if (normalCount >= 3) break;
}

// Sizes
console.log(`\nmin/max x:`, raw.min_x, raw.max_x);
console.log(`min/max y:`, raw.min_y, raw.max_y);
console.log(`width: ${raw.max_x - raw.min_x}  height: ${raw.max_y - raw.min_y}`);

// orbitRadii (PoE2 uses 0_5 schema possibly; older constants had this)
console.log(`\norbitRadii:`, raw.constants?.orbitRadii ?? "(missing)");
console.log(`skillsPerOrbit:`, raw.constants?.skillsPerOrbit ?? "(missing)");
