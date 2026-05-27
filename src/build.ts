/**
 * PoB2 build XML → typed structure.
 *
 * The PoB2 build XML schema has three major top-level elements under <PathOfBuilding>:
 *   <Build>     — character meta (level, class, ascendancy)
 *   <Tree>      — one or more <Spec> elements with allocated passive nodes
 *   <Skills>    — socket groups containing gem links
 *   <Items>     — item bases + assignments to slots
 *   <Notes>     — free-form text
 *   <TreeView>  — UI state (we ignore)
 *   <Calcs>     — config knobs for the calc engine
 *
 * This module wraps fast-xml-parser with a typed surface focused on what an LLM
 * actually needs to reason about builds. We're deliberately lossy — we don't
 * round-trip every UI artifact. Encoding a modified Build back to XML is a
 * follow-up; for Phase 1 we're read-only.
 */

import { XMLParser } from "fast-xml-parser";

export interface PoB2Build {
  meta: BuildMeta;
  trees: TreeSpec[];
  skills: SocketGroup[];
  items: BuildItem[];
  notes: string;
  raw: unknown; // escape hatch: full parsed XML object
}

export interface BuildMeta {
  level: number;
  className: string;
  ascendClassName: string;
  /** "<Build mainSocketGroup>" — which skill group is the configured "main" for DPS calc */
  mainSocketGroup: number | null;
  /** Build version PoB last saved this with */
  version: string | null;
}

export interface TreeSpec {
  title: string;
  classId: number;
  ascendClassId: number;
  treeVersion: string;
  /** Comma-separated node IDs allocated in this spec */
  nodes: number[];
  masteryEffects: Record<number, number>;
}

export interface SocketGroup {
  label: string;
  slot: string | null;
  enabled: boolean;
  mainActiveSkill: number;
  gems: BuildGem[];
}

export interface BuildGem {
  name: string;
  /** Whether this is a support gem */
  support: boolean;
  level: number;
  quality: number;
  qualityId: string | null;
  enabled: boolean;
  /** Number of copies (e.g. for "Cast When Damage Taken" stacks) */
  count: number;
}

export interface BuildItem {
  id: number;
  slot: string | null;
  /** Raw item text — same format you'd see in-game when copying an item */
  text: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Preserve element order where it matters (skill links, item slots)
  preserveOrder: false,
  // Don't coerce numeric-looking strings — we handle that ourselves
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: "_text",
});

/**
 * Parse a PoB build XML payload into a typed structure.
 *
 * Accepts both PoE1 (`<PathOfBuilding>`) and PoE2 (`<PathOfBuilding2>`) root
 * elements — the schemas are largely shared, with PoE2 adding ascendancy
 * structure changes, lineage gems, and new stats.
 */
export function parseBuildXml(xml: string): PoB2Build {
  const raw = parser.parse(xml) as {
    PathOfBuilding?: PoBRoot;
    PathOfBuilding2?: PoBRoot;
  };
  const root = raw.PathOfBuilding2 ?? raw.PathOfBuilding;
  if (!root) {
    throw new Error(
      "Invalid build XML: missing <PathOfBuilding> or <PathOfBuilding2> root element"
    );
  }

  return {
    meta: parseMeta(root),
    trees: parseTrees(root.Tree),
    skills: parseSkills(root.Skills),
    items: parseItems(root.Items),
    notes: typeof root.Notes === "string" ? root.Notes : root.Notes?._text ?? "",
    raw,
  };
}

// --- internals ----------------------------------------------------------------

interface PoBRoot {
  Build?: BuildAttrs;
  Tree?: TreeXml;
  Skills?: SkillsXml;
  Items?: ItemsXml;
  Notes?: string | { _text: string };
}

interface BuildAttrs {
  level?: string;
  className?: string;
  ascendClassName?: string;
  mainSocketGroup?: string;
  version?: string;
}

interface TreeXml {
  Spec?: SpecXml | SpecXml[];
}

interface SpecXml {
  title?: string;
  classId?: string;
  ascendClassId?: string;
  treeVersion?: string;
  nodes?: string;
  masteryEffects?: string;
}

interface SkillsXml {
  SkillSet?: SkillSetXml | SkillSetXml[];
  Skill?: SocketGroupXml | SocketGroupXml[];
}

interface SkillSetXml {
  Skill?: SocketGroupXml | SocketGroupXml[];
}

interface SocketGroupXml {
  label?: string;
  slot?: string;
  enabled?: string;
  mainActiveSkill?: string;
  Gem?: GemXml | GemXml[];
}

interface GemXml {
  nameSpec?: string;
  skillId?: string;
  gemId?: string;
  level?: string;
  quality?: string;
  qualityId?: string;
  enabled?: string;
  count?: string;
  // PoE2 uses Lineage Gems with different schema fields than PoE1 — TBD on parsing
}

interface ItemsXml {
  Item?: ItemXml | ItemXml[];
  Slot?: SlotXml | SlotXml[];
}

interface ItemXml {
  id?: string;
  _text?: string;
}

interface SlotXml {
  name?: string;
  itemId?: string;
}

function parseMeta(root: PoBRoot): BuildMeta {
  const b = root.Build ?? {};
  const mainGroupRaw = b.mainSocketGroup;
  return {
    level: parseIntOr(b.level, 1),
    className: b.className ?? "Unknown",
    ascendClassName: b.ascendClassName ?? "None",
    mainSocketGroup: mainGroupRaw != null ? parseInt(mainGroupRaw, 10) : null,
    version: b.version ?? null,
  };
}

function parseTrees(tree: TreeXml | undefined): TreeSpec[] {
  if (!tree?.Spec) return [];
  const specs = toArray(tree.Spec);
  return specs.map((s) => ({
    title: s.title ?? "Untitled",
    classId: parseIntOr(s.classId, 0),
    ascendClassId: parseIntOr(s.ascendClassId, 0),
    treeVersion: s.treeVersion ?? "unknown",
    nodes: parseCsvInts(s.nodes),
    masteryEffects: parseMasteryEffects(s.masteryEffects),
  }));
}

function parseSkills(skills: SkillsXml | undefined): SocketGroup[] {
  if (!skills) return [];
  // PoB2 may wrap skills in <SkillSet> elements; flatten across all sets
  const groups: SocketGroupXml[] = [];
  if (skills.SkillSet) {
    for (const set of toArray(skills.SkillSet)) {
      if (set.Skill) groups.push(...toArray(set.Skill));
    }
  }
  if (skills.Skill) groups.push(...toArray(skills.Skill));

  return groups.map((g) => ({
    label: g.label ?? "",
    slot: g.slot ?? null,
    enabled: g.enabled !== "false",
    mainActiveSkill: parseIntOr(g.mainActiveSkill, 1),
    gems: g.Gem ? toArray(g.Gem).map(parseGem) : [],
  }));
}

function parseGem(g: GemXml): BuildGem {
  const name = g.nameSpec ?? g.skillId ?? g.gemId ?? "Unknown";
  const isSupport = /support/i.test(g.skillId ?? "") || /support/i.test(name);
  return {
    name,
    support: isSupport,
    level: parseIntOr(g.level, 1),
    quality: parseIntOr(g.quality, 0),
    qualityId: g.qualityId ?? null,
    enabled: g.enabled !== "false",
    count: parseIntOr(g.count, 1),
  };
}

function parseItems(items: ItemsXml | undefined): BuildItem[] {
  if (!items?.Item) return [];
  const itemList = toArray(items.Item);
  const slots = items.Slot ? toArray(items.Slot) : [];
  const slotByItemId = new Map<string, string>();
  for (const slot of slots) {
    if (slot.itemId && slot.name) slotByItemId.set(slot.itemId, slot.name);
  }
  return itemList.map((it) => ({
    id: parseIntOr(it.id, 0),
    slot: it.id ? slotByItemId.get(it.id) ?? null : null,
    text: (it._text ?? "").trim(),
  }));
}

// --- helpers ------------------------------------------------------------------

function toArray<T>(x: T | T[]): T[] {
  return Array.isArray(x) ? x : [x];
}

function parseIntOr(s: string | undefined, fallback: number): number {
  if (s == null) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseCsvInts(s: string | undefined): number[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((x) => Number.isFinite(x));
}

function parseMasteryEffects(s: string | undefined): Record<number, number> {
  // Format: "{nodeId,effectId},{nodeId,effectId},..."
  if (!s) return {};
  const out: Record<number, number> = {};
  const re = /\{(\d+),(\d+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[parseInt(m[1], 10)] = parseInt(m[2], 10);
  }
  return out;
}
