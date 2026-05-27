/**
 * Phase 1 smoke test.
 *
 * Validates against a real PoB2 build code fetched from pobb.in:
 *   1. decode → XML
 *   2. parse → typed structure
 *   3. encode XML back → should round-trip semantically (compression byte-equality
 *      is NOT guaranteed; we only check decode(encode(x)) === x at the XML level)
 *   4. log a build summary
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { decodeBuildCode, encodeBuildCode } from "../build/codec.js";
import { parseBuildXml } from "../build/build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "sample-build.code.txt");
const buildCode = readFileSync(fixturePath, "utf8").trim();

console.log(`\n=== Smoke test: pob2-mcp Phase 1 ===`);
console.log(`Build code: ${buildCode.length} chars`);
console.log(`First 60: ${buildCode.slice(0, 60)}...`);

// 1. decode
const xml = decodeBuildCode(buildCode);
console.log(`\n[1] decode → XML: ${xml.length} chars`);
console.log(`    first 200: ${xml.slice(0, 200).replace(/\n/g, " ")}...`);

// 2. parse
const build = parseBuildXml(xml);
console.log(`\n[2] parse → typed structure:`);
console.log(`    class:        ${build.meta.className} / ${build.meta.ascendClassName}`);
console.log(`    level:        ${build.meta.level}`);
console.log(`    main group:   ${build.meta.mainSocketGroup}`);
console.log(`    PoB version:  ${build.meta.version}`);
console.log(`    trees:        ${build.trees.length}`);
for (const t of build.trees) {
  console.log(`      - "${t.title}" (treeVersion ${t.treeVersion}, ${t.nodes.length} nodes, classId ${t.classId}/${t.ascendClassId})`);
}
console.log(`    skill groups: ${build.skills.length}`);
for (const [i, g] of build.skills.entries()) {
  const summary = g.gems.map((x) => `${x.name}${x.support ? "(s)" : ""}@${x.level}`).join(", ");
  console.log(`      [${i + 1}] ${g.label || "(no label)"} [${g.slot || "—"}]: ${summary || "(no gems)"}`);
}
console.log(`    items:        ${build.items.length}`);
for (const it of build.items) {
  const firstLine = it.text.split("\n")[0];
  console.log(`      - ${it.slot || "(unassigned)"}: ${firstLine}`);
}

// 3. round-trip
const reencoded = encodeBuildCode(xml);
const reDecoded = decodeBuildCode(reencoded);
const xmlMatch = xml === reDecoded;
console.log(`\n[3] round-trip: encode(decode(x)) → decode → matches original XML? ${xmlMatch ? "YES" : "NO"}`);
if (!xmlMatch) {
  // Find first diff
  let i = 0;
  while (i < Math.min(xml.length, reDecoded.length) && xml[i] === reDecoded[i]) i++;
  console.log(`    first diff at offset ${i}`);
  console.log(`    original:  ...${xml.slice(Math.max(0, i - 40), i + 40)}...`);
  console.log(`    re-decoded:...${reDecoded.slice(Math.max(0, i - 40), i + 40)}...`);
}
console.log(`    code-length original: ${buildCode.length}  re-encoded: ${reencoded.length}  (byte-identical? ${buildCode === reencoded ? "YES" : "no — expected, pako may compress differently"})`);

console.log(`\n=== Smoke test complete ===\n`);
