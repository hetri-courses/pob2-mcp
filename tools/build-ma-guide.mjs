/**
 * Unarmed Crit Martial Artist — PoE2 0.5 league-start guide (HTML).
 * Maxroll-style: scannable, structured, minimal prose. Interactive pan/zoom
 * passive tree (GGG 0.5 export) framed on the build with glowing landmarks.
 *
 * Run: POB_TREE_VERSION=0_5 node tools/build-ma-guide.mjs
 * Out: generated/martial-artist-leaguestart.html
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTree } from "../build/treeData.js";
import { loadRawTree, renderTreeSvg } from "../build/treeSvg.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const VERSION = "0_5";

const tree = loadTree(forkPath, VERSION);
const raw = loadRawTree(forkPath, VERSION);

// Landmark nodes grouped for the legend.
const GROUPS = {
  Offense: {
    "Martial Artistry": "Quarterstaff crit damage + accuracy — applies to fists via Hollow Palm",
    "Critical Exploit": "+25% crit chance",
    "Calculated Hunter": "+50% crit chance",
    "Overwhelming Strike": "Crit chance + crit damage for attacks",
    "Locked On": "Crit chance + accuracy",
    "Heartbreaking": "Crit damage + Strength",
    "Sundering": "Crit damage for attack damage",
    "Leaping Ambush": "+50% crit vs full-life enemies (mapping)",
    "Chakra of Impact": "Up to +40% more damage from spent Combo",
    "Chakra of Rhythm": "Combo build + attack speed",
  },
  Defense: {
    "Strong Chin": "Stun Threshold from Evasion",
    "Eldritch Will": "Ailment Threshold from max ES",
    "Icebreaker": "Freeze Threshold from max ES",
    "Afterimage": "+60% Evasion after a hit",
    "Escape Strategy": "+100% Evasion when hit recently",
  },
  Keystone: {
    "Hollow Palm Technique": "Attack as a quarterstaff unarmed; ES→crit, Evasion→atk speed",
  },
};

const allocated = new Set();
const mainTreeLandmarks = new Set(); // for framing (excludes off-corner ascendancy)
const legend = {};
for (const [grp, nodes] of Object.entries(GROUPS)) {
  legend[grp] = [];
  for (const [name, why] of Object.entries(nodes)) {
    const node = tree.all.find((n) => n.name === name);
    if (node) { allocated.add(node.id); mainTreeLandmarks.add(node.id); legend[grp].push({ name, why }); }
  }
}
// Martial Artist ascendancy landmarks
const ascNames = ["Way of the Stonefist", "Martial Master", "Martial Adept", "Way of the Mountain"];
legend.Ascendancy = [];
for (const n of tree.all.filter((n) => n.ascendancyName === "Martial Artist")) {
  if (ascNames.includes(n.name)) { allocated.add(n.id); legend.Ascendancy.push({ name: n.name, why: "" }); }
}

const svg = renderTreeSvg(raw, {
  allocated,
  ascendancyName: "Martial Artist",
  width: 1300,
  svgId: "tree",
  emphasizeAllocated: true,
  frameOnAllocated: true,
  frameNodeIds: mainTreeLandmarks,
  colors: { normalAlloc: "#ffcf6e", notableAlloc: "#ffb441", keystoneAlloc: "#ff6a3d" },
});

const skillRows = [
  ["Acts 1–3", "Any Monk strike that drops (Tempest Flurry / Ice Strike)", "Just clear"],
  ["~lvl 12+", "Rapid Assault or Staggering Palm", "Combo builder (Staggering adds stun)"],
  ["~lvl 40+", "+ Killing Palm / Blood Hunt", "Combo dump; go full unarmed via Hollow Palm"],
  ["Endgame", "Same skills, respec to crit", "Combo now multiplies your crits"],
];

const legendBlock = Object.entries(legend).map(([grp, items]) => items.length ? `
  <div class="lg">
    <h4>${grp}</h4>
    ${items.map((i) => `<div class="ln"><b>${i.name}</b>${i.why ? `<span>${i.why}</span>` : ""}</div>`).join("")}
  </div>` : "").join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unarmed Crit Martial Artist — PoE2 0.5</title>
<style>
  :root{--bg:#0f1013;--fg:#e8e6e1;--dim:#8b8b93;--line:#26262e;--acc:#ff8a3d;--gold:#ffcf6e;--ok:#74c98a;--bad:#e0796b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,"Segoe UI",sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:0 20px 80px}
  a{color:var(--gold)}
  /* hero */
  .hero{padding:34px 0 18px;border-bottom:1px solid var(--line);margin-bottom:24px}
  .hero h1{font-size:2rem;margin:0 0 4px;letter-spacing:.3px}
  .hero .meta{color:var(--dim);font-size:.95rem}
  .hero .meta b{color:var(--gold)}
  /* sections */
  section{margin:30px 0}
  h2{font-size:.85rem;letter-spacing:.14em;text-transform:uppercase;color:var(--acc);margin:0 0 12px;font-weight:700}
  h3{font-size:1.02rem;margin:.2rem 0}
  p{margin:.4rem 0}
  /* tldr */
  .tldr{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .tldr ul{margin:.2rem 0;padding-left:1.1rem}
  .tldr li{margin:.2rem 0;font-size:.92rem}
  .tldr .h{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}
  .good::marker{color:var(--ok)} .warn::marker{color:var(--bad)}
  /* table */
  table{width:100%;border-collapse:collapse}
  td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:.92rem;vertical-align:top}
  th{color:var(--dim);font-weight:600;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase}
  td:first-child{color:var(--gold);white-space:nowrap;width:1%}
  ol{margin:.3rem 0;padding-left:1.2rem} ol li{margin:.3rem 0}
  ol b{color:var(--gold)}
  .lead{color:var(--fg)} .note{color:var(--dim);font-size:.86rem}
  .trick{border-left:2px solid var(--acc);padding:2px 0 2px 14px;margin:.4rem 0}
  .trick code{color:var(--gold);font-size:.9em}
  .phase{margin:.5rem 0} .phase b{color:var(--gold)}
  /* tree */
  .treewrap{position:relative;border:1px solid var(--line);border-radius:8px;background:#08080a;overflow:hidden;height:74vh;min-height:520px}
  .treewrap svg{width:100%;height:100%;cursor:grab}
  .ctrls{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:2}
  .ctrls button{background:#1b1b22;color:var(--fg);border:1px solid var(--line);border-radius:6px;
    width:34px;height:34px;font-size:1rem;cursor:pointer;line-height:1}
  .ctrls button.wide{width:auto;padding:0 10px;font-size:.8rem}
  .ctrls button:hover{border-color:var(--acc);color:var(--gold)}
  .hint{position:absolute;left:12px;bottom:10px;color:var(--dim);font-size:.78rem;z-index:2;pointer-events:none}
  /* legend */
  .legend{display:grid;grid-template-columns:1fr 1fr;gap:18px 28px;margin-top:18px}
  .lg h4{margin:0 0 6px;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--acc)}
  .ln{font-size:.88rem;margin:3px 0;color:var(--dim)}
  .ln b{color:var(--fg);font-weight:600} .ln span{margin-left:6px}
  footer{margin-top:40px;border-top:1px solid var(--line);padding-top:14px;color:var(--dim);font-size:.82rem}
  @media(max-width:640px){.tldr,.legend{grid-template-columns:1fr}}
</style></head>
<body><div class="wrap">

<div class="hero">
  <h1>Empty-Handed Assassin</h1>
  <div class="meta"><b>Monk · Martial Artist</b> &nbsp;•&nbsp; Crit-Physical Unarmed &nbsp;•&nbsp; League Start &nbsp;•&nbsp; PoE2 <b>0.5 Return of the Ancients</b></div>
</div>

<section>
  <div class="tldr">
    <div><div class="h">Strengths</div><ul>
      <li class="good">Weapon-independent — Hollow Palm = your fists scale with gear, no weapon hunt</li>
      <li class="good">Forgiving Combo leveling, no crit gear needed early</li>
      <li class="good">Evasion + threshold defense — dodges the 0.5 ES-recovery nerf</li>
      <li class="good">Clear crit respec target to build toward</li>
    </ul></div>
    <div><div class="h">Watch out for</div><ul>
      <li class="warn">Crit needs gear investment — leveling is hit-based, you respec in later</li>
      <li class="warn">Physical Monk skill choice firms up with 0.5 gem data at launch</li>
      <li class="warn">Melee range — you're in the fight, not kiting</li>
    </ul></div>
  </div>
</section>

<section>
  <h2>Playstyle</h2>
  <p class="lead">Punch with empty hands. Build Combo on every hit, dump it into a payoff strike. Level hit-based and forgiving, then respec into crit once gear supports it for a fast, crunchy fist-fighter.</p>
</section>

<section>
  <h2>The trick — Hollow Palm</h2>
  <div class="trick">
    <p>Attack as a quarterstaff with both hands empty, plus:</p>
    <p><code>+1% attack speed per 75 Evasion on armour</code> &nbsp;·&nbsp; <code>+0.1% crit chance per 10 Energy Shield on armour</code></p>
  </div>
  <p class="note">Your Evasion/ES hybrid gear <i>is</i> the crit + speed engine. And "attack as a quarterstaff" means <b>Martial Artistry</b>'s quarterstaff crit bonus applies to your fists. The 0.5 ES nerf hit <i>recovery</i>, not flat ES — so ES still pays off here as a pure crit stat.</p>
</section>

<section>
  <h2>Skills</h2>
  <table><tr><th>When</th><th>Skill</th><th>Role</th></tr>
  ${skillRows.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join("")}
  </table>
  <p class="note">Physical Monk strikes that work with Hollow Palm: Staggering Palm (stun), Rapid Assault, Killing Palm, Blood Hunt. Exact best pick confirms with 0.5 gem numbers — and one of the 21 new Kalguuran physical skills may win out.</p>
</section>

<section>
  <h2>Ascendancy order</h2>
  <ol>
    <li><b>Way of the Stonefist</b> — Fists of Stone, ignore attribute reqs (unarmed core)</li>
    <li><b>Martial Master</b> — Combo from all attack hits (the engine)</li>
    <li><b>Martial Adept</b> — extra Combo + ES recharge per Combo</li>
    <li><b>Way of the Mountain</b> — overwhelm layer <span class="note">(or Runic Meridians for 5 Runic-Ward rune sockets)</span></li>
  </ol>
</section>

<section>
  <h2>Passive tree</h2>
  <div class="treewrap">
    <div class="ctrls">
      <button id="zin" title="Zoom in">+</button>
      <button id="zout" title="Zoom out">−</button>
      <button id="zfit" class="wide" title="Frame the build">Build</button>
      <button id="zall" class="wide" title="Show whole tree">All</button>
    </div>
    ${svg}
    <div class="hint">scroll to zoom · drag to pan · hover a glowing node for its name</div>
  </div>
  <div class="legend">${legendBlock}</div>
  <p class="note" style="margin-top:14px">Glowing nodes = build landmarks on the real 0.5 tree. This is a target map; the optimized point-by-point path comes once PoB's 0.5 calc data lets us validate DPS per point.</p>
</section>

<section>
  <h2>Tree progression</h2>
  <div class="phase"><b>Leveling (1–40):</b> Combo + survival. Chakra of Rhythm/Impact, Combo smalls, life/evasion travel. No crit yet.</div>
  <div class="phase"><b>Pivot (40–70):</b> Path to Hollow Palm, drop your weapon, wear Evasion/ES hybrid bases. Grab Martial Artistry.</div>
  <div class="phase"><b>Endgame (70+):</b> Respec Combo-filler smalls into the crit cluster. Keep Chakra of Impact.</div>
</section>

<section>
  <h2>Defense</h2>
  <p class="note">Your offensive ev/ES gear pulls triple duty — no reliance on nerfed ES recovery:</p>
  <ul>
    <li><b>Strong Chin</b> → Stun Threshold from Evasion</li>
    <li><b>Eldritch Will</b> / <b>Icebreaker</b> → Ailment + Freeze Threshold from ES</li>
    <li><b>Afterimage</b> / <b>Escape Strategy</b> → huge Evasion in combat</li>
    <li><b>Runic Ward</b> (gear + Runic Meridians) → flat at-1-life buffer on top</li>
  </ul>
</section>

<section>
  <h2>Gear priorities</h2>
  <ul>
    <li>Evasion/Energy-Shield <b>hybrid bases</b> every slot (feeds crit, speed, thresholds)</li>
    <li>Both weapon slots <b>empty</b> — that's the build</li>
    <li>Chase: flat ES + Evasion on armour, accuracy, attack speed → crit/multi at endgame</li>
    <li>Cap fire/cold/lightning res; chaos res helps with new content</li>
  </ul>
</section>

<footer>
Passive tree from GGG's official 0.5 export (final). Gem stats, DPS, and the exact best skill confirm when PoB ships 0.5 calc data (≈ launch + hours).
</footer>

</div>

<script>
(function(){
  var svg=document.getElementById('tree'); if(!svg)return;
  function vb(){return svg.getAttribute('viewBox').split(/\\s+/).map(Number);}
  function set(a){svg.setAttribute('viewBox',a.join(' '));}
  var init=vb(); var full=(svg.getAttribute('data-full-viewbox')||init.join(' ')).split(/\\s+/).map(Number);
  svg.addEventListener('wheel',function(e){
    e.preventDefault(); var a=vb(), r=svg.getBoundingClientRect();
    var mx=a[0]+(e.clientX-r.left)/r.width*a[2], my=a[1]+(e.clientY-r.top)/r.height*a[3];
    var f=e.deltaY<0?0.84:1.19; a[2]*=f; a[3]*=f;
    a[0]=mx-(e.clientX-r.left)/r.width*a[2]; a[1]=my-(e.clientY-r.top)/r.height*a[3]; set(a);
  },{passive:false});
  var drag=false,lx,ly;
  svg.addEventListener('mousedown',function(e){drag=true;lx=e.clientX;ly=e.clientY;svg.style.cursor='grabbing';});
  window.addEventListener('mouseup',function(){drag=false;svg.style.cursor='grab';});
  window.addEventListener('mousemove',function(e){
    if(!drag)return; var a=vb(), r=svg.getBoundingClientRect();
    a[0]-=(e.clientX-lx)/r.width*a[2]; a[1]-=(e.clientY-ly)/r.height*a[3];
    lx=e.clientX;ly=e.clientY; set(a);
  });
  function z(f){var a=vb();var cx=a[0]+a[2]/2,cy=a[1]+a[3]/2;a[2]*=f;a[3]*=f;a[0]=cx-a[2]/2;a[1]=cy-a[3]/2;set(a);}
  document.getElementById('zin').onclick=function(){z(0.8);};
  document.getElementById('zout').onclick=function(){z(1.25);};
  document.getElementById('zfit').onclick=function(){set(init.slice());};
  document.getElementById('zall').onclick=function(){set(full.slice());};
})();
</script>
</body></html>`;

const outDir = path.join(here, "..", "generated");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "martial-artist-leaguestart.html");
writeFileSync(outPath, html, "utf8");
console.log(`Wrote ${outPath}  (${(Buffer.byteLength(html) / 1024).toFixed(0)}KB)`);
console.log(`  landmarks highlighted: ${allocated.size}`);
