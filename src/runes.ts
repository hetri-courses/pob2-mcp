/**
 * Rune / Soul Core data loader — parses PoB2's Data/ModRunes.lua.
 *
 * Runes (and Soul Cores) are socketable augments. PoE2 0.5 "Return of the
 * Ancients" adds 100+ of them (Ancient Runes, Runic Ward Runes, Kalguuran
 * augments). We had zero tooling for runes before — this fills that gap and
 * automatically covers 0.5 once the fork's ModRunes.lua updates.
 *
 * File shape (auto-generated, very regular):
 *   ["Rune Name"] = {
 *     ["helmet"] = {
 *         type = "SoulCore",
 *         "+40% of Armour also applies to Cold Damage",
 *         statOrder = { 4512 },
 *         rank = { 50 },
 *     },
 *     ["body_armour"] = { ... },
 *   },
 *
 * A rune can apply to multiple gear slots with different mods per slot.
 * We capture name, per-slot {type, mods[], rank}, and a flat union of mods
 * for quick search.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface RuneSlotEffect {
  /** Gear slot key, e.g., "helmet", "body_armour", "martial_weapon". */
  slot: string;
  /** Augment type, e.g., "Rune", "SoulCore". */
  type?: string;
  /** Mod lines this rune grants in this slot. */
  mods: string[];
  /** Required item rank/level if present. */
  rank?: number;
}

export interface Rune {
  name: string;
  /** Per-slot effects. */
  slots: RuneSlotEffect[];
  /** Union of all mod text across slots (deduped) — for search. */
  allMods: string[];
  /** Distinct types seen (usually one). */
  types: string[];
}

interface CachedRunes {
  all: Rune[];
  byNameLower: Map<string, Rune>;
}

const CACHE = new Map<string, CachedRunes>();

export function loadRunes(forkPath: string): CachedRunes {
  const hit = CACHE.get(forkPath);
  if (hit) return hit;

  const filePath = path.join(forkPath, "Data", "ModRunes.lua");
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    const empty = { all: [], byNameLower: new Map() };
    CACHE.set(forkPath, empty);
    return empty;
  }

  const all = parseModRunes(text);
  const byNameLower = new Map<string, Rune>();
  for (const r of all) byNameLower.set(r.name.toLowerCase(), r);
  const cached = { all, byNameLower };
  CACHE.set(forkPath, cached);
  return cached;
}

/**
 * Line-based parser. The file is machine-generated with consistent tab depth:
 *   depth 1: ["Rune Name"] = {
 *   depth 2:   ["slot"] = {
 *   depth 3:     type = "X" / "mod string", / rank = { N }
 * We track current rune + slot by brace depth and the `["..."] = {` pattern.
 */
function parseModRunes(text: string): Rune[] {
  const lines = text.split(/\r?\n/);
  const runes: Rune[] = [];
  let curRune: Rune | null = null;
  let curSlot: RuneSlotEffect | null = null;
  let depth = 0;

  const keyRe = /^\s*\["([^"]+)"\]\s*=\s*\{/;
  const bareStrRe = /^\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/;
  const typeRe = /^\s*type\s*=\s*"([^"]+)"/;
  const rankRe = /^\s*rank\s*=\s*\{\s*(\d+)/;

  for (const line of lines) {
    const km = keyRe.exec(line);
    if (km) {
      // The file is `return { ... }`, so the outer table sits at depth 1.
      // depth 1 → rune name; depth 2 → slot name.
      if (depth === 1) {
        curRune = { name: km[1], slots: [], allMods: [], types: [] };
        runes.push(curRune);
        curSlot = null;
      } else if (depth === 2 && curRune) {
        curSlot = { slot: km[1], mods: [] };
        curRune.slots.push(curSlot);
      }
      depth += countBraces(line);
      continue;
    }

    if (curSlot) {
      const tm = typeRe.exec(line);
      if (tm) {
        curSlot.type = tm[1];
        if (curRune && !curRune.types.includes(tm[1])) curRune.types.push(tm[1]);
      } else {
        const rm = rankRe.exec(line);
        if (rm) {
          curSlot.rank = Number(rm[1]);
        } else {
          const sm = bareStrRe.exec(line);
          // Only treat as a mod if it's a bare quoted string (mods have no `key =`)
          if (sm && !line.includes("=")) {
            curSlot.mods.push(unescapeLua(sm[1]));
            if (curRune && !curRune.allMods.includes(sm[1])) curRune.allMods.push(unescapeLua(sm[1]));
          }
        }
      }
    }

    depth += countBraces(line);
    if (depth < 0) depth = 0;
  }

  return runes;
}

function countBraces(line: string): number {
  // Net brace delta, ignoring braces inside quoted strings (good enough for
  // this machine-generated file — strings rarely contain unbalanced braces).
  let net = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    else if (!inStr && c === "{") net++;
    else if (!inStr && c === "}") net--;
  }
  return net;
}

function unescapeLua(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export interface RuneSearchResult extends Rune {
  matchedOn: "name" | "mod" | "slot" | "type";
}

/**
 * Search runes by name, mod text, slot, or type. Case-insensitive substring.
 */
export function searchRunes(
  forkPath: string,
  query: string,
  options: { limit?: number; slot?: string; type?: string } = {},
): RuneSearchResult[] {
  const { limit = 30, slot, type } = options;
  const { all } = loadRunes(forkPath);
  const q = query.trim().toLowerCase();
  const out: RuneSearchResult[] = [];

  for (const r of all) {
    if (slot && !r.slots.some((s) => s.slot.toLowerCase().includes(slot.toLowerCase()))) continue;
    if (type && !r.types.some((t) => t.toLowerCase() === type.toLowerCase())) continue;

    if (!q) {
      out.push({ ...r, matchedOn: "name" });
    } else if (r.name.toLowerCase().includes(q)) {
      out.push({ ...r, matchedOn: "name" });
    } else if (r.allMods.some((m) => m.toLowerCase().includes(q))) {
      out.push({ ...r, matchedOn: "mod" });
    } else if (r.types.some((t) => t.toLowerCase().includes(q))) {
      out.push({ ...r, matchedOn: "type" });
    }
    if (out.length >= limit) break;
  }
  return out;
}

export function getRune(forkPath: string, name: string): Rune | null {
  return loadRunes(forkPath).byNameLower.get(name.toLowerCase()) ?? null;
}
