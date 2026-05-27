/**
 * PoE2 item-base data loader. Parses Data/Bases/*.lua to build a registry of
 * valid base type names per slot. We need real base names because PoB's
 * item-text parser rejects fabricated ones.
 *
 * Each .lua file uses a regular pattern:
 *   itemBases["Rusted Cuirass"] = {
 *     type = "Body Armour",
 *     subType = "Armour",      -- optional, present for body/helmet/gloves/boots
 *     tags = { ... },
 *     req = { level = 11, str = 21 },  -- optional level requirement
 *     ...
 *   }
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface ItemBase {
  /** Base name, e.g., "Rusted Cuirass". */
  name: string;
  /** PoB internal type, e.g., "Body Armour", "Quarterstaff", "Bow". */
  type: string;
  /** Armour/Evasion/ES for body slots; "Two Hand" for 2H weapons; etc. */
  subType?: string;
  /** Required character level (omitted = level 1). */
  reqLevel: number;
  /** Slot file this came from (body, helmet, ring, etc.). */
  fileSlot: string;
  /** A few tags for filtering (e.g., "str_armour", "dex_armour"). */
  tags: string[];
}

const BASE_FILES = [
  "amulet", "axe", "belt", "body", "boots", "bow", "claw",
  "crossbow", "dagger", "flail", "focus", "gloves", "helmet",
  "mace", "quiver", "ring", "sceptre", "shield", "soulcore",
  "spear", "staff", "sword", "wand",
];

const CACHE = new Map<string, ItemBase[]>();

export function loadBases(forkPath: string): ItemBase[] {
  const hit = CACHE.get(forkPath);
  if (hit) return hit;

  const all: ItemBase[] = [];
  for (const fileSlot of BASE_FILES) {
    const filePath = path.join(forkPath, "Data", "Bases", `${fileSlot}.lua`);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    all.push(...parseBaseFile(text, fileSlot));
  }
  CACHE.set(forkPath, all);
  return all;
}

/**
 * Parse a single bases file. We use a regex sweep, not a full Lua parser —
 * the format is uniform enough that this works.
 */
function parseBaseFile(text: string, fileSlot: string): ItemBase[] {
  const out: ItemBase[] = [];
  // itemBases["NAME"] = { ... } blocks
  const blockRe = /itemBases\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const name = m[1];
    const body = m[2];
    const typeMatch = /type\s*=\s*"([^"]+)"/.exec(body);
    if (!typeMatch) continue;
    const subTypeMatch = /subType\s*=\s*"([^"]+)"/.exec(body);
    const reqLevelMatch = /req\s*=\s*\{[^}]*level\s*=\s*(\d+)/.exec(body);
    const tagsMatch = /tags\s*=\s*\{([^}]+)\}/.exec(body);
    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((s) => s.trim().replace(/\s*=\s*true\s*$/, "")).filter(Boolean)
      : [];
    out.push({
      name,
      type: typeMatch[1],
      subType: subTypeMatch?.[1],
      reqLevel: reqLevelMatch ? Number(reqLevelMatch[1]) : 0,
      fileSlot,
      tags,
    });
  }
  return out;
}

/**
 * Pick the highest-level base for a given slot/type that the character can
 * use. Returns null if nothing matches.
 *
 * `slotKey` is one of: body, helmet, gloves, boots, belt, amulet, ring,
 * focus, shield, spear, staff, etc.
 *
 * `subTypePref` lets us filter further — e.g., for body armour we may want
 * "Energy Shield" subtype for int chars vs "Armour" for str chars.
 */
export function pickBaseForLevel(
  bases: ItemBase[],
  fileSlot: string,
  level: number,
  subTypePref?: string,
): ItemBase | null {
  let pool = bases.filter((b) => b.fileSlot === fileSlot && b.reqLevel <= level);
  if (!pool.length) return null;
  if (subTypePref) {
    const sub = pool.filter((b) => b.subType === subTypePref);
    if (sub.length) pool = sub;
  }
  // Highest-level first
  pool.sort((a, b) => b.reqLevel - a.reqLevel);
  return pool[0];
}

/**
 * Class → preferred weapon file slot for the main hand. v1 just picks one;
 * a smarter version would consult the mainSkill's allowed weapon types.
 */
export function weaponForClass(className: string): string {
  switch (className.toLowerCase()) {
    case "monk":
      return "staff";        // Quarterstaves
    case "ranger":
      return "bow";
    case "warrior":
      return "mace";
    case "witch":
    case "sorceress":
      return "wand";         // Could also be staff for 2H caster
    case "mercenary":
      return "crossbow";
    case "druid":
      return "mace";         // PoE2 druid uses one-hand maces + focus
    case "huntress":
      return "spear";
    default:
      return "mace";          // safe default
  }
}

/**
 * Class → preferred off-hand for casters / one-handers. Returns null if the
 * preferred weapon is two-handed.
 */
export function offhandForClass(className: string): string | null {
  switch (className.toLowerCase()) {
    case "monk":
    case "ranger":
    case "mercenary":
      return null;            // two-handed weapons
    case "witch":
    case "sorceress":
    case "druid":
      return "focus";
    case "warrior":
    case "huntress":
      return "shield";
    default:
      return "shield";
  }
}

/**
 * Class → "stat affinity" → preferred armour subtype.
 * Monks/Witches are int/dex — prefer Energy Shield or Evasion.
 * Warriors are str — prefer Armour.
 */
export function armourSubTypeForClass(className: string): string {
  const n = className.toLowerCase();
  if (["warrior", "druid"].includes(n)) return "Armour";
  if (["witch", "sorceress"].includes(n)) return "Energy Shield";
  if (["ranger"].includes(n)) return "Evasion";
  // Hybrids
  return "Evasion";
}
