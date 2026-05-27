/**
 * Phase 8L audit: for every gem in our DB, compute the URL our heuristic
 * produces, then HEAD-check it on poe2db's CDN. Tally hit/miss.
 *
 * The sample is too big (~900 gems) to brute-force without rate-limiting.
 * Cap at 80 gems per run; report hit rate.
 */
import { loadGems } from "../build/gemData.js";
import { gemIconRef } from "../build/icons.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const cached = loadGems(forkPath);

// Sample evenly across the gem list to get an honest distribution
const SAMPLE = 80;
const stride = Math.max(1, Math.floor(cached.all.length / SAMPLE));
const sample = [];
for (let i = 0; i < cached.all.length && sample.length < SAMPLE; i += stride) {
  sample.push(cached.all[i]);
}
console.log(`Sampling ${sample.length} of ${cached.all.length} gems (every ${stride}th)`);

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  Referer: "https://poe2db.tw/",
};

async function headCheck(url) {
  try {
    const res = await fetch(url, { method: "HEAD", headers: BROWSER_HEADERS });
    return res.status;
  } catch (e) {
    return 0;
  }
}

let hits = 0, misses = 0, errors = 0;
const missList = [];
let n = 0;
for (const gem of sample) {
  n++;
  const ref = gemIconRef(gem);
  if (!ref) {
    errors++;
    console.log(`  ${n}/${sample.length} ${gem.name}: no IconRef (${errors})`);
    continue;
  }
  const status = await headCheck(ref.src);
  if (status === 200) {
    hits++;
  } else {
    misses++;
    missList.push({ name: gem.name, gameId: gem.gameId, status, url: ref.src });
  }
  if (n % 10 === 0) process.stdout.write(`  ${n}/${sample.length}  hits=${hits}/${n - errors} (${((hits / Math.max(1, n - errors)) * 100).toFixed(1)}%)\n`);
}

console.log(`\nFinal: ${hits} hits, ${misses} misses, ${errors} errors out of ${sample.length}`);
console.log(`Hit rate: ${((hits / sample.length) * 100).toFixed(1)}%`);
console.log(`\nFirst 20 misses:`);
for (const m of missList.slice(0, 20)) {
  console.log(`  ${m.status} ${m.name}  gameId=${m.gameId}  url=${m.url.replace("https://cdn.poe2db.tw", "")}`);
}
