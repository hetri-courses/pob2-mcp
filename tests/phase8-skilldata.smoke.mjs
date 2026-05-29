/** Verify we can accurately extract level req + weapon type per skill from PoB skill data. */
import { readFileSync } from "node:fs";
import { loadGems } from "../build/gemData.js";

const dir = "D:/pob2-mcp/pob2-fork/src/Data/Skills/";
const blob = ["act_dex.lua", "act_int.lua", "act_str.lua", "other.lua", "minion.lua"]
  .map((f) => { try { return readFileSync(dir + f, "utf8"); } catch { return ""; } })
  .join("\n");

function skillBlock(grantedId) {
  const start = blob.indexOf(`skills["${grantedId}"] = {`);
  if (start < 0) return null;
  // walk braces to find matching close
  let i = blob.indexOf("{", start), depth = 0;
  for (let j = i; j < blob.length; j++) {
    if (blob[j] === "{") depth++;
    else if (blob[j] === "}") { depth--; if (depth === 0) return blob.slice(i, j + 1); }
  }
  return null;
}

const g = loadGems("D:/pob2-mcp/pob2-fork/src");
const cands = ["Tempest Flurry", "Ice Strike", "Killing Palm", "Staggering Palm",
  "Rapid Assault", "Blood Hunt", "Falling Thunder", "Glacial Cascade", "Charged Staff"];

console.log("skill              QS?  weaponTypes        L1req  midReq");
for (const name of cands) {
  const gem = g.all.find((x) => x.name === name);
  if (!gem) { console.log(`  ${name}: not in gem DB`); continue; }
  const body = skillBlock(gem.grantedEffectId);
  if (!body) { console.log(`  ${name} (${gem.grantedEffectId}): not in skill data`); continue; }
  const wt = (body.match(/weaponTypes\s*=\s*\{([^}]*)\}/) || [])[1] || "";
  const weapons = (wt.match(/\["([^"]+)"\]/g) || []).map((s) => s.replace(/[[\]"]/g, "")).join(",") || "(any)";
  const qs = /QuarterstaffSkill/.test(body) ? "QS " : "   ";
  const reqs = [...body.matchAll(/levelRequirement\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  const l1 = reqs[0] ?? "?";
  const mid = reqs[10] ?? reqs[reqs.length - 1] ?? "?"; // ~gem level 11
  console.log(`  ${name.padEnd(17)} ${qs}  ${weapons.padEnd(16)}  ${String(l1).padEnd(5)}  ${mid}`);
}
