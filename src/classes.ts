/**
 * PoE2 class + ascendancy metadata, extracted from tree.json on demand.
 *
 * tree.classes is an array of objects like:
 *   {
 *     name: "Monk",
 *     integerId: 10,
 *     base_str: 7, base_dex: 11, base_int: 11,
 *     ascendancies: [
 *       { id: "Invoker", internalId: "Monk2", name: "Invoker" },
 *       { id: "Acolyte of Chayula", internalId: "Monk3", name: "Acolyte of Chayula" },
 *     ],
 *   }
 *
 * The ascendancy's `internalId` is `<ClassName><N>` where N is the
 * ascendClassId (1-indexed within the class).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TREE_VERSION } from "./treeData.js";

export interface Ascendancy {
  /** Display name, e.g., "Invoker". */
  name: string;
  /** Internal id like "Monk2"; trailing int is ascendClassId. */
  internalId: string;
  /** PoB's ascendClassId (1, 2, 3) used in tree.classId/ascendClassId. */
  ascendClassId: number;
}

export interface ClassInfo {
  name: string;
  /** tree.json's per-class integerId. Note: PoB may use a DIFFERENT internal classId at runtime. */
  integerId: number;
  baseStr: number;
  baseDex: number;
  baseInt: number;
  ascendancies: Ascendancy[];
}

const CLASS_CACHE = new Map<string, ClassInfo[]>();

/** Load + cache class metadata for a tree version. */
export function loadClasses(forkPath: string, version = DEFAULT_TREE_VERSION): ClassInfo[] {
  const cacheKey = `${forkPath}::${version}`;
  const hit = CLASS_CACHE.get(cacheKey);
  if (hit) return hit;

  const treeJsonPath = path.join(forkPath, "TreeData", version, "tree.json");
  const raw = JSON.parse(readFileSync(treeJsonPath, "utf8")) as {
    classes?: Array<{
      name: string;
      integerId: number;
      base_str: number;
      base_dex: number;
      base_int: number;
      ascendancies?: Array<{ name: string; id: string; internalId: string }>;
    }>;
  };

  const list = (raw.classes ?? []).map<ClassInfo>((c) => ({
    name: c.name,
    integerId: c.integerId,
    baseStr: c.base_str,
    baseDex: c.base_dex,
    baseInt: c.base_int,
    ascendancies: (c.ascendancies ?? []).map<Ascendancy>((a) => {
      // Extract trailing integer from internalId, e.g., "Monk2" → 2
      const m = /(\d+)$/.exec(a.internalId);
      const ascendClassId = m ? Number(m[1]) : 0;
      return { name: a.name, internalId: a.internalId, ascendClassId };
    }),
  }));
  CLASS_CACHE.set(cacheKey, list);
  return list;
}

/** Find a class by case-insensitive name. */
export function findClass(forkPath: string, name: string, version = DEFAULT_TREE_VERSION): ClassInfo | null {
  const lower = name.toLowerCase();
  return loadClasses(forkPath, version).find((c) => c.name.toLowerCase() === lower) ?? null;
}

/** Find an ascendancy by case-insensitive name (across all classes). */
export function findAscendancy(
  forkPath: string,
  className: string,
  ascendancyName: string,
  version = DEFAULT_TREE_VERSION
): Ascendancy | null {
  const cls = findClass(forkPath, className, version);
  if (!cls) return null;
  const lower = ascendancyName.toLowerCase();
  return cls.ascendancies.find((a) => a.name.toLowerCase() === lower) ?? null;
}
