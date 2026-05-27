/**
 * Phase 6B smoke: find_path_to_node from the Monk lvl 13 tree.
 */
import { findPathToNode, loadTree } from "../build/treeData.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const allocated = [7576, 10364, 12925, 14725, 27910, 32545, 33866, 34233, 36479, 36931, 38676, 42857, 44683, 49220, 53938, 56045, 61196];

const tests = [
  { label: "Already allocated",                target: 36931 /* Concussive Attack */, expect: "alreadyAllocated" },
  { label: "Direct neighbor (1 hop)",          target: 64056 /* Daze Chance */ },
  { label: "Notable 'Mindful Awareness'",      target: undefined /* find one */ },
  { label: "Hollow Palm (far keystone)",       target: 64601 },
];

// Resolve the Mindful Awareness ID by name to keep the smoke independent of magic IDs
const tree = loadTree(forkPath, "0_4");
const mindful = tree.all.find((n) => n.name === "Mindful Awareness" && n.type === "notable");
if (mindful) tests[2].target = mindful.id;

for (const t of tests) {
  if (t.target === undefined) { console.log(`[skip] ${t.label}`); continue; }
  const r = findPathToNode(forkPath, allocated, t.target);
  if (!r) { console.log(`[✗] ${t.label}  unreachable`); continue; }
  if (r.alreadyAllocated) { console.log(`[✓] ${t.label}  already in tree`); continue; }
  const names = r.path.map((n) => `${n.name} (${n.type})`).join(" → ");
  console.log(`[✓] ${t.label}  cost ${r.cost}: ${names}`);
}
