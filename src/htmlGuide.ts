/**
 * HTML build-guide generator.
 *
 * Composes a single self-contained .html file from the structured build data
 * we already have: parsed XML, live calc stats, tree-node names, gem metadata,
 * items. Icons are pulled via the IconResolver (poe2db.tw + PoB2 bundled
 * slot icons) and base64-embedded so the result works fully offline.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import type { LuaBridge } from "./luaBridge.js";
import { resolveNodes } from "./treeData.js";
import { getGem, type Gem } from "./gemData.js";
import {
  IconResolver,
  passiveIconRefFromPath,
  gemIconRef,
  slotIconRef,
  type IconRef,
} from "./icons.js";
import { GLOSSARY, glossaryRegex, lookupGlossary } from "./glossary.js";
import { loadRawTree, renderTreeSvg } from "./treeSvg.js";

export interface GenerateGuideOptions {
  /** Where to write the .html. Default: D:\pob2-mcp\generated\<buildName>.html */
  outputPath?: string;
  /** Output dir. Defaults to D:\pob2-mcp\generated\. */
  outputDir?: string;
  /** Title override. Defaults to build name + class. */
  title?: string;
  /** Per-icon fetch timeout. Default 10s. */
  iconTimeoutMs?: number;
  /** If false, skip fetching icons (use placeholders only). Default true. */
  fetchIcons?: boolean;
}

export interface GenerateGuideResult {
  htmlPath: string;
  sizeBytes: number;
  iconCount: number;
  iconBytes: number;
  iconsFetched: number;
  iconsFromCache: number;
  iconsMissing: number;
  elapsedMs: number;
}

export async function generateBuildGuide(
  bridge: LuaBridge,
  forkPath: string,
  options: GenerateGuideOptions = {}
): Promise<GenerateGuideResult> {
  const start = Date.now();
  const outputDir = options.outputDir ?? path.resolve("D:\\pob2-mcp\\generated");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const cacheDir = path.join(outputDir, ".icon-cache");
  const resolver = new IconResolver(cacheDir);

  // -----------------------------------------------------------------------
  // Gather everything we need from the live build
  // -----------------------------------------------------------------------
  const info = ((await bridge.send({ action: "get_build_info" })).info ?? {}) as {
    name?: string; level?: number; treeVersion?: string;
    className?: string; ascendClassName?: string;
  };
  const statsResp = await bridge.send({ action: "get_stats" });
  const stats = (statsResp.stats ?? {}) as Record<string, number>;
  const treeResp = await bridge.send({ action: "get_tree" });
  const treeObj = (treeResp.tree ?? {}) as {
    nodes?: number[]; treeVersion?: string;
    classId?: number; ascendClassId?: number;
  };
  const allocated = treeObj.nodes ?? [];
  const treeVersion = treeObj.treeVersion ?? info.treeVersion ?? "0_4";
  const classId = treeObj.classId;

  const skillsResp = await bridge.send({ action: "get_skills" });
  const skillsObj = (skillsResp.skills ?? {}) as {
    mainSocketGroup?: number;
    groups?: Array<{
      index: number; label?: string; slot?: string; enabled?: boolean;
      mainActiveSkill?: number;
      skills?: string[];
      gems?: Array<{
        index: number; nameSpec?: string; skillId?: string; gemId?: string;
        level: number; quality: number; enabled: boolean; isSupport?: boolean;
      }>;
    }>;
  };

  const itemsResp = await bridge.send({ action: "get_items", params: { onlyEquipped: true } });
  const items = ((itemsResp.items ?? []) as Array<{
    slot?: string; name?: string; baseName?: string; rarity?: string; type?: string; raw?: string;
  }>).filter((i) => i.name);

  // Resolved tree-node metadata so we can render names + stats
  const resolvedNodes = resolveNodes(forkPath, allocated, treeVersion);
  // Full raw tree — geometry for the SVG renderer + icon paths.
  // (loadRawTree caches, so this is ~free on subsequent calls.)
  const rawTreeFull = loadRawTree(forkPath, treeVersion);
  // Narrow shape used by the existing icon code below
  const rawTree = rawTreeFull as unknown as { nodes: Record<string, { icon?: string }> };

  // Pre-render the tree SVG (cheap — ~50ms for the whole tree).
  const treeSvg = renderTreeSvg(rawTreeFull, {
    allocated: new Set(allocated.map(Number)),
    ascendancyName: info.ascendClassName && info.ascendClassName !== "None" ? info.ascendClassName : undefined,
    classStartIndex: classId,
    width: 1200,
  });

  // -----------------------------------------------------------------------
  // Embed icons
  // -----------------------------------------------------------------------
  const iconDataUris = new Map<string, string>();
  let fetched = 0, fromCache = 0, missing = 0, totalBytes = 0;

  const tryEmbed = async (ref: IconRef | null): Promise<string | null> => {
    if (!ref) return null;
    if (iconDataUris.has(ref.cacheKey)) return iconDataUris.get(ref.cacheKey)!;
    const r = options.fetchIcons === false ? null
      : await resolver.embed(ref, { timeoutMs: options.iconTimeoutMs ?? 10000 });
    if (!r) {
      missing++;
      return null;
    }
    if (r.fetched) fetched++; else fromCache++;
    totalBytes += r.bytes;
    iconDataUris.set(ref.cacheKey, r.dataUri);
    return r.dataUri;
  };

  // Pre-fetch all icons (parallel so the WAF doesn't get suspicious of a tight loop)
  const passiveIconJobs: Array<Promise<void>> = [];
  const passiveIconByNodeId = new Map<number, string | null>();
  for (const id of allocated) {
    const raw = rawTree.nodes[String(id)];
    const node = resolvedNodes.find((n) => n.id === id);
    if (!raw?.icon || !node) {
      passiveIconByNodeId.set(id, null);
      continue;
    }
    passiveIconJobs.push(
      tryEmbed(passiveIconRefFromPath(raw.icon, node.type)).then((uri) => {
        passiveIconByNodeId.set(id, uri);
      })
    );
  }
  // throttle: at most 8 in flight at once would be cleaner, but for the sizes
  // we deal with the simple approach is fine
  await Promise.all(passiveIconJobs);

  const gemIconByName = new Map<string, string | null>();
  const gemDbCache = new Map<string, Gem | null>();
  const gemJobs: Array<Promise<void>> = [];
  for (const g of skillsObj.groups ?? []) {
    for (const gem of g.gems ?? []) {
      const name = gem.nameSpec ?? gem.skillId ?? "";
      if (!name || gemIconByName.has(name)) continue;
      gemIconByName.set(name, null); // placeholder
      let dbGem = gemDbCache.get(name);
      if (dbGem === undefined) {
        dbGem = getGem(forkPath, name);
        gemDbCache.set(name, dbGem);
      }
      if (!dbGem) continue;
      gemJobs.push(
        tryEmbed(gemIconRef(dbGem)).then((uri) => {
          if (uri) gemIconByName.set(name, uri);
        })
      );
    }
  }
  await Promise.all(gemJobs);

  const slotIconByName = new Map<string, string | null>();
  for (const it of items) {
    if (!it.slot || slotIconByName.has(it.slot)) continue;
    slotIconByName.set(it.slot, await tryEmbed(slotIconRef(forkPath, it.slot)));
  }

  // -----------------------------------------------------------------------
  // Compose HTML
  // -----------------------------------------------------------------------
  const buildName = info.name ?? "Build";
  const className = info.className ?? "Unknown";
  const ascend = info.ascendClassName && info.ascendClassName !== "None" ? info.ascendClassName : null;
  const level = info.level ?? 1;

  const safeFilename = buildName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "build";
  const htmlPath = options.outputPath ?? path.join(outputDir, `${safeFilename}.html`);
  const title = options.title ?? `${buildName} — ${className}${ascend ? " / " + ascend : ""}`;

  const html = renderHtml({
    title,
    buildName,
    className,
    ascendClassName: ascend,
    level,
    treeVersion,
    stats,
    skills: skillsObj,
    items,
    resolvedNodes,
    passiveIconByNodeId,
    gemIconByName,
    slotIconByName,
    gemDbCache,
    treeSvg,
  });

  writeFileSync(htmlPath, html, "utf8");
  return {
    htmlPath,
    sizeBytes: Buffer.byteLength(html, "utf8"),
    iconCount: iconDataUris.size,
    iconBytes: totalBytes,
    iconsFetched: fetched,
    iconsFromCache: fromCache,
    iconsMissing: missing,
    elapsedMs: Date.now() - start,
  };
}

// ===========================================================================
// HTML composition
// ===========================================================================

interface RenderInputs {
  title: string;
  buildName: string;
  className: string;
  ascendClassName: string | null;
  level: number;
  treeVersion: string;
  stats: Record<string, number>;
  skills: {
    mainSocketGroup?: number;
    groups?: Array<{
      index: number; label?: string; slot?: string; enabled?: boolean;
      mainActiveSkill?: number;
      gems?: Array<{
        index: number; nameSpec?: string; skillId?: string;
        level: number; quality: number; enabled: boolean; isSupport?: boolean;
      }>;
    }>;
  };
  items: Array<{ slot?: string; name?: string; baseName?: string; rarity?: string; type?: string; raw?: string }>;
  resolvedNodes: Array<{ id: number; name: string; type: string; stats: string[]; ascendancyName?: string }>;
  passiveIconByNodeId: Map<number, string | null>;
  gemIconByName: Map<string, string | null>;
  slotIconByName: Map<string, string | null>;
  gemDbCache: Map<string, Gem | null>;
  /** Pre-rendered SVG of the passive tree with allocated nodes highlighted. */
  treeSvg: string;
}

function renderHtml(d: RenderInputs): string {
  const headerStats = renderHeaderStats(d.stats);
  const skillsSection = renderSkills(d);
  const treeSection = renderTree(d);
  const itemsSection = renderItems(d);
  const glossarySection = renderGlossary();
  const css = renderCss();
  const js = renderJs();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(d.title)}</title>
<style>${css}</style>
</head>
<body>
<div class="layout">
<aside class="sidebar">
  <div class="glossary-toggle"><button data-action="toggle-glossary">📖 Glossary</button></div>
  <nav class="toc">
    <a href="#stats">Stats</a>
    <a href="#skills">Skills</a>
    <a href="#tree">Passive Tree</a>
    <a href="#items">Items</a>
    <a href="#glossary">Glossary</a>
  </nav>
</aside>
<main>
  <header class="build-header">
    <div class="title-block">
      <h1>${escapeHtml(d.buildName)}</h1>
      <div class="subtitle">
        <span class="class-tag">${escapeHtml(d.className)}</span>
        ${d.ascendClassName ? `<span class="ascend-tag">${escapeHtml(d.ascendClassName)}</span>` : ""}
        <span class="level-tag">Level ${d.level}</span>
        <span class="tree-tag">Tree v${escapeHtml(d.treeVersion)}</span>
      </div>
    </div>
    ${headerStats}
  </header>
  ${skillsSection}
  ${treeSection}
  ${itemsSection}
  ${glossarySection}
</main>
</div>
<div id="tooltip" class="tooltip" role="tooltip" aria-hidden="true"></div>
<script>${js}</script>
</body></html>`;
}

function renderHeaderStats(stats: Record<string, number>): string {
  const blocks: Array<{ label: string; val: string | number; tag?: string; key: string }> = [];
  const num = (k: string) => (typeof stats[k] === "number" ? stats[k] : null);
  const fmt = (n: number) =>
    n >= 1000 ? n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : n.toFixed(2);

  const life = num("Life"); if (life != null) blocks.push({ label: "Life", val: fmt(life), key: "Life" });
  const mana = num("Mana"); if (mana != null) blocks.push({ label: "Mana", val: fmt(mana), key: "Mana" });
  const es = num("EnergyShield"); if (es != null && es > 0) blocks.push({ label: "ES", val: fmt(es), key: "EnergyShield" });
  const spirit = num("Spirit"); if (spirit != null) blocks.push({ label: "Spirit", val: fmt(spirit), key: "Spirit" });
  const tdps = num("TotalDPS"); if (tdps != null) blocks.push({ label: "Total DPS", val: fmt(tdps), key: "TotalDPS" });
  const ehp = num("TotalEHP"); if (ehp != null) blocks.push({ label: "EHP", val: fmt(ehp), key: "EHP" });
  const pdr = num("PhysicalDamageReduction"); if (pdr != null) blocks.push({ label: "Phys Reduction", val: pdr + "%", key: "PhysicalDamageReduction" });
  const spd = num("Speed"); if (spd != null) blocks.push({ label: "Speed", val: spd.toFixed(2) + "/s", key: "Speed" });

  return `<div class="stat-grid">
    ${blocks.map((b) => `<div class="stat" data-stat="${escapeHtml(b.key)}">
      <div class="stat-label">${escapeHtml(b.label)}</div>
      <div class="stat-val">${escapeHtml(String(b.val))}</div>
    </div>`).join("")}
  </div>`;
}

function renderSkills(d: RenderInputs): string {
  const groups = d.skills.groups ?? [];
  if (!groups.length) return "";

  const cards = groups.map((g) => {
    const isMain = g.index === d.skills.mainSocketGroup;
    const slotLabel = g.slot ? `<span class="group-slot">${escapeHtml(g.slot)}</span>` : "";
    const label = g.label ? `<span class="group-label">${escapeHtml(g.label)}</span>` : "";
    const gems = (g.gems ?? []).map((gem) => renderGemCard(gem, d)).join("");
    return `<div class="skill-group ${isMain ? "main" : ""} ${g.enabled === false ? "disabled" : ""}">
      <div class="group-header">
        <span class="group-index">#${g.index}</span>
        ${label}
        ${slotLabel}
        ${isMain ? '<span class="main-badge">MAIN</span>' : ""}
        ${g.enabled === false ? '<span class="off-badge">OFF</span>' : ""}
      </div>
      <div class="gem-row">${gems || '<div class="empty-row">(empty)</div>'}</div>
    </div>`;
  });

  return `<section id="skills" class="section">
    <h2>Skill Setup</h2>
    <p class="hint">Each socket group is a gem link. Active skills glow green; supports glow purple. Hover any gem for details.</p>
    <div class="skill-groups">${cards.join("")}</div>
  </section>`;
}

function renderGemCard(gem: { nameSpec?: string; skillId?: string; level: number; quality: number; enabled: boolean; isSupport?: boolean }, d: RenderInputs): string {
  const name = gem.nameSpec ?? gem.skillId ?? "?";
  const iconUri = d.gemIconByName.get(name);
  const dbGem = d.gemDbCache.get(name);
  const isSupport = dbGem?.isSupport ?? gem.isSupport ?? /support/i.test(name);
  const tags = dbGem?.tagString ?? "";
  const reqs: string[] = [];
  if (dbGem?.reqStr) reqs.push(`Str ${dbGem.reqStr}`);
  if (dbGem?.reqDex) reqs.push(`Dex ${dbGem.reqDex}`);
  if (dbGem?.reqInt) reqs.push(`Int ${dbGem.reqInt}`);

  const tooltipLines = [
    `<strong>${escapeHtml(name)}</strong>`,
    isSupport ? "Support gem" : `${escapeHtml(dbGem?.gemType ?? "Active")} skill`,
    `Level ${gem.level} · Quality ${gem.quality}%`,
    tags ? `Tags: ${escapeHtml(tags)}` : "",
    reqs.length ? `Requires ${reqs.join(", ")}` : "",
    dbGem?.weaponRequirements ? `Weapon: ${escapeHtml(dbGem.weaponRequirements)}` : "",
  ].filter(Boolean).join("<br>");

  return `<div class="gem ${isSupport ? "support" : "active"} ${gem.enabled === false ? "off" : ""}"
    data-tooltip="${escapeAttr(tooltipLines)}">
    ${iconUri ? `<img class="gem-icon" src="${iconUri}" alt="${escapeAttr(name)}" loading="lazy">` : `<div class="gem-icon placeholder">${escapeHtml(initials(name))}</div>`}
    <div class="gem-meta">
      <div class="gem-name">${escapeHtml(name)}</div>
      <div class="gem-stats">
        <span class="gem-level">L${gem.level}</span>
        ${gem.quality > 0 ? `<span class="gem-qual">${gem.quality}%</span>` : ""}
        ${gem.enabled === false ? '<span class="gem-off">OFF</span>' : ""}
      </div>
    </div>
  </div>`;
}

function renderTree(d: RenderInputs): string {
  // Group nodes by type, keystones first
  const byType: Record<string, typeof d.resolvedNodes> = {
    keystone: [], notable: [], "ascendancy-notable": [], "ascendancy-normal": [], normal: [], "jewel-socket": [],
  };
  for (const n of d.resolvedNodes) (byType[n.type] ??= []).push(n);

  const sectionFor = (type: string, label: string) => {
    const nodes = byType[type];
    if (!nodes?.length) return "";
    const cards = nodes.map((n) => {
      const iconUri = d.passiveIconByNodeId.get(n.id);
      const stats = (n.stats ?? []).map((s) => `<div class="passive-stat">${linkifyGlossary(escapeHtml(s))}</div>`).join("");
      const tooltip = `<strong>${escapeHtml(n.name)}</strong> (${escapeHtml(n.type)})<br>` +
        (n.stats?.length ? n.stats.map(escapeHtml).join("<br>") : "(no stats)");
      return `<div class="passive ${type}" data-tooltip="${escapeAttr(tooltip)}">
        ${iconUri ? `<img class="passive-icon" src="${iconUri}" alt="${escapeAttr(n.name)}" loading="lazy">` : `<div class="passive-icon placeholder">${escapeHtml(initials(n.name))}</div>`}
        <div class="passive-meta">
          <div class="passive-name">${escapeHtml(n.name)}</div>
          ${stats}
        </div>
      </div>`;
    }).join("");
    return `<div class="passive-group">
      <h3 class="passive-group-label">${escapeHtml(label)} <span class="count">${nodes.length}</span></h3>
      <div class="passives">${cards}</div>
    </div>`;
  };

  return `<section id="tree" class="section">
    <h2>Passive Tree</h2>
    <div class="tree-map" aria-label="Passive tree overview">${d.treeSvg}</div>
    <p class="hint">${d.resolvedNodes.length} nodes allocated. Hover any node for full stat text.</p>
    ${sectionFor("keystone", "Keystones")}
    ${sectionFor("ascendancy-notable", "Ascendancy Notables")}
    ${sectionFor("notable", "Notables")}
    ${sectionFor("ascendancy-normal", "Ascendancy Small")}
    ${sectionFor("normal", "Small Passives")}
    ${sectionFor("jewel-socket", "Jewel Sockets")}
  </section>`;
}

function renderItems(d: RenderInputs): string {
  if (!d.items.length) return `<section id="items" class="section"><h2>Items</h2><p class="hint">No items equipped.</p></section>`;
  const cards = d.items.map((it) => {
    const rarityClass = (it.rarity || "normal").toLowerCase();
    const iconUri = it.slot ? d.slotIconByName.get(it.slot) : null;
    const modLines = (it.raw ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) =>
        s &&
        !/^Rarity:|^Item Level:|^Quality:|^Requires Level:|^--+$/i.test(s)
      )
      .slice(1) // skip the name line which we display separately
      .map((s) => `<div class="item-mod">${linkifyGlossary(escapeHtml(s))}</div>`)
      .join("");
    return `<div class="item rarity-${rarityClass}">
      <div class="item-head">
        ${iconUri ? `<img class="slot-icon" src="${iconUri}" alt="${escapeAttr(it.slot ?? "")}" loading="lazy">` : `<div class="slot-icon placeholder"></div>`}
        <div class="item-name-block">
          <div class="item-slot">${escapeHtml(it.slot ?? "")}</div>
          <div class="item-name">${escapeHtml(it.name ?? "")}</div>
          ${it.baseName && it.baseName !== it.name ? `<div class="item-base">${escapeHtml(it.baseName)}</div>` : ""}
        </div>
      </div>
      <div class="item-mods">${modLines}</div>
    </div>`;
  }).join("");
  return `<section id="items" class="section">
    <h2>Items <span class="count">${d.items.length}</span></h2>
    <div class="items">${cards}</div>
  </section>`;
}

function renderGlossary(): string {
  // Sort by tag → term
  const byTag = new Map<string, typeof GLOSSARY>();
  for (const e of GLOSSARY) {
    const tag = e.tag ?? "other";
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(e);
  }
  const sections = [...byTag.entries()].map(([tag, entries]) =>
    `<div class="gloss-group">
      <h3 class="gloss-tag">${escapeHtml(tag)}</h3>
      ${entries.sort((a, b) => a.term.localeCompare(b.term)).map((e) =>
        `<div class="gloss-entry">
          <dt id="g-${slugify(e.term)}">${escapeHtml(e.term)}</dt>
          <dd>${escapeHtml(e.short)}${e.long ? `<br><em>${escapeHtml(e.long)}</em>` : ""}</dd>
        </div>`).join("")}
    </div>`
  ).join("");
  return `<section id="glossary" class="section">
    <h2>Glossary</h2>
    <p class="hint">Underlined terms in the body link here. PoE2 jargon defined below.</p>
    <div class="glossary">${sections}</div>
  </section>`;
}

// -- helpers -----------------------------------------------------------------

function linkifyGlossary(text: string): string {
  const rx = glossaryRegex();
  return text.replace(rx, (m) => {
    const entry = lookupGlossary(m);
    if (!entry) return m;
    return `<a class="gloss-link" href="#g-${slugify(entry.term)}" data-tooltip="${escapeAttr(entry.short)}">${m}</a>`;
  });
}

function initials(s: string): string {
  return s.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 3).toUpperCase();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// -- assets ------------------------------------------------------------------

function renderCss(): string {
  return `
:root {
  --bg: #14121a;
  --bg-card: #1d1a26;
  --bg-elev: #25212f;
  --fg: #d4ccdb;
  --fg-dim: #8a8294;
  --accent: #b88aff;
  --accent-2: #5cd4ff;
  --rarity-normal: #c8c8c8;
  --rarity-magic: #8888ff;
  --rarity-rare: #ffff77;
  --rarity-unique: #af6025;
  --active: #4ade80;
  --support: #c084fc;
  --keystone: #e9a8ff;
  --notable: #ffd569;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; line-height: 1.5; }
.layout { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
.sidebar { background: #100e16; padding: 1.5rem 1rem; position: sticky; top: 0; height: 100vh; border-right: 1px solid #2a2434; }
.sidebar .toc { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
.sidebar .toc a { color: var(--fg-dim); text-decoration: none; padding: 0.4rem 0.5rem; border-radius: 4px; font-size: 0.9rem; }
.sidebar .toc a:hover { background: #1d1a26; color: var(--fg); }
.sidebar button { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border: none; color: #14121a; padding: 0.5rem 0.8rem; border-radius: 6px; font-weight: 600; cursor: pointer; width: 100%; }
main { padding: 2rem 2.5rem; max-width: 1400px; }

.build-header { padding: 1.5rem; background: linear-gradient(135deg, #1d1a26, #2a2434); border-radius: 12px; margin-bottom: 2rem; border: 1px solid #2a2434; }
.title-block h1 { margin: 0 0 0.5rem; font-size: 2rem; background: linear-gradient(135deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.subtitle { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.class-tag, .ascend-tag, .level-tag, .tree-tag { background: var(--bg-elev); padding: 0.25rem 0.7rem; border-radius: 4px; font-size: 0.85rem; color: var(--fg-dim); }
.ascend-tag { color: var(--accent); border: 1px solid var(--accent); background: rgba(184, 138, 255, 0.1); }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-top: 1.2rem; }
.stat { background: var(--bg-elev); padding: 0.7rem 0.9rem; border-radius: 8px; border-left: 3px solid var(--accent); }
.stat-label { font-size: 0.75rem; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.stat-val { font-size: 1.3rem; font-weight: 600; margin-top: 0.2rem; color: var(--fg); }

.section { margin: 2.5rem 0; }
.section h2 { font-size: 1.5rem; margin: 0 0 0.5rem; padding-bottom: 0.4rem; border-bottom: 2px solid var(--accent); display: inline-block; }
.section .hint { color: var(--fg-dim); font-size: 0.9rem; margin: 0 0 1.2rem; }
.section .count { background: var(--bg-elev); font-size: 0.7em; padding: 0.1rem 0.4rem; border-radius: 4px; vertical-align: middle; }

.skill-groups { display: flex; flex-direction: column; gap: 1rem; }
.skill-group { background: var(--bg-card); padding: 0.9rem 1rem; border-radius: 8px; border: 1px solid #2a2434; }
.skill-group.main { border-color: var(--active); box-shadow: 0 0 0 1px var(--active); }
.skill-group.disabled { opacity: 0.5; }
.group-header { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.7rem; font-size: 0.85rem; }
.group-index { color: var(--fg-dim); font-family: monospace; }
.group-label, .group-slot { color: var(--fg); }
.group-slot { color: var(--accent-2); }
.main-badge { background: var(--active); color: #14121a; padding: 0.1rem 0.4rem; border-radius: 3px; font-weight: 700; font-size: 0.7rem; }
.off-badge { background: #555; color: #ddd; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.7rem; }
.gem-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.gem { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; background: var(--bg-elev); border-radius: 6px; border: 1px solid transparent; cursor: help; min-width: 180px; }
.gem.active { border-color: rgba(74, 222, 128, 0.4); }
.gem.support { border-color: rgba(192, 132, 252, 0.4); }
.gem.off { opacity: 0.5; }
.gem-icon { width: 36px; height: 36px; border-radius: 4px; image-rendering: -webkit-optimize-contrast; }
.gem-icon.placeholder { display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg-dim); font-size: 0.7rem; font-weight: 700; font-family: monospace; }
.gem-meta { display: flex; flex-direction: column; }
.gem-name { font-weight: 600; font-size: 0.9rem; }
.gem-stats { display: flex; gap: 0.5rem; font-size: 0.75rem; color: var(--fg-dim); }
.gem.active .gem-level { color: var(--active); }
.gem.support .gem-level { color: var(--support); }
.empty-row { color: var(--fg-dim); font-style: italic; padding: 0.5rem; }

/* Tree minimap (inline SVG generated by treeSvg.ts) */
.tree-map { margin: 0.5rem 0 1.5rem; background: #0e0e10; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; overflow: hidden; }
.tree-map svg { width: 100%; height: auto; max-height: 70vh; }

.passive-group { margin-bottom: 1.2rem; }
.passive-group-label { font-size: 1rem; color: var(--fg-dim); margin: 0 0 0.6rem; text-transform: uppercase; letter-spacing: 0.5px; }
.passives { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem; }
.passive { display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem; background: var(--bg-card); border-radius: 6px; border: 1px solid #2a2434; cursor: help; }
.passive.keystone { border-color: var(--keystone); background: linear-gradient(135deg, #1d1a26, #2a1e3a); }
.passive.notable, .passive.ascendancy-notable { border-color: var(--notable); }
.passive-icon { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; }
.passive-icon.placeholder { display: flex; align-items: center; justify-content: center; background: var(--bg-elev); color: var(--fg-dim); font-size: 0.65rem; font-weight: 700; }
.passive-meta { min-width: 0; }
.passive-name { font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.passive.keystone .passive-name { color: var(--keystone); }
.passive.notable .passive-name, .passive.ascendancy-notable .passive-name { color: var(--notable); }
.passive-stat { font-size: 0.72rem; color: var(--fg-dim); line-height: 1.3; }

.items { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.8rem; }
.item { background: var(--bg-card); padding: 0.8rem 1rem; border-radius: 8px; border: 1px solid #2a2434; }
.item.rarity-magic .item-name { color: var(--rarity-magic); }
.item.rarity-rare .item-name { color: var(--rarity-rare); }
.item.rarity-unique .item-name { color: var(--rarity-unique); }
.item-head { display: flex; gap: 0.7rem; margin-bottom: 0.7rem; padding-bottom: 0.7rem; border-bottom: 1px solid #2a2434; }
.slot-icon { width: 48px; height: 48px; object-fit: contain; flex-shrink: 0; }
.slot-icon.placeholder { background: var(--bg-elev); border-radius: 4px; }
.item-slot { font-size: 0.7rem; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.item-name { font-size: 1rem; font-weight: 600; }
.item-base { font-size: 0.8rem; color: var(--fg-dim); }
.item-mods { display: flex; flex-direction: column; gap: 0.2rem; }
.item-mod { font-size: 0.85rem; color: var(--fg); }

.gloss-link { color: var(--accent-2); text-decoration: underline dotted; }
.glossary { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }
.gloss-group { background: var(--bg-card); padding: 1rem; border-radius: 8px; }
.gloss-tag { color: var(--accent); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 0.7rem; }
.gloss-entry { margin-bottom: 0.7rem; }
.gloss-entry dt { font-weight: 600; color: var(--fg); font-size: 0.92rem; }
.gloss-entry dd { margin: 0.2rem 0 0; color: var(--fg-dim); font-size: 0.82rem; line-height: 1.45; }

.tooltip { position: fixed; pointer-events: none; background: #100e16; border: 1px solid var(--accent); padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.82rem; max-width: 320px; line-height: 1.4; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6); z-index: 1000; opacity: 0; transform: translateY(-4px); transition: opacity 100ms; }
.tooltip.show { opacity: 1; transform: translateY(0); }

@media (max-width: 880px) { .layout { grid-template-columns: 1fr; } .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid #2a2434; } main { padding: 1rem; } }
`;
}

function renderJs(): string {
  return `
(() => {
  const tip = document.getElementById('tooltip');
  function show(el) {
    const text = el.getAttribute('data-tooltip');
    if (!text) return;
    tip.innerHTML = text;
    tip.classList.add('show');
    move(el);
  }
  function move(el) {
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - tr.width / 2;
    let y = r.bottom + 6;
    if (x + tr.width > innerWidth - 8) x = innerWidth - tr.width - 8;
    if (x < 8) x = 8;
    if (y + tr.height > innerHeight - 8) y = r.top - tr.height - 6;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hide() { tip.classList.remove('show'); }
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tooltip]');
    if (t) show(t);
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.classList.contains('show')) {
      const t = e.target.closest('[data-tooltip]');
      if (t) move(t); else hide();
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tooltip]')) hide();
  });
})();
`;
}
