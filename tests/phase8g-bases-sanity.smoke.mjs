/** Phase 8G.6 sanity: bases loader picks reasonable items per slot at L90. */
import { loadBases, pickBaseForLevel, weaponForClass, armourSubTypeForClass, offhandForClass } from "../build/bases.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const all = loadBases(forkPath);
console.log(`Total bases loaded: ${all.length}`);

// Count per slot
const bySlot = {};
for (const b of all) bySlot[b.fileSlot] = (bySlot[b.fileSlot] ?? 0) + 1;
console.log("Bases per slot:", JSON.stringify(bySlot, null, 2));

const level = 90;
for (const klass of ["Monk", "Ranger", "Warrior", "Witch", "Sorceress", "Huntress", "Mercenary", "Druid"]) {
  console.log(`\n=== ${klass} L${level} loadout ===`);
  const weapon = pickBaseForLevel(all, weaponForClass(klass), level);
  console.log(`  Main: ${weapon?.name} (${weapon?.type}, req=L${weapon?.reqLevel})`);
  const off = offhandForClass(klass);
  if (off) {
    const offBase = pickBaseForLevel(all, off, level);
    console.log(`  Offhand: ${offBase?.name}`);
  }
  const body = pickBaseForLevel(all, "body", level, armourSubTypeForClass(klass));
  console.log(`  Body (${armourSubTypeForClass(klass)}): ${body?.name}`);
  for (const slot of ["helmet", "gloves", "boots", "belt", "amulet", "ring"]) {
    const b = pickBaseForLevel(all, slot, level);
    console.log(`  ${slot}: ${b?.name}`);
  }
}
