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
import { loadTree, findPathToNode } from "../build/treeData.js";
import { loadRawTree, renderTreeSvg } from "../build/treeSvg.js";

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
const reachedLandmarks = []; // {name, range, color}
let unreachable = [];

for (const ph of PHASES) {
  for (const tName of ph.targets) {
    const tn = byName(tName);
    if (!tn) { unreachable.push(tName + " (no node)"); continue; }
    const r = findPathToNode(forkPath, [...allocated], tn.id, { version: VERSION, maxHops: 90 });
    if (!r) { unreachable.push(tName + " (unreachable)"); continue; }
    for (const node of r.path) {
      if (!allocated.has(node.id)) { allocated.add(node.id); nodeColors.set(node.id, ph.color); }
    }
    reachedLandmarks.push({ name: tName, range: ph.range, color: ph.color, type: tn.type });
  }
}
// Frame on the main-tree path (exclude ascendancy, which we add next)
const frameNodeIds = new Set(allocated);

// Martial Artist ascendancy landmarks (separate subgraph; distinct colour)
const ASC_COLOR = "#c08bf0";
const ascNames = ["Way of the Stonefist", "Martial Master", "Martial Adept", "Way of the Mountain"];
for (const n of tree.all.filter((x) => x.ascendancyName === "Martial Artist")) {
  if (ascNames.includes(n.name)) { allocated.add(n.id); nodeColors.set(n.id, ASC_COLOR); }
}

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
  .trick{border-left:2px solid var(--acc);padding:2px 0 2px 14px;margin:.4rem 0;max-width:820px}
  .trick code{color:var(--gold);font-size:.9em}
  /* tree */
  .treewrap{position:relative;border:1px solid var(--line);border-radius:8px;background:#08080a;overflow:hidden;height:82vh;min-height:560px}
  .treewrap svg{width:100%;height:100%;cursor:grab;display:block}
  .ctrls{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:3}
  .ctrls button{background:#1b1b22;color:var(--fg);border:1px solid var(--line);border-radius:6px;width:34px;height:34px;font-size:1rem;cursor:pointer;line-height:1}
  .ctrls button.wide{width:auto;padding:0 10px;font-size:.8rem}
  .ctrls button:hover{border-color:var(--acc);color:var(--gold)}
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

<section><h2>Skills</h2>
<table><tr><th>When</th><th>Skill</th><th>Role</th></tr>
${skillRows.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join("")}</table>
<p class="note">Physical Monk strikes that work with Hollow Palm: Staggering Palm (stun), Rapid Assault, Killing Palm, Blood Hunt. Best pick confirms with 0.5 gem numbers.</p></section>

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
    <button id="zfit" class="wide" title="Frame the build">Build</button>
    <button id="zall" class="wide" title="Show whole tree">All</button>
  </div>
  ${svg}
  <div class="hint">scroll = zoom · drag = pan · hover a node for its full effect</div>
</div>
<div class="plegend">${phaseLegend}</div>
<p class="note" style="margin-top:12px">Connected path from the Monk start, coloured by when you allocate it. Hover any node — glowing path nodes <i>and</i> nearby notables/keystones — to read the actual effect. The crit (orange) phase replaces the early Combo-filler smalls on respec.${unreachable.length ? ` <br>Couldn't route: ${unreachable.join(", ")}.` : ""}</p>
</section>

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
  document.getElementById('zfit').onclick=function(){set(init.slice());};
  document.getElementById('zall').onclick=function(){set(full.slice());};
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
console.log(`  reached landmarks: ${reachedLandmarks.length}/${PHASES.reduce((a, p) => a + p.targets.length, 0)}`);
if (unreachable.length) console.log(`  UNREACHABLE: ${unreachable.join(", ")}`);
