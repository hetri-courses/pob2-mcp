/**
 * Skill-data loader — parses PoB2's Data/Skills/*.lua for the per-skill
 * facts that Gems.lua doesn't carry: character level requirement, weapon
 * type restriction, skill-type flags, and description.
 *
 * This fills a real gap: previously we could see a gem exists + its tags,
 * but not (a) what character level can use it, nor (b) which weapon it
 * requires — which is exactly what determines whether a skill is valid for a
 * given build (e.g. a Spear skill cannot be used by an unarmed Hollow Palm
 * Monk). Now both are data-driven.
 *
 * Skill blocks look like:
 *   skills["KillingPalmPlayer"] = {
 *     name = "Killing Palm",
 *     skillTypes = { [SkillType.Attack] = true, [SkillType.QuarterstaffSkill] = true, ... },
 *     weaponTypes = { ["Staff"] = true },
 *     description = "...",
 *     levels = { [1] = { levelRequirement = 0, ... }, [2] = { levelRequirement = 3, ... }, ... },
 *   }
 *
 * Active skills live in act_{str,int,dex}.lua / other.lua / minion.lua;
 * support gems in sup_{str,int,dex}.lua.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const SKILL_FILES = [
  "act_dex", "act_int", "act_str", "other", "minion",
  "sup_dex", "sup_int", "sup_str",
];

export interface SkillInfo {
  grantedEffectId: string;
  name?: string;
  /** Character level required to use the gem at level 1. */
  levelReq: number;
  /** Required weapon types, e.g. ["Staff"], ["Spear"]. Empty = no restriction. */
  weaponTypes: string[];
  /** Skill-type flags, e.g. ["Attack","Melee","Physical","QuarterstaffSkill"]. */
  skillTypes: string[];
  description?: string;
  /** True if usable with a Quarterstaff (works unarmed via Hollow Palm). */
  isQuarterstaff: boolean;
}

const BLOB_CACHE = new Map<string, string>();
const INFO_CACHE = new Map<string, SkillInfo | null>();

function loadBlob(forkPath: string): string {
  const hit = BLOB_CACHE.get(forkPath);
  if (hit != null) return hit;
  const dir = path.join(forkPath, "Data", "Skills");
  const blob = SKILL_FILES.map((f) => {
    try { return readFileSync(path.join(dir, `${f}.lua`), "utf8"); } catch { return ""; }
  }).join("\n");
  BLOB_CACHE.set(forkPath, blob);
  return blob;
}

/** Extract one `skills["id"] = { ... }` block via brace matching. */
function extractBlock(blob: string, id: string): string | null {
  const marker = `skills["${id}"] = {`;
  const start = blob.indexOf(marker);
  if (start < 0) return null;
  const open = blob.indexOf("{", start);
  let depth = 0;
  for (let j = open; j < blob.length; j++) {
    if (blob[j] === "{") depth++;
    else if (blob[j] === "}") { depth--; if (depth === 0) return blob.slice(open, j + 1); }
  }
  return null;
}

/** Look up skill info by grantedEffectId (e.g. "KillingPalmPlayer"). */
export function getSkillInfo(forkPath: string, grantedEffectId: string): SkillInfo | null {
  const cacheKey = `${forkPath}::${grantedEffectId}`;
  if (INFO_CACHE.has(cacheKey)) return INFO_CACHE.get(cacheKey)!;

  const body = extractBlock(loadBlob(forkPath), grantedEffectId);
  if (!body) { INFO_CACHE.set(cacheKey, null); return null; }

  const name = (body.match(/name\s*=\s*"([^"]+)"/) || [])[1];
  const wt = (body.match(/weaponTypes\s*=\s*\{([^}]*)\}/) || [])[1] || "";
  const weaponTypes = (wt.match(/\["([^"]+)"\]/g) || []).map((s) => s.replace(/[[\]"]/g, ""));
  const st = (body.match(/skillTypes\s*=\s*\{([^}]*)\}/) || [])[1] || "";
  const skillTypes = (st.match(/SkillType\.(\w+)/g) || []).map((s) => s.replace("SkillType.", ""));
  const description = (body.match(/description\s*=\s*"([^"]*)"/) || [])[1];
  // First levelRequirement in the levels table = the gem-level-1 requirement.
  const reqM = body.match(/levelRequirement\s*=\s*(\d+)/);
  const levelReq = reqM ? Number(reqM[1]) : 0;

  const info: SkillInfo = {
    grantedEffectId,
    name,
    levelReq,
    weaponTypes,
    skillTypes,
    description,
    isQuarterstaff: skillTypes.includes("QuarterstaffSkill") || weaponTypes.includes("Staff"),
  };
  INFO_CACHE.set(cacheKey, info);
  return info;
}
