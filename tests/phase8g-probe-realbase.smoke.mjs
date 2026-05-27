/**
 * Phase 8G.5 part 3: try add_item_text using a REAL PoE2 base name + various
 * formats to find what add_item_text actually accepts.
 */
import { LuaBridge } from "../build/luaBridge.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();
await b.send({ action: "new_build" });
await b.send({ action: "update_tree_delta", params: { className: "Monk" } });

const candidates = [
  {
    name: "A: PoB-internal RARE with real base 'Rusted Cuirass'",
    text: `Rarity: RARE
Lich Shroud
Rusted Cuirass
LevelReq: 1
Implicits: 0
+80 to maximum Life
30% to Fire Resistance
30% to Cold Resistance
30% to Lightning Resistance
`,
  },
  {
    name: "B: in-game ctrl-c with Item Class line + real base",
    text: `Item Class: Body Armours
Rarity: Rare
Lich Shroud
Rusted Cuirass
--------
Armour: 200
--------
Requires Level 1
--------
+80 to maximum Life
30% to Fire Resistance
30% to Cold Resistance
30% to Lightning Resistance
`,
  },
  {
    name: "C: PoB-internal MAGIC with real base",
    text: `Rarity: MAGIC
Healthy Rusted Cuirass
LevelReq: 1
Implicits: 0
+80 to maximum Life
`,
  },
  {
    name: "D: PoB-internal NORMAL (white) with just the base",
    text: `Rarity: NORMAL
Rusted Cuirass
LevelReq: 1
Implicits: 0
`,
  },
];

for (const c of candidates) {
  const r = await b.send({ action: "add_item_text", params: { text: c.text, equip: false } });
  console.log(`${c.name}:`);
  console.log(`  ${JSON.stringify(r).slice(0, 300)}\n`);
}

await b.stop();
