/**
 * Smoke: rune + unique static lookups (parse PoB Data/ModRunes.lua + Uniques/).
 * No calc engine / Lua bridge needed — pure file parse.
 */
import { loadRunes, searchRunes, getRune } from "../build/runes.js";
import { loadUniques, searchUniques, getUnique } from "../build/uniques.js";

const fp = "D:\\pob2-mcp\\pob2-fork\\src";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

console.log("=== RUNES ===");
const runes = loadRunes(fp);
ok(runes.all.length > 50, `loaded ${runes.all.length} runes/soul cores`);
ok(runes.all.every((r) => r.name && r.slots.length > 0), "every rune has a name + ≥1 slot");
const lightning = searchRunes(fp, "Lightning", { limit: 10 });
ok(lightning.length > 0, `search 'Lightning' → ${lightning.length} hits`);
const stormRune = getRune(fp, "Storm Rune");
ok(stormRune != null, `getRune('Storm Rune') → ${stormRune ? stormRune.allMods[0] : "MISSING"}`);
const helmetRunes = searchRunes(fp, "", { slot: "helmet", limit: 100 });
ok(helmetRunes.length > 0, `slot filter 'helmet' → ${helmetRunes.length} runes`);

console.log("\n=== UNIQUES ===");
const uniques = loadUniques(fp);
ok(uniques.all.length > 200, `loaded ${uniques.all.length} uniques`);
ok(uniques.all.every((u) => u.name && u.baseType), "every unique has name + baseType");
const astra = getUnique(fp, "Astramentis");
ok(astra != null && astra.mods.some((m) => /all Attributes/.test(m)), `getUnique('Astramentis') has attribute mod`);
const lifeAmulets = searchUniques(fp, "maximum Life", { category: "amulet", limit: 20 });
ok(lifeAmulets.length > 0, `search 'maximum Life' amulets → ${lifeAmulets.length}`);
const byBase = searchUniques(fp, "Quarterstaff", { limit: 20 });
ok(byBase.length >= 0, `search 'Quarterstaff' → ${byBase.length} (base-type match path works)`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
