/**
 * Phase 8G v2: gear scaffolding for synthesize_build.
 *
 * Generates placeholder Rare items for all major slots so the synthesized
 * build has measurable baseline DPS/Life — without this, every support gem
 * shows Δ=0 and the calc engine can't tell good supports from bad.
 *
 * Item-text format uses PoB's internal RARE shape:
 *   Rarity: RARE
 *   <DisplayName>
 *   <BaseTypeName>             ← MUST be a real PoE2 base from Data/Bases/
 *   LevelReq: N
 *   Implicits: 0
 *   <mod line>
 *   <mod line>
 *   ...
 *
 * We rely on PoB's free-text mod parser. Mods are stat-line strings like
 * "+80 to maximum Life" or "+30% to Fire Resistance".
 */

import { loadBases, pickBaseForLevel, weaponForClass, offhandForClass, armourSubTypeForClass, type ItemBase } from "./bases.js";

export interface GearItem {
  /** PoB slot name, e.g., "Body Armour", "Weapon 1", "Ring 1". */
  slot: string;
  /** Full PoB-internal item text (ready for add_item_text). */
  text: string;
  /** True if this item should be equipped. */
  equip: boolean;
}

export interface GenerateGearOptions {
  className: string;
  level: number;
  /** If true, weapon mods bias toward spell scaling instead of attack. */
  caster?: boolean;
}

// ---------------------------------------------------------------------------
// Mod templates per slot. Each line is a free-text mod PoB will parse.
// Values picked to be realistic for L80+ Rare items (not best-in-slot, but
// solidly mid-tier).
// ---------------------------------------------------------------------------
const MODS = {
  bodyArmour: [
    "+100 to maximum Life",
    "+30% to Fire Resistance",
    "+30% to Cold Resistance",
    "+30% to Lightning Resistance",
  ],
  helmet: [
    "+80 to maximum Life",
    "+25% to Fire Resistance",
    "+25% to Cold Resistance",
    "+200 to Accuracy Rating",
  ],
  glovesAttack: [
    "+80 to maximum Life",
    "+25% to Cold Resistance",
    "+25% to Lightning Resistance",
    "20% increased Attack Speed",
  ],
  glovesCaster: [
    "+80 to maximum Life",
    "+25% to Cold Resistance",
    "+25% to Lightning Resistance",
    "15% increased Cast Speed",
  ],
  boots: [
    "+80 to maximum Life",
    "+25% to Fire Resistance",
    "+25% to Lightning Resistance",
    "30% increased Movement Speed",
  ],
  belt: [
    "+100 to maximum Life",
    "+25% to Chaos Resistance",
    "20% increased Flask Charges Gained",
  ],
  amulet: [
    "+60 to maximum Life",
    "+25 to all Attributes",
    "40% increased Critical Damage Bonus",
    "+25% to Lightning Resistance",
  ],
  ring: [
    "+50 to maximum Life",
    "+25% to Cold Resistance",
    "+25% to Fire Resistance",
    "+20 to all Attributes",
  ],
  weaponMelee: [
    "100% increased Physical Damage",
    "Adds 30 to 60 Physical Damage",
    "20% increased Attack Speed",
    "+250 to Accuracy Rating",
    "10% to Critical Hit Chance",
  ],
  weaponBow: [
    "120% increased Physical Damage",
    "Adds 30 to 60 Physical Damage",
    "18% increased Attack Speed",
    "+300 to Accuracy Rating",
  ],
  weaponCaster: [
    "100% increased Spell Damage",
    "Adds 30 to 60 Lightning Damage to Spells",
    "15% increased Cast Speed",
    "10% to Critical Hit Chance for Spells",
  ],
  shield: [
    "+80 to maximum Life",
    "+20% to Fire Resistance",
    "+20% to Cold Resistance",
    "+20% to Lightning Resistance",
  ],
  focus: [
    "+50 to maximum Mana",
    "20% increased Spell Damage",
    "+30 to Spirit",
    "+20% to Lightning Resistance",
  ],
};

function makeItem(displayName: string, base: ItemBase, mods: string[]): string {
  // PoB-internal RARE format. LevelReq is a hint for PoB; it doesn't restrict
  // equip in headless mode but keeps the display sensible.
  return `Rarity: RARE
${displayName}
${base.name}
LevelReq: ${base.reqLevel}
Implicits: 0
${mods.join("\n")}
`;
}

/**
 * Generate a full set of placeholder rare items for the given class + level.
 * Two-handed-weapon classes (Monk, Ranger, Mercenary) get a quiver/no-shield.
 */
export function generateGear(forkPath: string, opts: GenerateGearOptions): GearItem[] {
  const { className, level } = opts;
  const caster = opts.caster ?? false;
  const bases = loadBases(forkPath);
  const items: GearItem[] = [];

  // -- Weapon (main hand) --
  const weaponSlot = weaponForClass(className);
  const weaponBase = pickBaseForLevel(bases, weaponSlot, level);
  if (weaponBase) {
    let mods: string[];
    if (caster || weaponSlot === "wand" || weaponSlot === "sceptre" || (weaponSlot === "staff" && className.toLowerCase() !== "monk")) {
      mods = MODS.weaponCaster;
    } else if (weaponSlot === "bow" || weaponSlot === "crossbow") {
      mods = MODS.weaponBow;
    } else {
      mods = MODS.weaponMelee;
    }
    items.push({
      slot: "Weapon 1",
      text: makeItem(`Synthesized ${weaponBase.name}`, weaponBase, mods),
      equip: true,
    });
  }

  // -- Offhand --
  const offSlot = offhandForClass(className);
  if (offSlot) {
    const offBase = pickBaseForLevel(bases, offSlot, level);
    if (offBase) {
      const mods = offSlot === "focus" ? MODS.focus : MODS.shield;
      items.push({
        slot: "Weapon 2",
        text: makeItem(`Synthesized ${offBase.name}`, offBase, mods),
        equip: true,
      });
    }
  }

  // -- Body armour --
  const bodyBase = pickBaseForLevel(bases, "body", level, armourSubTypeForClass(className));
  if (bodyBase) {
    items.push({
      slot: "Body Armour",
      text: makeItem(`Synthesized ${bodyBase.name}`, bodyBase, MODS.bodyArmour),
      equip: true,
    });
  }

  // -- Helmet --
  const helmBase = pickBaseForLevel(bases, "helmet", level);
  if (helmBase) {
    items.push({
      slot: "Helmet",
      text: makeItem(`Synthesized ${helmBase.name}`, helmBase, MODS.helmet),
      equip: true,
    });
  }

  // -- Gloves --
  const glovesBase = pickBaseForLevel(bases, "gloves", level);
  if (glovesBase) {
    const mods = caster ? MODS.glovesCaster : MODS.glovesAttack;
    items.push({
      slot: "Gloves",
      text: makeItem(`Synthesized ${glovesBase.name}`, glovesBase, mods),
      equip: true,
    });
  }

  // -- Boots --
  const bootsBase = pickBaseForLevel(bases, "boots", level);
  if (bootsBase) {
    items.push({
      slot: "Boots",
      text: makeItem(`Synthesized ${bootsBase.name}`, bootsBase, MODS.boots),
      equip: true,
    });
  }

  // -- Belt --
  const beltBase = pickBaseForLevel(bases, "belt", level);
  if (beltBase) {
    items.push({
      slot: "Belt",
      text: makeItem(`Synthesized ${beltBase.name}`, beltBase, MODS.belt),
      equip: true,
    });
  }

  // -- Amulet --
  const amuletBase = pickBaseForLevel(bases, "amulet", level);
  if (amuletBase) {
    items.push({
      slot: "Amulet",
      text: makeItem(`Synthesized ${amuletBase.name}`, amuletBase, MODS.amulet),
      equip: true,
    });
  }

  // -- Rings x2 (PoE2 has Ring 1 / Ring 2) --
  const ringBase = pickBaseForLevel(bases, "ring", level);
  if (ringBase) {
    items.push({
      slot: "Ring 1",
      text: makeItem(`Synthesized ${ringBase.name} A`, ringBase, MODS.ring),
      equip: true,
    });
    items.push({
      slot: "Ring 2",
      text: makeItem(`Synthesized ${ringBase.name} B`, ringBase, MODS.ring),
      equip: true,
    });
  }

  return items;
}
