/**
 * Unique-item data loader — parses PoB2's Data/Uniques/*.lua.
 *
 * Each file is one slot category (amulet, body, staff, …) and contains a
 * `return { [[ <block> ]], [[ <block> ]], ... }` where each block is the
 * unique's text:
 *
 *   The Anvil
 *   Bloodstone Amulet
 *   Variant: Pre 0.2.0
 *   Variant: Current
 *   Implicits: 1
 *   {tags:life}+(30-40) to maximum Life
 *   {variant:1}20% increased Block chance
 *   ...
 *
 * We had no unique tooling before — this fills that gap and auto-covers any
 * new uniques once the fork's Uniques/ files update for a new patch.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface UniqueItem {
  name: string;
  /** Base type, e.g., "Bloodstone Amulet". */
  baseType: string;
  /** Slot category derived from the source file (amulet, body, staff, …). */
  category: string;
  /** All variant labels declared (e.g., "Current", "Pre 0.4.0"). */
  variants: string[];
  /** Mod lines, with PoB {tags:..}/{variant:..} markup stripped for readability. */
  mods: string[];
  /** Raw mod lines including markup (for fidelity). */
  rawMods: string[];
}

interface CachedUniques {
  all: UniqueItem[];
  byNameLower: Map<string, UniqueItem>;
}

const CACHE = new Map<string, CachedUniques>();

// Unique files mirror the base-item slot files.
const UNIQUE_FILES = [
  "amulet", "axe", "belt", "body", "boots", "bow", "claw", "crossbow",
  "dagger", "flail", "focus", "gloves", "helmet", "jewel", "mace", "quiver",
  "ring", "sceptre", "shield", "spear", "staff", "sword", "tincture",
  "traptool", "soulcore", "talisman", "flask",
];

export function loadUniques(forkPath: string): CachedUniques {
  const hit = CACHE.get(forkPath);
  if (hit) return hit;

  const all: UniqueItem[] = [];
  for (const cat of UNIQUE_FILES) {
    const filePath = path.join(forkPath, "Data", "Uniques", `${cat}.lua`);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    all.push(...parseUniqueFile(text, cat));
  }

  const byNameLower = new Map<string, UniqueItem>();
  for (const u of all) byNameLower.set(u.name.toLowerCase(), u);
  const cached = { all, byNameLower };
  CACHE.set(forkPath, cached);
  return cached;
}

/** Extract every [[ ... ]] block and parse its lines. */
function parseUniqueFile(text: string, category: string): UniqueItem[] {
  const out: UniqueItem[] = [];
  // Match Lua long-string blocks: [[ ... ]] (non-greedy, across newlines)
  const blockRe = /\[\[\s*\r?\n([\s\S]*?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const block = m[1];
    const u = parseUniqueBlock(block, category);
    if (u) out.push(u);
  }
  return out;
}

function parseUniqueBlock(block: string, category: string): UniqueItem | null {
  const lines = block.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  // First two non-empty lines = name, base type
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return null;

  const name = nonEmpty[0].trim();
  const baseType = nonEmpty[1].trim();
  const variants: string[] = [];
  const mods: string[] = [];
  const rawMods: string[] = [];

  for (let i = 2; i < nonEmpty.length; i++) {
    const line = nonEmpty[i].trim();
    if (/^Variant:/i.test(line)) {
      variants.push(line.replace(/^Variant:\s*/i, ""));
      continue;
    }
    // Skip metadata directives
    if (/^(Implicits|Requires Level|League|Source|Upgrade|Has Alt Variant|Selected Variant|Crafted|Prefix|Suffix|Sockets|LevelReq|Limited to|Radius|Variant)\b/i.test(line)) {
      continue;
    }
    if (/^-{3,}$/.test(line)) continue;
    rawMods.push(line);
    // Strip PoB markup: {tags:...} {variant:...} {range:...} {crafted} leading tokens
    const clean = line.replace(/\{[^}]*\}/g, "").trim();
    if (clean) mods.push(clean);
  }

  return { name, baseType, category, variants, mods, rawMods };
}

export interface UniqueSearchResult extends UniqueItem {
  matchedOn: "name" | "base" | "mod";
}

export function searchUniques(
  forkPath: string,
  query: string,
  options: { limit?: number; category?: string } = {},
): UniqueSearchResult[] {
  const { limit = 30, category } = options;
  const { all } = loadUniques(forkPath);
  const q = query.trim().toLowerCase();
  const out: UniqueSearchResult[] = [];

  for (const u of all) {
    if (category && u.category.toLowerCase() !== category.toLowerCase()) continue;
    if (!q) {
      out.push({ ...u, matchedOn: "name" });
    } else if (u.name.toLowerCase().includes(q)) {
      out.push({ ...u, matchedOn: "name" });
    } else if (u.baseType.toLowerCase().includes(q)) {
      out.push({ ...u, matchedOn: "base" });
    } else if (u.mods.some((mod) => mod.toLowerCase().includes(q))) {
      out.push({ ...u, matchedOn: "mod" });
    }
    if (out.length >= limit) break;
  }
  return out;
}

export function getUnique(forkPath: string, name: string): UniqueItem | null {
  return loadUniques(forkPath).byNameLower.get(name.toLowerCase()) ?? null;
}
