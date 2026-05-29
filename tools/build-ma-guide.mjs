/**
 * Unarmed Crit Martial Artist — PoE2 0.5 league-start guide (HTML).
 * Maxroll-style: scannable, structured, minimal prose. Interactive pan/zoom
 * passive tree (GGG 0.5 export) showing a CONNECTED path from the Monk start,
 * coloured by level bracket, with rich hover tooltips (name + full effects).
 *
 * Run: POB_TREE_VERSION=0_5 node tools/build-ma-guide.mjs
 * Out: generated/martial-artist-leaguestart.html
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadTree, findPathToNode } from "../build/treeData.js";
import { loadRawTree, renderTreeSvg, nodeCoords } from "../build/treeSvg.js";
import { IconResolver } from "../build/icons.js";
import { loadGems } from "../build/gemData.js";
import { getSkillInfo } from "../build/skillData.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const VERSION = "0_5";
const MONK_START = 44683; // class-start node serving Monk (classStartIndex includes 10)

const tree = loadTree(forkPath, VERSION);
const raw = loadRawTree(forkPath, VERSION);
const byName = (n) => tree.all.find((x) => x.name === n);

// Strip PoB markup ([A|B]→B, [A]→A) for human-readable tooltips.
const clean = (s) => s.replace(/\[(?:[^\]|]*\|)?([^\]]*)\]/g, "$1").replace(/\{[^}]*\}/g, "").trim();

// ---- Phased allocation: ordered targets per level bracket -------------------
const PHASES = [
  { range: "Lvl 1–17", color: "#4fd1c5", note: "Combo leveling base — hit-based, no crit gear",
    targets: ["Chakra of Rhythm", "Chakra of Impact"] },
  { range: "Lvl 18–40", color: "#5b9bd5", note: "Combo core + travel toward unarmed",
    targets: ["Disciplined Training", "Martial Artistry"] },
  { range: "Lvl 41–70", color: "#ffcf6e", note: "Hollow Palm pivot + ev/ES gear swap + core defense",
    targets: ["Hollow Palm Technique", "Strong Chin", "Eldritch Will", "Afterimage"] },
  { range: "Lvl 71+", color: "#ff6a3d", note: "Endgame crit respec — Combo now multiplies crits",
    targets: ["Critical Exploit", "Calculated Hunter", "Overwhelming Strike", "Locked On",
      "Heartbreaking", "Sundering", "Leaping Ambush", "Icebreaker", "Escape Strategy"] },
];

const allocated = new Set([MONK_START]);
const nodeColors = new Map();
const nodePhases = new Map(); // id -> phase number (1..4)
nodePhases.set(MONK_START, 1);
const reachedLandmarks = []; // {name, range, color}
let unreachable = [];

PHASES.forEach((ph, i) => {
  const phaseNum = i + 1;
  for (const tName of ph.targets) {
    const tn = byName(tName);
    if (!tn) { unreachable.push(tName + " (no node)"); continue; }
    const r = findPathToNode(forkPath, [...allocated], tn.id, { version: VERSION, maxHops: 90 });
    if (!r) { unreachable.push(tName + " (unreachable)"); continue; }
    for (const node of r.path) {
      if (!allocated.has(node.id)) {
        allocated.add(node.id);
        nodeColors.set(node.id, ph.color);
        nodePhases.set(node.id, phaseNum);
      }
    }
    reachedLandmarks.push({ name: tName, range: ph.range, color: ph.color, type: tn.type });
  }
});
// Frame on the main-tree path (exclude ascendancy, which we add next)
const frameNodeIds = new Set(allocated);

// Martial Artist ascendancy landmarks (separate subgraph; distinct colour).
// Shown from phase 2 onward (ascendancy points come during the campaign).
const ASC_COLOR = "#c08bf0";
const ascNames = ["Way of the Stonefist", "Martial Master", "Martial Adept", "Way of the Mountain"];
for (const n of tree.all.filter((x) => x.ascendancyName === "Martial Artist")) {
  if (ascNames.includes(n.name)) { allocated.add(n.id); nodeColors.set(n.id, ASC_COLOR); nodePhases.set(n.id, 2); }
}

// Cumulative per-phase view boxes (main-tree path nodes only; ascendancy is
// off-corner and excluded so the camera frames the relevant cluster).
const PHASE_VIEWS = PHASES.map((_, i) => {
  const upto = i + 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const id of frameNodeIds) {
    if ((nodePhases.get(id) ?? 99) > upto) continue;
    const xy = nodeCoords(raw, raw.nodes[id]);
    if (!xy) continue;
    if (xy.x < minX) minX = xy.x; if (xy.x > maxX) maxX = xy.x;
    if (xy.y < minY) minY = xy.y; if (xy.y > maxY) maxY = xy.y;
  }
  if (minX === Infinity) return null;
  const pad = 1100;
  return { x: Math.round(minX - pad), y: Math.round(minY - pad), w: Math.round(maxX - minX + 2 * pad), h: Math.round(maxY - minY + 2 * pad) };
});

// ---- Tooltip data: every allocated node + every notable/keystone in view ----
const tooltipIds = new Set(allocated);
for (const n of tree.all) {
  if (n.ascendancyName && n.ascendancyName !== "Martial Artist") continue;
  if (n.type === "notable" || n.type === "keystone" || n.type === "ascendancy-notable") tooltipIds.add(n.id);
}
const tipData = {};
for (const id of tooltipIds) {
  const n = tree.byId.get(id);
  if (!n) continue;
  tipData[id] = {
    n: n.name || "Passive",
    t: n.type,
    s: (n.stats || []).map(clean).filter(Boolean),
  };
}

// ---- Fetch + embed real passive-node icons (poe2db CDN, deduped) -----------
const outDir0 = path.join(here, "..", "generated");
const resolver = new IconResolver(path.join(outDir0, ".icon-cache"));
const iconByNode = new Map(); // id -> webp path
const uniquePaths = new Set();
for (const id of allocated) {
  const ic = raw.nodes[id] && raw.nodes[id].icon;
  if (!ic) continue;
  const webp = ic.replace(/\.(png|dds)$/i, ".webp").replace(/\\/g, "/");
  iconByNode.set(id, webp);
  uniquePaths.add(webp);
}
const uriByPath = new Map();
let iconHit = 0, iconMiss = 0;
for (const webp of uniquePaths) {
  const ref = {
    src: "https://cdn.poe2db.tw/image/" + webp,
    kind: "passive-normal",
    cacheKey: "passive-" + webp.replace(/[^a-z0-9.]/gi, "_"),
    mime: "image/webp",
  };
  const r = await resolver.embed(ref, { timeoutMs: 12000 });
  if (r) { uriByPath.set(webp, r.dataUri); iconHit++; } else iconMiss++;
}
const nodeIcons = new Map();
for (const [id, webp] of iconByNode) {
  const u = uriByPath.get(webp);
  if (u) nodeIcons.set(id, u);
}

// ============================ SKILLS TAB DATA ============================
const gemDb = loadGems(forkPath).all;
const gemIconMap = JSON.parse(readFileSync(path.join(here, "..", "data", "gem-icons.json"), "utf8")).icons;
let maSupports = { skills: {} };
try { maSupports = JSON.parse(readFileSync(path.join(here, "..", "data", "ma-supports.json"), "utf8")); } catch { /* run measure-ma-supports.mjs */ }
const gemByName = (n) => gemDb.find((x) => x.name === n);
const skillInfoByName = (n) => { const g = gemByName(n); return g ? getSkillInfo(forkPath, g.grantedEffectId) : null; };
const cleanDesc = (s) => (s || "").replace(/\[(?:[^\]|]*\|)?([^\]]*)\]/g, "$1").replace(/\{[^}]*\}/g, "").trim();
async function embedGemIcon(name) {
  const p = gemIconMap[name];
  if (!p) return null;
  const webp = p.replace(/\.(png|dds)$/i, ".webp").replace(/\\/g, "/");
  const ref = { src: "https://cdn.poe2db.tw/image/" + webp, kind: "gem-active", cacheKey: "gem-" + webp.replace(/[^a-z0-9.]/gi, "_"), mime: "image/webp" };
  const rr = await resolver.embed(ref, { timeoutMs: 12000 });
  return rr ? rr.dataUri : null;
}

const PRIMARY = "Killing Palm";
const ALT_SKILLS = ["Staggering Palm", "Tempest Flurry", "Ice Strike", "Falling Thunder", "Glacial Cascade", "Charged Staff"];

// Full skill loadout. `from` = level-bracket index it comes online (0=1-17 … 3=71+).
// Every skill verified Staff/None/any-weapon (works unarmed via Hollow Palm).
const LOADOUT = [
  { role: "Main Attack", skill: PRIMARY, from: 0, main: true },
  { role: "Movement", skill: "Gathering Storm", from: 0, supports: [] },
  { role: "Block / Defence", skill: "Parry", from: 0, supports: [] },
  { role: "Herald (persistent)", skill: "Herald of Ash", from: 1, supports: [] },
  { role: "Warcry", skill: "Ancestral Cry", from: 2, supports: [] },
  { role: "Curse", skill: "Vulnerability", from: 2, supports: ["Blasphemy"] },
];

const primSupports = (maSupports.skills[PRIMARY] && maSupports.skills[PRIMARY].supports) || [];
const posSup = primSupports.filter((s) => s.delta > 0);
const compatSup = primSupports.filter((s) => s.delta <= 0).slice(0, 10);
const orderedSupports = [...posSup, ...compatSup]; // best-measured first
const MAIN_SUP_BY_BRACKET = [1, 3, 4, 5]; // support sockets open as you level

// Embed icons for every gem shown anywhere in the skills tab.
const gemIcons = new Map();
const allGemNames = new Set([
  ...LOADOUT.map((l) => l.skill),
  ...LOADOUT.flatMap((l) => l.supports || []),
  ...orderedSupports.map((s) => s.name),
  ...ALT_SKILLS,
]);
for (const n of allGemNames) gemIcons.set(n, await embedGemIcon(n));

const primInfo = skillInfoByName(PRIMARY);
const SKILL_PHASES = [
  { label: "Lv 1–17" }, { label: "Lv 18–40" }, { label: "Lv 41–70" }, { label: "Lv 71+" },
];
const socket = (name, sub, pct, isMain) =>
  `<div class="socket${isMain ? " main" : ""}">` +
  `${gemIcons.get(name) ? `<img src="${gemIcons.get(name)}" alt="${name}">` : '<span class="noic"></span>'}` +
  `<span class="so-nm">${name}</span>` +
  (sub ? `<span class="so-sub">${sub}</span>` : "") +
  (pct ? `<span class="so-pct">+${pct}%</span>` : "") +
  `</div>`;

const groupCard = (l, bracketIdx) => {
  const info = skillInfoByName(l.skill);
  let supSockets = "";
  if (l.main) {
    const n = MAIN_SUP_BY_BRACKET[bracketIdx];
    supSockets = orderedSupports.slice(0, n).map((s) => socket(s.name, null, s.delta > 0 ? s.pct : null, false)).join("");
  } else if ((l.supports || []).length) {
    supSockets = l.supports.map((s) => socket(s, null, null, false)).join("");
  }
  const ele = info ? (info.skillTypes.find((t) => ["Fire", "Cold", "Lightning", "Physical"].includes(t)) || "") : "";
  const sub = `${ele}${info ? (ele ? " · " : "") + "Lv " + info.levelReq : ""}`;
  const linked = supSockets ? `<span class="link-arrow">+</span><div class="support-sockets">${supSockets}</div>` : "";
  return `<div class="grp"><div class="grp-role">${l.role}</div><div class="socket-row">${socket(l.skill, sub, null, true)}${linked}</div></div>`;
};

const skTabs = SKILL_PHASES.map((ph, i) =>
  `<button class="skbt${i === SKILL_PHASES.length - 1 ? " active" : ""}" data-skbt="${i}">${ph.label}</button>`
).join("");
const skSetups = SKILL_PHASES.map((ph, i) => {
  const groups = LOADOUT.filter((l) => l.from <= i).map((l) => groupCard(l, i)).join("");
  return `<div class="gem-setup${i === SKILL_PHASES.length - 1 ? "" : " hidden"}" data-skset="${i}">${groups}</div>`;
}).join("");

const skillsHtml = `
<section><h2>Skill loadout by level</h2>
  <div class="sktabs">${skTabs}</div>
  ${skSetups}
  <p class="note" style="max-width:640px;margin-top:14px">Full loadout — every skill works unarmed (Quarterstaff, or no weapon restriction). Heralds &amp; curses reserve Spirit. Green % on the main attack = measured DPS gain per support.</p>
</section>
<section><h2>Alternative main skills — all Quarterstaff (work unarmed)</h2>
  <div class="sk-alts">${ALT_SKILLS.map((n) => { const i = skillInfoByName(n); const ele = i ? (i.skillTypes.find((t) => ["Fire", "Cold", "Lightning", "Physical"].includes(t)) || "") : ""; return `<div class="sk-alt">${gemIcons.get(n) ? `<img src="${gemIcons.get(n)}" alt="">` : '<span class="noic"></span>'}<div><b>${n}</b><span>${ele}${i ? " · Lv " + i.levelReq : ""}</span></div></div>`; }).join("")}</div>
</section>`;

const svg = renderTreeSvg(raw, {
  allocated,
  ascendancyName: "Martial Artist",
  width: 1600,
  svgId: "tree",
  emphasizeAllocated: true,
  frameOnAllocated: true,
  frameNodeIds,
  nodeColors,
  tooltipIds,
  nodeIcons,
  nodePhases,
  colors: { edgeAlloc: "#cdbb88" },
});

const skillRows = [
  ["Acts 1–3", "Any Monk strike that drops (Tempest Flurry / Ice Strike)", "Just clear"],
  ["~lvl 12+", "Rapid Assault or Staggering Palm", "Combo builder (Staggering adds stun)"],
  ["~lvl 40+", "+ Killing Palm / Blood Hunt", "Combo dump; go full unarmed via Hollow Palm"],
  ["Endgame", "Same skills, respec to crit", "Combo now multiplies your crits"],
];

const phaseLegend = PHASES.map((p) =>
  `<div class="pl"><span class="sw" style="background:${p.color}"></span><b>${p.range}</b><span>${p.note}</span></div>`
).join("") +
  `<div class="pl"><span class="sw" style="background:${ASC_COLOR}"></span><b>Ascendancy</b><span>Martial Artist nodes (separate subtree)</span></div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unarmed Crit Martial Artist — PoE2 0.5</title>
<style>
  :root{--bg:#0f1013;--fg:#e8e6e1;--dim:#8b8b93;--line:#26262e;--acc:#ff8a3d;--gold:#ffcf6e;--ok:#74c98a;--bad:#e0796b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,"Segoe UI",sans-serif}
  .wrap{max-width:1280px;margin:0 auto;padding:0 28px 90px}
  .hero{padding:34px 0 18px;border-bottom:1px solid var(--line);margin-bottom:24px}
  .hero h1{font-size:2.1rem;margin:0 0 4px}
  .hero .meta{color:var(--dim);font-size:.95rem} .hero .meta b{color:var(--gold)}
  .tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 0 10px;flex-wrap:wrap}
  .tabs button{background:none;border:none;border-bottom:2px solid transparent;color:var(--dim);padding:11px 18px;font-size:.92rem;cursor:pointer;font-weight:600;letter-spacing:.02em}
  .tabs button:hover{color:var(--fg)}
  .tabs button.active{color:var(--gold);border-bottom-color:var(--acc)}
  .panel.hidden{display:none}
  section{margin:32px 0}
  h2{font-size:.85rem;letter-spacing:.14em;text-transform:uppercase;color:var(--acc);margin:0 0 12px;font-weight:700}
  p{margin:.4rem 0}
  .tldr{display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:880px}
  .tldr ul{margin:.2rem 0;padding-left:1.1rem} .tldr li{margin:.2rem 0;font-size:.92rem}
  .tldr .h{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}
  .good::marker{color:var(--ok)} .warn::marker{color:var(--bad)}
  table{width:100%;max-width:880px;border-collapse:collapse}
  td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:.92rem;vertical-align:top}
  th{color:var(--dim);font-weight:600;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase}
  td:first-child{color:var(--gold);white-space:nowrap;width:1%}
  ol{margin:.3rem 0;padding-left:1.2rem;max-width:880px} ol li{margin:.3rem 0} ol b{color:var(--gold)}
  .note{color:var(--dim);font-size:.86rem} .lead{max-width:820px}
  .sk-hero{display:flex;gap:18px;align-items:flex-start;max-width:880px}
  .sk-iconlg{flex:none;width:88px;height:88px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#1a1a20}
  .sk-iconlg img{width:100%;height:100%;object-fit:cover}
  .sk-badges{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0}
  .sk-badges span{background:#1d1d24;border:1px solid var(--line);border-radius:5px;padding:.1rem .5rem;font-size:.76rem;color:var(--gold)}
  .sk-sups{display:flex;flex-wrap:wrap;gap:10px;max-width:880px}
  .sk-sups.dim{opacity:.62}
  .sk-sup{display:flex;align-items:center;gap:8px;background:#16161b;border:1px solid var(--line);border-radius:7px;padding:6px 11px;font-size:.9rem}
  .sk-sup img{width:30px;height:30px;border-radius:5px;flex:none} .sk-sup .noic{width:30px;height:30px;border-radius:5px;background:#2a2a33;flex:none}
  .sk-sup .pct{color:var(--ok);font-weight:700}
  .sk-alts{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;max-width:880px}
  .sk-alt{display:flex;align-items:center;gap:9px;background:#16161b;border:1px solid var(--line);border-radius:7px;padding:7px 10px}
  .sk-alt img{width:34px;height:34px;border-radius:5px;flex:none} .sk-alt .noic{width:34px;height:34px;border-radius:5px;background:#2a2a33;flex:none}
  .sk-alt b{display:block;font-size:.9rem} .sk-alt span{font-size:.78rem;color:var(--dim)}
  /* skill sub-tabs by level */
  .sktabs{display:flex;gap:2px;flex-wrap:wrap;margin:0 0 16px;border-bottom:1px solid var(--line)}
  .skbt{background:none;border:none;border-bottom:2px solid transparent;color:var(--dim);padding:8px 15px;font-size:.85rem;cursor:pointer;font-weight:600}
  .skbt:hover{color:var(--fg)} .skbt.active{color:var(--gold);border-bottom-color:var(--acc)}
  .gem-setup{display:flex;flex-direction:column;gap:12px}
  .gem-setup.hidden{display:none}
  .grp{background:#15151b;border:1px solid var(--line);border-radius:10px;padding:13px 18px;max-width:780px}
  .grp-role{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--acc);margin-bottom:10px;font-weight:700}
  /* gem sockets */
  .socket-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .support-sockets{display:flex;gap:12px;flex-wrap:wrap}
  .socket{width:82px;text-align:center;font-size:.72rem;color:var(--dim)}
  .socket img{width:56px;height:56px;border-radius:10px;border:1px solid #333;background:#101015;display:block;margin:0 auto 5px;object-fit:cover}
  .socket .noic{width:56px;height:56px;border-radius:10px;background:#2a2a33;display:block;margin:0 auto 5px}
  .socket.main{width:96px} .socket.main img,.socket.main .noic{width:72px;height:72px;border:2px solid var(--acc);box-shadow:0 0 14px rgba(255,138,61,.35)}
  .socket .so-nm{display:block;line-height:1.18;color:var(--fg);font-size:.78rem}
  .socket .so-sub{display:block;font-size:.68rem;color:var(--dim)}
  .socket .so-pct{display:block;color:var(--ok);font-weight:700;font-size:.72rem;margin-top:2px}
  .link-arrow{color:var(--dim);font-size:1.5rem;font-weight:300}
  .trick{border-left:2px solid var(--acc);padding:2px 0 2px 14px;margin:.4rem 0;max-width:820px}
  .trick code{color:var(--gold);font-size:.9em}
  /* tree */
  .treewrap{position:relative;border:1px solid var(--line);border-radius:8px;background:#08080a;overflow:hidden;height:82vh;min-height:560px}
  .treewrap svg{width:100%;height:100%;cursor:grab;display:block}
  .ctrls{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:3}
  .ctrls button{background:#1b1b22;color:var(--fg);border:1px solid var(--line);border-radius:6px;width:34px;height:34px;font-size:1rem;cursor:pointer;line-height:1}
  .ctrls button.wide{width:auto;padding:0 10px;font-size:.8rem}
  .ctrls button:hover{border-color:var(--acc);color:var(--gold)}
  .ctrls button.active{border-color:var(--acc);color:var(--gold);background:#2a1d10}
  .hint{position:absolute;left:12px;bottom:10px;color:var(--dim);font-size:.78rem;z-index:2;pointer-events:none}
  #tip{position:fixed;z-index:10;max-width:320px;background:#15151b;border:1px solid #3a3a44;border-radius:7px;
    padding:9px 11px;font-size:.86rem;pointer-events:none;opacity:0;transition:opacity .08s;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #tip .tn{color:var(--gold);font-weight:700;margin-bottom:3px}
  #tip .tt{color:var(--dim);font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
  #tip .ts{margin:2px 0;color:var(--fg)}
  .plegend{display:flex;flex-wrap:wrap;gap:10px 22px;margin:14px 0 0}
  .pl{display:flex;align-items:center;gap:7px;font-size:.86rem;color:var(--dim)}
  .pl b{color:var(--fg)} .pl .sw{width:13px;height:13px;border-radius:3px;display:inline-block;flex:none}
  footer{margin-top:42px;border-top:1px solid var(--line);padding-top:14px;color:var(--dim);font-size:.82rem}
  @media(max-width:680px){.tldr{grid-template-columns:1fr}}
</style></head>
<body><div class="wrap">

<div class="hero">
  <h1>Empty-Handed Assassin</h1>
  <div class="meta"><b>Monk · Martial Artist</b> &nbsp;•&nbsp; Crit-Physical Unarmed &nbsp;•&nbsp; League Start &nbsp;•&nbsp; PoE2 <b>0.5 Return of the Ancients</b></div>
</div>

<nav class="tabs">
  <button data-tab="overview" class="active">Overview</button>
  <button data-tab="skills">Skills</button>
  <button data-tab="tree">Passive Tree</button>
  <button data-tab="gear">Defense &amp; Gear</button>
</nav>

<div class="panel" data-panel="overview">
<section><div class="tldr">
  <div><div class="h">Strengths</div><ul>
    <li class="good">Weapon-independent — Hollow Palm makes your fists scale with gear</li>
    <li class="good">Forgiving Combo leveling, no crit gear needed early</li>
    <li class="good">Evasion + threshold defense — dodges the 0.5 ES-recovery nerf</li>
    <li class="good">Clear crit respec target to build toward</li>
  </ul></div>
  <div><div class="h">Watch out for</div><ul>
    <li class="warn">Crit needs gear; you level hit-based and respec in later</li>
    <li class="warn">Exact physical skill firms up with 0.5 gem data at launch</li>
    <li class="warn">Melee range — you're in the fight, not kiting</li>
  </ul></div>
</div></section>

<section><h2>Playstyle</h2>
<p class="lead">Punch with empty hands. Build Combo on every hit, dump it into a payoff strike. Level forgiving and hit-based, then respec into crit once gear supports it.</p></section>

<section><h2>The trick — Hollow Palm</h2>
<div class="trick"><p>Attack as a quarterstaff with both hands empty, plus:</p>
<p><code>+1% attack speed per 75 Evasion on armour</code> &nbsp;·&nbsp; <code>+0.1% crit chance per 10 Energy Shield on armour</code></p></div>
<p class="note">Your Evasion/ES hybrid gear <i>is</i> the crit + speed engine, and Martial Artistry's quarterstaff crit bonus applies to your fists. The 0.5 ES nerf hit recovery, not flat ES — so ES still pays off here as a pure crit stat.</p></section>

</div>
<div class="panel hidden" data-panel="skills">
${skillsHtml}

</div>
<div class="panel hidden" data-panel="tree">
<section><h2>Ascendancy order</h2><ol>
  <li><b>Way of the Stonefist</b> — Fists of Stone, ignore attribute reqs</li>
  <li><b>Martial Master</b> — Combo from all attack hits (the engine)</li>
  <li><b>Martial Adept</b> — extra Combo + ES recharge per Combo</li>
  <li><b>Way of the Mountain</b> — overwhelm layer <span class="note">(or Runic Meridians for Runic-Ward sockets)</span></li>
</ol></section>

<section><h2>Passive tree — pathing by level</h2>
<div class="treewrap">
  <div class="ctrls">
    <button id="zin" title="Zoom in">+</button>
    <button id="zout" title="Zoom out">−</button>
    ${PHASES.map((p, i) => `<button id="ph${i + 1}" class="wide ph" title="${p.note}">${p.range.replace("Lvl ", "")}</button>`).join("")}
  </div>
  ${svg}
  <div class="hint">click a level bracket to grow the tree · scroll = zoom · drag = pan · hover a node for its effect</div>
</div>
<div class="plegend">${phaseLegend}</div>
<p class="note" style="margin-top:12px">Connected path from the Monk start, coloured by when you allocate it. Hover any node — glowing path nodes <i>and</i> nearby notables/keystones — to read the actual effect. The crit (orange) phase replaces the early Combo-filler smalls on respec.${unreachable.length ? ` <br>Couldn't route: ${unreachable.join(", ")}.` : ""}</p>
</section>

</div>
<div class="panel hidden" data-panel="gear">
<section><h2>Defense</h2>
<p class="note">Your offensive ev/ES gear pulls triple duty — no reliance on nerfed ES recovery:</p>
<ul>
  <li><b>Strong Chin</b> → Stun Threshold from Evasion</li>
  <li><b>Eldritch Will</b> / <b>Icebreaker</b> → Ailment + Freeze Threshold from ES</li>
  <li><b>Afterimage</b> / <b>Escape Strategy</b> → huge Evasion in combat</li>
  <li><b>Runic Ward</b> (gear + Runic Meridians) → flat at-1-life buffer on top</li>
</ul></section>

<section><h2>Gear priorities</h2><ul>
  <li>Evasion/Energy-Shield <b>hybrid bases</b> every slot (feeds crit, speed, thresholds)</li>
  <li>Both weapon slots <b>empty</b> — that's the build</li>
  <li>Chase: flat ES + Evasion on armour, accuracy, attack speed → crit/multi at endgame</li>
  <li>Cap fire/cold/lightning res; chaos res helps with new content</li>
</ul></section>
</div>

<footer>Passive tree from GGG's official 0.5 export (final). Gem stats, DPS, and the exact best skill confirm when PoB ships 0.5 calc data (≈ launch + hours).</footer>
</div>

<div id="tip"></div>
<script>
var TIP=${JSON.stringify(tipData)};
(function(){
  var svg=document.getElementById('tree'); if(!svg)return;
  function vb(){return svg.getAttribute('viewBox').split(/\\s+/).map(Number);}
  function set(a){svg.setAttribute('viewBox',a.join(' '));}
  var init=vb(); var full=(svg.getAttribute('data-full-viewbox')||init.join(' ')).split(/\\s+/).map(Number);
  svg.addEventListener('wheel',function(e){e.preventDefault();var a=vb(),r=svg.getBoundingClientRect();
    var mx=a[0]+(e.clientX-r.left)/r.width*a[2],my=a[1]+(e.clientY-r.top)/r.height*a[3];
    var f=e.deltaY<0?0.84:1.19;a[2]*=f;a[3]*=f;a[0]=mx-(e.clientX-r.left)/r.width*a[2];a[1]=my-(e.clientY-r.top)/r.height*a[3];set(a);},{passive:false});
  var drag=false,lx,ly,moved=false;
  svg.addEventListener('mousedown',function(e){drag=true;moved=false;lx=e.clientX;ly=e.clientY;svg.style.cursor='grabbing';});
  window.addEventListener('mouseup',function(){drag=false;svg.style.cursor='grab';});
  window.addEventListener('mousemove',function(e){if(!drag)return;moved=true;var a=vb(),r=svg.getBoundingClientRect();
    a[0]-=(e.clientX-lx)/r.width*a[2];a[1]-=(e.clientY-ly)/r.height*a[3];lx=e.clientX;ly=e.clientY;set(a);});
  function z(f){var a=vb();var cx=a[0]+a[2]/2,cy=a[1]+a[3]/2;a[2]*=f;a[3]*=f;a[0]=cx-a[2]/2;a[1]=cy-a[3]/2;set(a);}
  document.getElementById('zin').onclick=function(){z(0.8);};
  document.getElementById('zout').onclick=function(){z(1.25);};
  // Phase stepping: show the tree cumulatively up to the chosen level bracket.
  var PHASE_VIEWS=${JSON.stringify(PHASE_VIEWS)};
  var phased=svg.querySelectorAll('[data-phase]');
  function showPhase(p){
    window.__cur=p;
    for(var i=0;i<phased.length;i++){var el=phased[i];el.style.display=(+el.getAttribute('data-phase')<=p)?'':'none';}
    var v=PHASE_VIEWS[p-1]; if(v) set([v.x,v.y,v.w,v.h]); else set(init.slice());
    for(var k=1;k<=${PHASES.length};k++){var b=document.getElementById('ph'+k); if(b) b.className='wide ph'+(k===p?' active':'');}
  }
  for(var k=1;k<=${PHASES.length};k++){(function(p){var b=document.getElementById('ph'+p); if(b) b.onclick=function(){showPhase(p);};})(k);}
  showPhase(${PHASES.length}); // default: full build
  // rich tooltip
  var tip=document.getElementById('tip');
  svg.addEventListener('mouseover',function(e){
    var t=e.target.getAttribute&&e.target.getAttribute('data-id'); if(!t||!TIP[t])return;
    var d=TIP[t];
    tip.innerHTML='<div class="tn">'+d.n+'</div><div class="tt">'+d.t.replace(/-/g,' ')+'</div>'+
      (d.s.length?d.s.map(function(x){return '<div class="ts">'+x+'</div>';}).join(''):'<div class="ts" style="color:#8b8b93">(no listed stats)</div>');
    tip.style.opacity='1';
  });
  svg.addEventListener('mousemove',function(e){
    if(tip.style.opacity!=='1')return;
    var x=e.clientX+16,y=e.clientY+16;
    if(x+330>window.innerWidth)x=e.clientX-330;
    if(y+200>window.innerHeight)y=e.clientY-200;
    tip.style.left=x+'px';tip.style.top=y+'px';
  });
  svg.addEventListener('mouseout',function(e){
    if(e.target.getAttribute&&e.target.getAttribute('data-id'))tip.style.opacity='0';
  });
  window.__reframeTree=function(){showPhase(window.__cur||${PHASES.length});};
})();
(function(){ // tab switching
  var tabs=document.querySelectorAll('.tabs button'), panels=document.querySelectorAll('.panel');
  function activate(name){
    for(var i=0;i<tabs.length;i++)tabs[i].classList.toggle('active',tabs[i].getAttribute('data-tab')===name);
    for(var j=0;j<panels.length;j++)panels[j].classList.toggle('hidden',panels[j].getAttribute('data-panel')!==name);
    if(name==='tree'&&window.__reframeTree)window.__reframeTree();
  }
  for(var i=0;i<tabs.length;i++)(function(t){t.onclick=function(){activate(t.getAttribute('data-tab'));};})(tabs[i]);
})();
(function(){ // skill level sub-tabs
  var bts=document.querySelectorAll('.skbt'), sets=document.querySelectorAll('.gem-setup');
  for(var i=0;i<bts.length;i++)(function(b){b.onclick=function(){
    var idx=b.getAttribute('data-skbt');
    for(var k=0;k<bts.length;k++)bts[k].classList.toggle('active',bts[k]===b);
    for(var k=0;k<sets.length;k++)sets[k].classList.toggle('hidden',sets[k].getAttribute('data-skset')!==idx);
  };})(bts[i]);
})();
</script>
</body></html>`;

const outDir = path.join(here, "..", "generated");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "martial-artist-leaguestart.html");
writeFileSync(outPath, html, "utf8");
console.log(`Wrote ${outPath}  (${(Buffer.byteLength(html) / 1024).toFixed(0)}KB)`);
console.log(`  path nodes: ${frameNodeIds.size} (main tree) + ${allocated.size - frameNodeIds.size} ascendancy`);
console.log(`  tooltip nodes: ${Object.keys(tipData).length}`);
console.log(`  node icons: ${nodeIcons.size}/${iconByNode.size} embedded (${uriByPath.size} unique fetched, ${iconMiss} missing)`);
console.log(`  reached landmarks: ${reachedLandmarks.length}/${PHASES.reduce((a, p) => a + p.targets.length, 0)}`);
if (unreachable.length) console.log(`  UNREACHABLE: ${unreachable.join(", ")}`);
