/**
 * Icon resolution + fetch/cache/embed for the HTML build guide.
 *
 * Three sources:
 *   1. Passive nodes — URL pattern matches tree.json's `node.icon` path
 *      (poe2db.tw mirrors PoB2's CDN paths, just swap .dds → .webp).
 *   2. Gem icons — pattern: `Art/2DItems/Gems/New/<NameCamelCase>SkillGem.webp`
 *      on poe2db.tw's CDN.
 *   3. Slot icons — PoB2 ships these as PNGs in src/Assets/, no network needed.
 *
 * Strategy: fetch each unique URL once, cache to disk
 * (D:\pob2-mcp\generated\.icon-cache\), then base64-embed in the generated
 * HTML so the file works fully offline once created.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TreeNode } from "./treeData.js";
import type { Gem } from "./gemData.js";

const POE2DB_CDN = "https://cdn.poe2db.tw/image/";

// ---------------------------------------------------------------------------
// Static gem-name → icon-path map (scraped from poe2db.tw/us/Gem).
// Loaded lazily on first gemIconRef call. ~97% coverage of our 903 PoE2 gems.
// Regenerate with: node tools/scrape-gem-icons.mjs
// ---------------------------------------------------------------------------
let GEM_ICON_MAP: Record<string, string> | null = null;
function loadGemIconMap(): Record<string, string> {
  if (GEM_ICON_MAP) return GEM_ICON_MAP;
  // Resolve data/gem-icons.json relative to this file. After tsc, the file
  // lives at build/icons.js — data/ is up one level.
  // Prefer not failing the entire HTML guide on a missing JSON, so swallow.
  try {
    // We use a direct path rather than import.meta.resolve to keep this
    // synchronous and ESM-portable across build outputs.
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    // From build/ -> ../data/gem-icons.json; from src/ -> ../data/gem-icons.json
    const candidates = [
      path.join(here, "..", "data", "gem-icons.json"),
      path.join(here, "..", "..", "data", "gem-icons.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, "utf8")) as {
          icons: Record<string, string>;
        };
        GEM_ICON_MAP = json.icons || {};
        return GEM_ICON_MAP;
      }
    }
  } catch {
    /* fall through to empty map */
  }
  GEM_ICON_MAP = {};
  return GEM_ICON_MAP;
}
// poe2db.tw's CDN runs behind a WAF that 403s minimalist User-Agents.
// Browser-like headers (Sec-Fetch-*, real Chrome UA, Referer) get through.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  Referer: "https://poe2db.tw/",
} as const;

export interface IconRef {
  /** The remote URL (or local file path) we'll resolve from. */
  src: string;
  /** A short kind tag for fallback placeholders. */
  kind: "passive-keystone" | "passive-notable" | "passive-normal" | "passive-jewel" | "gem-active" | "gem-support" | "slot" | "unknown";
  /** A stable cache key (filename in the icon cache). */
  cacheKey: string;
  /** MIME type to emit when base64-embedding. */
  mime: string;
  /** True if the source is already a local file (no network needed). */
  local?: boolean;
}

// (We dropped the unused TreeNode-based wrapper; callers use the *FromPath
// form, which reads `icon` straight out of raw tree.json.)
void [] as unknown as TreeNode; // keep the import for downstream callers' type hints

/** Resolve via a raw tree.json icon path (e.g. "Art/2DArt/SkillIcons/passives/X.dds"). */
export function passiveIconRefFromPath(iconPath: string, nodeType: string): IconRef | null {
  if (!iconPath) return null;
  // tree.json paths use forward or backward slashes; normalise
  const cleanPath = iconPath.replace(/\\/g, "/").replace(/\.dds$/i, ".webp");
  const src = POE2DB_CDN + cleanPath;
  const filename = cleanPath.split("/").pop()!;
  let kind: IconRef["kind"] = "passive-normal";
  if (nodeType === "keystone") kind = "passive-keystone";
  else if (nodeType === "notable" || nodeType === "ascendancy-notable") kind = "passive-notable";
  else if (nodeType === "jewel-socket") kind = "passive-jewel";
  return { src, kind, cacheKey: "passive-" + filename, mime: "image/webp" };
}

/**
 * Resolve gem icon URL.
 *
 * Two-stage:
 *   1. Look up the gem name in the static scrape map (data/gem-icons.json).
 *      Hits ~97% of PoE2 gems. Path is `Art/2DArt/SkillIcons/...webp`.
 *   2. Fall back to the gameId-tail heuristic (`Art/2DItems/Gems/New/...webp`).
 *      Catches a few stragglers but most miss.
 */
export function gemIconRef(gem: Gem): IconRef | null {
  // Stage 1: static map lookup
  const map = loadGemIconMap();
  const mapped = map[gem.name];
  if (mapped) {
    const filename = mapped.split("/").pop() ?? gem.name;
    return {
      src: POE2DB_CDN + mapped,
      kind: gem.isSupport ? "gem-support" : "gem-active",
      cacheKey: "gem-" + filename,
      mime: "image/webp",
    };
  }

  // Stage 2: gameId-tail heuristic (legacy path)
  // Prefer gameId — name-based guessing fails for variants ("Flicker Strike"
  // is actually SkillGemFlickerStrikeTeleport in PoB2's gem data).
  const m = gem.gameId
    ? /\/(SkillGem|SupportGem)([A-Za-z0-9_]+)$/.exec(gem.gameId)
    : null;
  let core: string | null = null;
  let isSupport = gem.isSupport;
  if (m) {
    core = m[2];
    isSupport = m[1] === "SupportGem";
  } else if (gem.variantId) {
    core = gem.variantId.replace(/[^A-Za-z0-9]/g, "");
  } else if (gem.name) {
    // Last-ditch fallback: CamelCase the name
    core = gem.name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map(capitalize).join("");
  }
  if (!core) return null;
  const suffix = isSupport ? "Support" : "SkillGem";
  const filename = `${core}${suffix}.webp`;
  return {
    src: `${POE2DB_CDN}Art/2DItems/Gems/New/${filename}`,
    kind: isSupport ? "gem-support" : "gem-active",
    cacheKey: "gem-" + filename,
    mime: "image/webp",
  };
}

/** Resolve a slot icon. Maps PoE2 slot names to PoB2's bundled PNGs. */
export function slotIconRef(forkPath: string, slotName: string): IconRef | null {
  const map: Record<string, string> = {
    "Weapon 1": "icon_weapon.png",
    "Weapon 2": "icon_weapon_2.png",
    "Weapon 1 Swap": "icon_weapon_swap.png",
    "Weapon 2 Swap": "icon_weapon_2_swap.png",
    "Helmet": "icon_helmet.png",
    "Body Armour": "icon_body_armour.png",
    "Gloves": "icon_gloves.png",
    "Boots": "icon_boots.png",
    "Amulet": "icon_amulet.png",
    "Belt": "icon_belt.png",
    "Ring 1": "icon_ring_left.png",
    "Ring 2": "icon_ring_right.png",
    "Ring 3": "icon_ring_right.png",
  };
  const file = map[slotName];
  if (!file) return null;
  const full = path.join(forkPath, "Assets", file);
  if (!existsSync(full)) return null;
  return {
    src: full,
    kind: "slot",
    cacheKey: "slot-" + file,
    mime: "image/png",
    local: true,
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Cache + embed
// ---------------------------------------------------------------------------

export interface EmbedResult {
  /** A `data:` URI ready to drop into <img src>. */
  dataUri: string;
  /** True if we had to fetch it over the network this call. */
  fetched: boolean;
  /** Size of the raw bytes. */
  bytes: number;
}

export class IconResolver {
  private readonly cacheDir: string;
  private readonly memoryCache = new Map<string, EmbedResult>();
  /** URLs we tried + failed to fetch. Don't retry within the same run. */
  private readonly failedSet = new Set<string>();
  /** Optional whitelist: if non-empty, only allow CDN bases listed here. */
  private allowedHosts = new Set([
    "cdn.poe2db.tw",
    "poe2db.tw",
  ]);

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  }

  /**
   * Resolve an IconRef into a base64 data URI. Tries: memory cache, disk
   * cache, network. Returns null on failure so the HTML can fall back to a
   * CSS placeholder.
   */
  async embed(ref: IconRef, opts: { timeoutMs?: number } = {}): Promise<EmbedResult | null> {
    if (this.failedSet.has(ref.src)) return null;

    const cached = this.memoryCache.get(ref.cacheKey);
    if (cached) return cached;

    const diskPath = path.join(this.cacheDir, ref.cacheKey);
    let bytes: Buffer | null = null;
    let fetched = false;

    if (existsSync(diskPath)) {
      try {
        bytes = readFileSync(diskPath);
      } catch {
        bytes = null;
      }
    }

    if (!bytes && ref.local) {
      // Local file source (e.g. PoB2's bundled slot icons)
      try {
        bytes = readFileSync(ref.src);
        writeFileSync(diskPath, bytes);
      } catch {
        this.failedSet.add(ref.src);
        return null;
      }
    }

    if (!bytes) {
      // Network fetch
      let url: URL;
      try {
        url = new URL(ref.src);
      } catch {
        this.failedSet.add(ref.src);
        return null;
      }
      if (!this.allowedHosts.has(url.hostname)) {
        this.failedSet.add(ref.src);
        return null;
      }
      bytes = await this.fetchBytes(url.toString(), opts.timeoutMs ?? 8000);
      if (!bytes) {
        this.failedSet.add(ref.src);
        return null;
      }
      try { writeFileSync(diskPath, bytes); } catch { /* non-fatal */ }
      fetched = true;
    }

    const dataUri = `data:${ref.mime};base64,${bytes.toString("base64")}`;
    const result: EmbedResult = { dataUri, fetched, bytes: bytes.length };
    this.memoryCache.set(ref.cacheKey, result);
    return result;
  }

  private async fetchBytes(url: string, timeoutMs: number): Promise<Buffer | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctl.signal });
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
