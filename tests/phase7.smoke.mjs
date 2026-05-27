/**
 * Phase 7 smoke: generate_build_guide → real HTML file from real fixture.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";
import { generateBuildGuide } from "../build/htmlGuide.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const bridge = new LuaBridge({ forkPath, timeoutMs: 60_000 });
console.log("Starting bridge...");
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13 (guide test)" } });

console.log("Generating HTML guide...");
const result = await generateBuildGuide(bridge, forkPath, {
  iconTimeoutMs: 8000,
});

console.log("\n=== Result ===");
console.log(`  path:        ${result.htmlPath}`);
console.log(`  size:        ${(result.sizeBytes / 1024).toFixed(1)} KB`);
console.log(`  icons:       ${result.iconCount}  (${result.iconsFetched} fetched, ${result.iconsFromCache} cached, ${result.iconsMissing} missing)`);
console.log(`  icon bytes:  ${(result.iconBytes / 1024).toFixed(1)} KB embedded`);
console.log(`  elapsed:     ${result.elapsedMs} ms`);

// Spot-check the HTML actually has the sections
const html = readFileSync(result.htmlPath, "utf8");
const checks = [
  ["title heading", /<h1[^>]*>Monk lvl 13/],
  ["stat grid", /class="stat-grid"/],
  ["skills section", /id="skills"/],
  ["tree section", /id="tree"/],
  ["items section", /id="items"/],
  ["glossary section", /id="glossary"/],
  ["at least one base64 image", /data:image\/(?:webp|png);base64,/],
  ["tooltip script", /data-tooltip/],
  ["glossary auto-link", /class="gloss-link"/],
];
console.log("\n=== Spot checks ===");
for (const [label, rx] of checks) {
  console.log(`  ${rx.test(html) ? "✓" : "✗"} ${label}`);
}

await bridge.stop();
console.log("\nOpen in a browser:", result.htmlPath);
