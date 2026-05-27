/**
 * Phase 8L: scrape poe2db.tw for the canonical gem name → icon URL mapping.
 *
 * The heuristic in src/icons.ts (gameId tail → SkillGem<X>.webp) only hits
 * ~11% of gems. The actual icons live at different paths like
 * Art/2DArt/SkillIcons/<ClassPrefix><Name>.webp — irregular enough that we
 * can't predict them. So scrape once, persist, and the runtime consults
 * the static map first.
 *
 * Strategy:
 *   1. Fetch poe2db.tw/us/Gem (lists every gem with its <img src=...>).
 *   2. Parse out (gem_name, icon_url) pairs.
 *   3. Save to data/gem-icons.json.
 *
 * Run: node tools/scrape-gem-icons.mjs
 * (Idempotent — won't re-fetch if the JSON is recent.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, "..", "data", "gem-icons.json");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

async function fetchText(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
  return await res.text();
}

/**
 * Parse the gem listing page. The format we saw:
 *   <tr> ... <img src="https://web.poecdn.com/.../X.webp"> ... <a href=".../Y">Name</a> ... </tr>
 * but the actual HTML is unknown — we extract every (icon, name) we can.
 *
 * Heuristic: find every `<img src="...cdn.poe2db.tw/image/...">` and pair it
 * with the nearest following text that looks like a gem name.
 */
function parseGemEntries(html) {
  const out = new Map();

  // Strategy: walk every cdn.poe2db.tw img tag. For each, look forward for a
  // gem-name anchor or text. PoE2DB tables typically have:
  //   <td><img src="..icon.webp"></td><td><a href="/us/Gem_Name">Gem Name</a></td>
  // so the anchor immediately after the img is the gem name.
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']*cdn\.poe2db\.tw[^"']+\.webp)["'][^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html))) {
    const iconUrl = m[1];
    // Look at the next ~500 chars for an anchor
    const slice = html.slice(m.index, m.index + 1500);
    const anchorMatch =
      /<a\b[^>]*>([^<]+?)<\/a>/i.exec(slice) ||
      /<span\b[^>]*>([^<]+?)<\/span>/i.exec(slice);
    if (!anchorMatch) continue;
    const name = anchorMatch[1].trim();
    if (!name || name.length > 60) continue;
    // Reject obvious non-gem entries
    if (/^[0-9.,%+\-]+$/.test(name)) continue;
    if (out.has(name)) continue; // first wins
    out.set(name, iconUrl);
  }
  return out;
}

const now = Date.now();
if (existsSync(outFile)) {
  const ageMs = now - statSync(outFile).mtimeMs;
  if (ageMs < 24 * 60 * 60 * 1000) {
    const existing = JSON.parse(readFileSync(outFile, "utf8"));
    console.log(`Existing map: ${Object.keys(existing.icons).length} gems, ${(ageMs / 1000 / 60).toFixed(0)} min old. Skipping refetch (delete the file to force).`);
    process.exit(0);
  }
}

console.log("Fetching https://poe2db.tw/us/Gem ...");
const html = await fetchText("https://poe2db.tw/us/Gem");
console.log(`Got ${html.length} chars`);

const entries = parseGemEntries(html);
console.log(`Parsed ${entries.size} (name → icon) pairs`);

// Normalize: store relative path. Filter to gem-skill icon paths only —
// page also includes atlas/UI icons under Art/2DArt/UIImages/ etc. which
// aren't gems.
const icons = {};
for (const [name, url] of entries) {
  const m = /cdn\.poe2db\.tw\/image\/(.+)$/.exec(url);
  if (!m) continue;
  const p = m[1];
  if (!/^Art\/2DArt\/SkillIcons\//i.test(p)) continue;
  icons[name] = p;
}

// Sample for sanity
const sample = Object.entries(icons).slice(0, 8);
console.log("Sample entries:");
for (const [n, p] of sample) console.log(`  ${n}: ${p}`);

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({ generatedAt: new Date().toISOString(), source: "https://poe2db.tw/us/Gem", icons }, null, 2),
);
console.log(`Wrote ${outFile}  (${Object.keys(icons).length} gems)`);
