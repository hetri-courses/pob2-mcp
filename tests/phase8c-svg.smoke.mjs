/**
 * Phase 8C smoke: render the tree SVG for the Monk fixture, measure size,
 * sanity-check coords.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadRawTree, renderTreeSvg, nodeCoords } from "../build/treeSvg.js";
import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const raw = loadRawTree(forkPath, "0_4");
console.log(`Loaded tree.json: ${Object.keys(raw.nodes).length} nodes, ${Object.keys(raw.groups).length} groups`);

// Sanity-check: pick a known node, verify coords are inside the global bounds
const shockChance = raw.nodes["12925"];
const xy = nodeCoords(raw, shockChance);
console.log(`Shock Chance (12925) coords: ${JSON.stringify(xy)}  group=${shockChance.group} orbit=${shockChance.orbit}/${shockChance.orbitIndex}`);
console.log(`tree bounds: x=[${raw.min_x.toFixed(0)}, ${raw.max_x.toFixed(0)}] y=[${raw.min_y.toFixed(0)}, ${raw.max_y.toFixed(0)}]`);
if (xy && (xy.x < raw.min_x || xy.x > raw.max_x || xy.y < raw.min_y || xy.y > raw.max_y)) {
  console.log("⚠️  computed coords are OUTSIDE the declared bounds — geometry math may be wrong");
}

// Allocated set from the Monk fixture
const bridge = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "svg-test" } });
const treeResp = await bridge.send({ action: "get_tree" });
const allocated = new Set((treeResp.tree.nodes ?? []).map(Number));
const ascName = treeResp.tree.ascendancyName || undefined;
const classStartIndex = treeResp.tree.classId;
await bridge.stop();
console.log(`\nMonk fixture: ${allocated.size} allocated, ascendancy='${ascName ?? "(none)"}', classId=${classStartIndex}`);

// Render
const svg = renderTreeSvg(raw, { allocated, ascendancyName: ascName, classStartIndex, width: 1200 });
console.log(`\nSVG size: ${svg.length} bytes (${(svg.length / 1024).toFixed(1)}KB)`);

// Save to disk for visual inspection
const outPath = path.join(here, "..", "generated", "phase8c-tree.svg");
writeFileSync(outPath, svg, "utf8");
console.log(`Wrote ${outPath}`);

// Wrap in a minimal HTML preview so it can be opened directly
const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Phase 8C tree preview</title>
<style>body{background:#1a1a1a;color:#dcdcdc;font-family:system-ui,sans-serif;margin:0;padding:20px}
h1{font-size:14px;margin:0 0 12px;color:#888}.wrap{max-width:1200px;margin:0 auto}</style></head>
<body><div class="wrap"><h1>Monk fixture tree (${allocated.size} allocated)</h1>${svg}</div></body></html>`;
const htmlPath = path.join(here, "..", "generated", "phase8c-tree.html");
writeFileSync(htmlPath, html, "utf8");
console.log(`Wrote ${htmlPath}`);

// Sanity checks: count the alloc CSS classes (na/nta/ka/csa).
const naCount = (svg.match(/class="na"/g) ?? []).length;
const ntaCount = (svg.match(/class="nta"/g) ?? []).length;
const kaCount = (svg.match(/class="ka"/g) ?? []).length;
console.log(`\nHighlighted nodes: ${naCount} normal + ${ntaCount} notable + ${kaCount} keystone = ${naCount + ntaCount + kaCount} (expected ${allocated.size})`);
console.log(`SVG starts with: ${svg.slice(0, 100)}...`);
