/**
 * Validate the 0_5 tree.json regenerated from the official PoB 0.16.0 tree.lua.
 * Exercises the guide's critical dependencies: node lookup, pathing, search, SVG.
 */
import { getNode, findPathToNode, searchNodes } from "../build/treeData.js";
import { loadRawTree, renderTreeSvg } from "../build/treeSvg.js";

const fork = "D:\\pob2-mcp\\pob2-fork\\src";
const V = "0_5";

const hp = getNode(fork, 64601, V);
console.log(`Hollow Palm 64601: name=${hp?.name} type=${hp?.type} stats=${hp?.stats.length} conns=${hp?.connections.length}`);

const ms = getNode(fork, 44683, V);
console.log(`Monk start 44683: name=${ms?.name} type=${ms?.type} conns=${ms?.connections.length}`);

const path = findPathToNode(fork, [44683], 64601, { version: V });
console.log(`path 44683->64601: ${path ? path.cost + " hops" : "UNREACHABLE"}`);
if (path) console.log("  via:", path.path.map((n) => n.name).filter(Boolean).slice(0, 10).join(" -> "));

const r = searchNodes(fork, "Hollow Palm", {}, V);
console.log("search 'Hollow Palm':", r.map((x) => `${x.id}:${x.name}`).join(", ") || "(none)");

const ev = searchNodes(fork, "evasion", { matchStats: true, limit: 3 }, V);
console.log("search 'evasion' (stats):", ev.map((x) => x.name).join(", "));

const raw = loadRawTree(fork, V);
const svg = renderTreeSvg(raw, {
  allocated: new Set([44683, 64601]),
  emphasizeAllocated: true,
  frameOnAllocated: true,
  svgId: "t",
});
const circles = (svg.match(/<circle/g) || []).length;
console.log(`SVG: ${svg.length} bytes, startsWith<svg=${svg.startsWith("<svg")}, circles=${circles}`);

const ok = hp?.name === "Hollow Palm Technique" && path && path.cost > 0 && r.length > 0 && svg.startsWith("<svg") && circles > 1000;
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
