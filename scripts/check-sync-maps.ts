/**
 * Verify the sync's reference resolution against live Webflow data.
 *
 * These two maps are the part of the sync most likely to be silently wrong.
 * If a SKU or a tag fails to resolve, the sync still succeeds - it just writes
 * an item with an empty reference field, which looks fine in the API response
 * and shows up as a missing cross-sell link on the published page days later.
 *
 * Checking them separately, before any write, turns that into a visible
 * failure. Read-only: this never writes to Webflow or Supabase.
 *
 * Usage: npx tsx scripts/check-sync-maps.ts
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match?.[1] && !process.env[match[1]]) process.env[match[1]] = (match[2] ?? "").trim();
}

const { COLLECTIONS } = await import("../src/lib/env.js");
const { webflowClient } = await import("../src/lib/webflow.js");
const { supabase } = await import("../src/lib/supabase.js");

const wf = webflowClient();
const db = supabase();

console.log("\nSync reference maps\n");

// ---- Hardware: SKU -> Webflow item id --------------------------------------
const hardware = await wf.collections.items.listItems(COLLECTIONS.hardware, { limit: 100 });
const skuMap = new Map<string, string>();
for (const item of hardware.items ?? []) {
  const sku = (item.fieldData as { "unique-sku"?: string } | undefined)?.["unique-sku"];
  if (sku && item.id) skuMap.set(sku, item.id);
}
console.log(`  Hardware SKUs resolvable: ${skuMap.size}`);
for (const sku of skuMap.keys()) console.log(`    ${sku}`);

// ---- Taxonomy: lower-cased name -> Webflow item id -------------------------
const taxonomy = await wf.collections.items.listItems(COLLECTIONS.taxonomy, { limit: 100 });
const tagMap = new Map<string, string>();
for (const item of taxonomy.items ?? []) {
  const name = (item.fieldData as { name?: string } | undefined)?.name;
  if (name && item.id) tagMap.set(name.trim().toLowerCase(), item.id);
}
console.log(`\n  Taxonomy terms resolvable: ${tagMap.size}`);
for (const name of tagMap.keys()) console.log(`    ${name}`);

// ---- What the generated articles are actually asking for -------------------
const { data } = await db
  .from("fault_code_articles")
  .select("spn_code, fmi_code, taxonomy_tags, recommended_tool_sku");

const rows = (data ?? []) as Array<{
  spn_code: number;
  fmi_code: number;
  taxonomy_tags: string[];
  recommended_tool_sku: string | null;
}>;

const unmatchedTags = new Map<string, number>();
const unmatchedSkus = new Set<string>();
let matchedTags = 0;

for (const row of rows) {
  for (const tag of row.taxonomy_tags ?? []) {
    if (tagMap.has(tag.trim().toLowerCase())) matchedTags++;
    else unmatchedTags.set(tag, (unmatchedTags.get(tag) ?? 0) + 1);
  }
  if (row.recommended_tool_sku && !skuMap.has(row.recommended_tool_sku)) {
    unmatchedSkus.add(row.recommended_tool_sku);
  }
}

console.log(`\n  Articles: ${rows.length}`);
console.log(`  Tags matched: ${matchedTags}`);
console.log(`  Tags unmatched: ${unmatchedTags.size} distinct`);

if (unmatchedTags.size > 0) {
  // Not an error. The writer emits human phrasing and the taxonomy has three
  // terms; these are the terms worth creating, ranked by how often the writer
  // reached for them. Creating them is a deliberate act - each one spends a
  // CMS item from a hard-capped, paid allowance.
  console.log("\n  Unmatched tags, by frequency - candidates for new taxonomy terms:");
  for (const [tag, count] of [...unmatchedTags.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(3)}x  ${tag}`);
  }
}

if (unmatchedSkus.size > 0) {
  console.log("\n  Unmatched tool SKUs (these WOULD sync with an empty hardware reference):");
  for (const sku of unmatchedSkus) console.log(`    ${sku}`);
}

console.log();
