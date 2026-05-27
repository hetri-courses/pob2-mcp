/**
 * Gem-data loader: reads PoB2's Data/Gems.lua directly.
 *
 * The file is auto-generated and uses a very regular Lua-table subset:
 *   ["Metadata/Items/Gems/..."] = {
 *     name = "Ice Nova",
 *     gemType = "Spell",
 *     tags = { spell = true, area = true, ... },
 *     reqStr = 0, reqDex = 0, reqInt = 100,
 *     ...
 *   },
 *
 * We hand-parse it with a tiny tokenizer; no Lua-bridge round-trip needed,
 * so gem search works even before any build is loaded.
 *
 * ~500 KB file, ~600 gems, parses in ~30ms. Cached after first load.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export type GemType = "Spell" | "Attack" | "Support" | string;

export interface Gem {
  /** Metadata path, used as the canonical id (e.g. "Metadata/Items/Gems/SkillGemIceNova"). */
  id: string;
  name: string;
  baseTypeName?: string;
  gameId?: string;
  variantId?: string;
  grantedEffectId?: string;
  additionalGrantedEffectId1?: string;
  additionalStatSet1?: string;
  additionalStatSet2?: string;
  gemType: GemType;
  /** Family name for support gems with multiple tiers (e.g. "Lightning Penetration"). */
  gemFamily?: string;
  /** Human-readable comma-separated tags (e.g. "AoE, Cold, Duration, Nova"). */
  tagString?: string;
  /** Flattened tag names from the `tags = { x = true }` table. */
  tags: string[];
  weaponRequirements?: string;
  reqStr: number;
  reqDex: number;
  reqInt: number;
  tier: number;
  naturalMaxLevel: number;
  /** True if this is a support gem (gemType === 'Support'). */
  isSupport: boolean;
}

interface CachedGems {
  all: Gem[];
  byId: Map<string, Gem>;
  byNameLower: Map<string, string>;
}

const CACHE = new Map<string, CachedGems>();

/** Load + cache gem data. forkPath is PoB2's `src/` directory. */
export function loadGems(forkPath: string): CachedGems {
  const hit = CACHE.get(forkPath);
  if (hit) return hit;

  const text = readFileSync(path.join(forkPath, "Data", "Gems.lua"), "utf8");
  const all = parseGemsLua(text);

  const byId = new Map<string, Gem>();
  const byNameLower = new Map<string, string>();
  for (const g of all) {
    byId.set(g.id, g);
    byNameLower.set(g.name.toLowerCase(), g.id);
  }
  const cached = { all, byId, byNameLower };
  CACHE.set(forkPath, cached);
  return cached;
}

export interface GemSearchOptions {
  /** Default 20. */
  limit?: number;
  /** Restrict by gem type. */
  gemType?: GemType;
  /** Restrict by tag (e.g. "lightning", "support"). Single tag, case-insensitive. */
  tag?: string;
  /** Also match in tagString. */
  matchTags?: boolean;
  /** Only support gems. */
  supportOnly?: boolean;
  /** Only active skills (excludes supports). */
  activeOnly?: boolean;
}

export interface GemSearchResult extends Gem {
  matchedOn: "name-exact" | "name-prefix" | "name-contains" | "tag" | "family";
  score: number;
}

/**
 * Search gems by name (and optionally tag). Returns ranked results:
 * name-exact > name-prefix > name-contains > tag-match.
 */
export function searchGems(
  forkPath: string,
  query: string,
  options: GemSearchOptions = {}
): GemSearchResult[] {
  const { limit = 20, gemType, tag, matchTags = false, supportOnly, activeOnly } = options;
  const data = loadGems(forkPath);
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const tagLower = tag?.toLowerCase();
  const results: GemSearchResult[] = [];

  for (const g of data.all) {
    if (gemType && g.gemType !== gemType) continue;
    if (supportOnly && !g.isSupport) continue;
    if (activeOnly && g.isSupport) continue;
    if (tagLower && !g.tags.some((t) => t.toLowerCase() === tagLower)) continue;

    const nameLower = g.name.toLowerCase();
    const familyLower = g.gemFamily?.toLowerCase();
    let matched: GemSearchResult["matchedOn"] | null = null;
    let score = 0;

    if (nameLower === q) {
      matched = "name-exact";
      score = 1000;
    } else if (nameLower.startsWith(q)) {
      matched = "name-prefix";
      score = 500 - (nameLower.length - q.length);
    } else if (nameLower.includes(q)) {
      matched = "name-contains";
      score = 250 - nameLower.indexOf(q);
    } else if (familyLower && familyLower.includes(q)) {
      matched = "family";
      score = 200;
    } else if (matchTags && (g.tagString?.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q)))) {
      matched = "tag";
      score = 100;
    }

    if (matched) {
      // Boost active skills slightly over supports for clearer ranking
      if (!g.isSupport) score += 10;
      results.push({ ...g, matchedOn: matched, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Look up a gem by exact id, exact name (case-insensitive), or partial name. */
export function getGem(forkPath: string, idOrName: string): Gem | null {
  const data = loadGems(forkPath);
  if (data.byId.has(idOrName)) return data.byId.get(idOrName)!;
  const lower = idOrName.trim().toLowerCase();
  const idFromName = data.byNameLower.get(lower);
  if (idFromName) return data.byId.get(idFromName) ?? null;
  return null;
}

/**
 * List every gem matching a filter — no query needed. Useful for "give me all
 * support gems compatible with X tags" without going through name search.
 */
export function listGems(
  forkPath: string,
  filter: {
    supportOnly?: boolean;
    activeOnly?: boolean;
    gemType?: GemType;
    /** Require ALL of these tags (case-insensitive). */
    requiresAllTags?: string[];
    /** Require ANY of these tags (case-insensitive). */
    requiresAnyTag?: string[];
  } = {}
): Gem[] {
  const data = loadGems(forkPath);
  const lowerAll = filter.requiresAllTags?.map((t) => t.toLowerCase());
  const lowerAny = filter.requiresAnyTag?.map((t) => t.toLowerCase());

  return data.all.filter((g) => {
    if (filter.supportOnly && !g.isSupport) return false;
    if (filter.activeOnly && g.isSupport) return false;
    if (filter.gemType && g.gemType !== filter.gemType) return false;
    if (lowerAll && lowerAll.length) {
      const lower = g.tags.map((t) => t.toLowerCase());
      if (!lowerAll.every((t) => lower.includes(t))) return false;
    }
    if (lowerAny && lowerAny.length) {
      const lower = g.tags.map((t) => t.toLowerCase());
      if (!lowerAny.some((t) => lower.includes(t))) return false;
    }
    return true;
  });
}

/** List counts per gem type — useful for "how many gems are in PoE2". */
export function gemStats(forkPath: string): {
  total: number;
  byType: Record<string, number>;
  uniqueTags: number;
} {
  const data = loadGems(forkPath);
  const byType: Record<string, number> = {};
  const tagSet = new Set<string>();
  for (const g of data.all) {
    byType[g.gemType] = (byType[g.gemType] ?? 0) + 1;
    for (const t of g.tags) tagSet.add(t);
  }
  return { total: data.all.length, byType, uniqueTags: tagSet.size };
}

// ===========================================================================
// Parser
// ===========================================================================

/**
 * Parse PoB2's Gems.lua file. This file is auto-generated by GGG's exporter
 * and uses a very regular subset of Lua-table syntax. We tokenize + walk it
 * with a tiny hand-rolled parser tuned for this format.
 */
function parseGemsLua(text: string): Gem[] {
  // Skip header. The file starts with comments then `return {`
  const startMatch = text.search(/return\s*\{/);
  if (startMatch < 0) throw new Error("Gems.lua: no `return {` found");
  let i = text.indexOf("{", startMatch) + 1;

  const gems: Gem[] = [];

  while (i < text.length) {
    // Skip whitespace + commas
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === "}") break; // end of outer table

    // Expect `["..."] = { ... }`
    if (text[i] !== "[") {
      // Skip unknown content
      i++;
      continue;
    }
    // Parse the bracketed key string
    i++; // consume [
    if (text[i] !== '"') throw new Error(`expected " at offset ${i}`);
    const keyEnd = findStringEnd(text, i);
    const id = text.slice(i + 1, keyEnd);
    i = keyEnd + 1;
    // Expect ] = {
    i = skipUntil(text, i, "{");
    const bodyEnd = matchBrace(text, i);
    const body = text.slice(i + 1, bodyEnd);
    i = bodyEnd + 1;

    // Parse the body as a flat field=value list (with one nested `tags = { ... }`)
    const fields = parseBody(body);
    const tagsField = fields.tags as Record<string, boolean> | undefined;
    const tags = tagsField ? Object.keys(tagsField).filter((k) => tagsField[k]) : [];

    const name = String(fields.name ?? "");
    const gemType = String(fields.gemType ?? "");
    const gem: Gem = {
      id,
      name,
      baseTypeName: fields.baseTypeName as string | undefined,
      gameId: fields.gameId as string | undefined,
      variantId: fields.variantId as string | undefined,
      grantedEffectId: fields.grantedEffectId as string | undefined,
      additionalGrantedEffectId1: fields.additionalGrantedEffectId1 as string | undefined,
      additionalStatSet1: fields.additionalStatSet1 as string | undefined,
      additionalStatSet2: fields.additionalStatSet2 as string | undefined,
      gemType,
      gemFamily: fields.gemFamily as string | undefined,
      tagString: fields.tagString as string | undefined,
      tags,
      weaponRequirements: fields.weaponRequirements as string | undefined,
      reqStr: Number(fields.reqStr ?? 0),
      reqDex: Number(fields.reqDex ?? 0),
      reqInt: Number(fields.reqInt ?? 0),
      tier: Number(fields.Tier ?? 0),
      naturalMaxLevel: Number(fields.naturalMaxLevel ?? 1),
      isSupport: gemType === "Support",
    };
    if (name) gems.push(gem);
  }

  return gems;
}

function findStringEnd(text: string, openIdx: number): number {
  // openIdx points at the opening quote
  let j = openIdx + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') return j;
    j++;
  }
  throw new Error(`Unterminated string starting at ${openIdx}`);
}

function skipUntil(text: string, from: number, ch: string): number {
  const idx = text.indexOf(ch, from);
  if (idx < 0) throw new Error(`expected '${ch}' after offset ${from}`);
  return idx;
}

/** Given the open-brace position, return the position of the matching close-brace. */
function matchBrace(text: string, openIdx: number): number {
  let depth = 0;
  let j = openIdx;
  let inString = false;
  while (j < text.length) {
    const c = text[j];
    if (inString) {
      if (c === "\\") { j += 2; continue; }
      if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return j;
      }
    }
    j++;
  }
  throw new Error(`Unmatched brace from offset ${openIdx}`);
}

/**
 * Parse a gem entry body: a sequence of `key = value,` pairs.
 * Values are strings, numbers, booleans, or one-deep nested `{ ... }` tables
 * (the `tags = { x = true }` form).
 */
function parseBody(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  const n = body.length;

  while (i < n) {
    // Skip whitespace + commas + comments
    while (i < n && /[\s,]/.test(body[i])) i++;
    if (i >= n) break;
    if (body[i] === "-" && body[i + 1] === "-") {
      // line comment
      while (i < n && body[i] !== "\n") i++;
      continue;
    }

    // Read identifier key
    const keyStart = i;
    while (i < n && /[A-Za-z0-9_]/.test(body[i])) i++;
    if (i === keyStart) {
      i++;
      continue;
    }
    const key = body.slice(keyStart, i);
    // Skip whitespace + `=`
    while (i < n && /\s/.test(body[i])) i++;
    if (body[i] !== "=") continue;
    i++;
    while (i < n && /\s/.test(body[i])) i++;

    // Read value
    if (body[i] === '"') {
      const end = findStringEnd(body, i);
      out[key] = body.slice(i + 1, end);
      i = end + 1;
    } else if (body[i] === "{") {
      const end = matchBrace(body, i);
      out[key] = parseBody(body.slice(i + 1, end));
      i = end + 1;
    } else if (body.startsWith("true", i)) {
      out[key] = true;
      i += 4;
    } else if (body.startsWith("false", i)) {
      out[key] = false;
      i += 5;
    } else {
      // Number (including negative)
      const numStart = i;
      while (i < n && /[-0-9.eE+]/.test(body[i])) i++;
      const numStr = body.slice(numStart, i);
      const num = parseFloat(numStr);
      if (Number.isFinite(num)) out[key] = num;
    }
  }
  return out;
}
