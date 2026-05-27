/**
 * Phase 4B smoke test.
 * pobb.in had blocked WebFetch (403) earlier but allowed Mozilla UA via PowerShell.
 * Our fetch sets a real UA so it should succeed.
 */
import { fetchBuild } from "../build/fetchBuild.js";
import { decodeBuildCode } from "../build/codec.js";
import { parseBuildXml } from "../build/build.js";

const cases = [
  // The pobb.in URL we already know works
  "https://pobb.in/ExX35hYNT6Gi",
  // Same with /raw suffix
  "https://pobb.in/ExX35hYNT6Gi/raw",
  // Without protocol
  "pobb.in/ExX35hYNT6Gi",
];

for (const url of cases) {
  console.log(`\n=== Fetching ${url} ===`);
  try {
    const r = await fetchBuild(url);
    console.log(`  host=${r.host}  buildCode length=${r.buildCode.length}`);
    const xml = decodeBuildCode(r.buildCode);
    const build = parseBuildXml(xml);
    console.log(`  → ${build.meta.className} / ${build.meta.ascendClassName}, level ${build.meta.level}`);
    console.log(`  → ${build.skills.length} skill groups, ${build.items.length} items`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

// Raw build code passthrough
console.log("\n=== Raw build code passthrough ===");
try {
  const r = await fetchBuild("eJyVUltPwjAUfudXnPR5OkBMeNggagIhESUZ6qMp2xGade1su0X-vae7IJj44Nu5fpfTRvOvQkKNxgqtYja6HjJAlepMqH3MXraLqymbzwbRhrvD88d9JaTvjGcDgKjJQGKNMmZjWkwlt_aJFxiztVY5A25TVNnDT3mlap2jYVBwoRKd5uiWRlclMbOwAd0aRB9QmJSYghNO0uIWrWPgqPnaax2-TzrKVRaz6QWbr4wYKJ2hpSgYBzfBJLjtOMKeJEpyIaXt-XwCku-8nzUJZGCldjF7Q15qBSN_Gr6TSODOVNi6uEudqLHZ9ZwtFqEtsQBFpr0Lr78oyQIsZGXMkYD9vFfZNfr62TU_Ky6FO7bJJXH4B8uj2B-cogeCDSp0hju6FCRVWWrjzkhPc2djp6l_SYjCxnl71v6aUfj7u3wDiT_D8Q==");
  console.log(`  host=${r.host}  buildCode length=${r.buildCode.length}`);
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
}

// Unsupported host
console.log("\n=== Unsupported host (should error gracefully) ===");
try {
  const r = await fetchBuild("https://example.com/build");
  console.log(`  unexpected success: ${JSON.stringify(r)}`);
} catch (e) {
  console.log(`  ✓ rejected: ${e.message}`);
}
