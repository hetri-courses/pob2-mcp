/**
 * Phase 8L: check how many of our 903 PoE2 gems are covered by the scraped
 * gem-icons.json, after filtering out garbage.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGems } from "../build/gemData.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

const cached = loadGems(forkPath);
const scrape = JSON.parse(readFileSync(path.join(here, "..", "data", "gem-icons.json"), "utf8"));

// Filter: only keep paths under Art/2DArt/SkillIcons/ — those are gem icons
const filtered = {};
for (const [name, p] of Object.entries(scrape.icons)) {
  if (/^Art\/2DArt\/SkillIcons\//i.test(p)) filtered[name] = p;
}
console.log(`Filtered scrape: ${Object.keys(filtered).length} (was ${Object.keys(scrape.icons).length})`);

// Coverage: for each gem in our DB, is the name in the scrape?
let covered = 0, missing = 0;
const missList = [];
for (const gem of cached.all) {
  if (filtered[gem.name]) covered++;
  else {
    missing++;
    if (missList.length < 30) missList.push(gem.name);
  }
}
console.log(`Our DB has ${cached.all.length} gems`);
console.log(`Covered by scrape: ${covered} (${((covered / cached.all.length) * 100).toFixed(1)}%)`);
console.log(`Missing: ${missing}`);
console.log(`\nFirst 30 missing:`);
for (const n of missList) console.log(`  - ${n}`);

// Check: how many of the SCRAPED entries don't match any gem in our DB?
const dbNames = new Set(cached.all.map((g) => g.name));
const extras = Object.keys(filtered).filter((n) => !dbNames.has(n));
console.log(`\nScrape entries with no gem in DB: ${extras.length}`);
for (const n of extras.slice(0, 20)) console.log(`  + ${n} → ${filtered[n]}`);
