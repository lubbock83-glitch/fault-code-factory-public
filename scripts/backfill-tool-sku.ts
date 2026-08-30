/**
 * Assign a recommended tool to articles that have none.
 *
 * Needed because the writer originally had no knowledge that a product
 * catalogue existed, so every article it produced left recommended_tool_sku
 * null. The approval CHECK constraint requires that field, which meant those
 * articles could be generated but never approved - the constraint doing exactly
 * its job, and catching the gap before anything reached the public site.
 *
 * The writer has since been given the catalogue, so new articles set it
 * directly. This exists to repair the ones written before that, without paying
 * to regenerate a good article over one missing field.
 *
 * Usage: npx tsx scripts/backfill-tool-sku.ts [--apply]
 * Without --apply it reports the choices and writes nothing.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match?.[1] && !process.env[match[1]]) process.env[match[1]] = (match[2] ?? "").trim();
}

const { supabase } = await import("../src/lib/supabase.js");
const { runAgent, extractJson } = await import("../src/lib/anthropic.js");
const { loadToolCatalogue } = await import("../src/lib/webflow.js");
const { COLLECTIONS } = await import("../src/lib/env.js");

const apply = process.argv.includes("--apply");
const db = supabase();

const SYSTEM = `You match a diagnostic fault code article to the one tool a
technician needs to diagnose and clear that fault.

Judge on capability, not price:

- If clearing the fault requires bi-directional control - a forced regeneration,
  an injector cutout, a component actuation, parameter programming - then a
  read-and-clear code reader cannot finish the job and must not be chosen.
- If the fault only needs codes read and cleared, choosing the most expensive
  tablet is overselling. A technician who notices stops trusting the page.
- If the fault is on a trailer or on off-highway equipment, the connector
  adapter may matter more than the tablet.

Return ONLY JSON: {"sku": "EXACT-SKU", "reason": "one sentence"}

The SKU must be copied verbatim from the catalogue.`;

const catalogue = await loadToolCatalogue(COLLECTIONS.hardware);

const { data, error } = await db
  .from("fault_code_articles")
  .select("id, spn_code, fmi_code, engine_platform, title, meta_description, content_markdown")
  .is("recommended_tool_sku", null);

if (error) throw new Error(error.message);

const articles = (data ?? []) as Array<{
  id: string;
  spn_code: number;
  fmi_code: number;
  engine_platform: string;
  title: string;
  meta_description: string | null;
  content_markdown: string | null;
}>;

console.log(
  `\n${articles.length} article(s) missing a tool recommendation.` +
    `${apply ? "" : "  (dry run - pass --apply to write)"}\n`,
);

let cost = 0;

for (const article of articles) {
  process.stdout.write(`  SPN ${article.spn_code} FMI ${article.fmi_code}  `);

  try {
    const result = await runAgent({
      agent: "writer",
      system: SYSTEM,
      // Only the sections that bear on tool choice are sent. The full article
      // would multiply the cost of a decision that turns on one question:
      // does closing this fault require commanding the vehicle, or only
      // reading it.
      prompt: `## Article

Title: ${article.title}
Platform: ${article.engine_platform}
Summary: ${article.meta_description ?? "(none)"}

${(article.content_markdown ?? "").slice(0, 3500)}

## Catalogue

${catalogue
  .map(
    (tool) =>
      `- SKU: ${tool.sku}\n  Name: ${tool.name}\n  Bi-directional: ${
        tool.capabilities || "none - read and clear only"
      }`,
  )
  .join("\n\n")}

Return the JSON.`,
      maxTokens: 1500,
      effort: "low",
    });

    cost += result.costUsd;
    const choice = extractJson<{ sku?: string; reason?: string }>(result.text);

    // Validated against the catalogue. An invented SKU would sync to Webflow as
    // an empty reference field - a silently missing link, not a visible error.
    if (!choice.sku || !catalogue.some((tool) => tool.sku === choice.sku)) {
      console.log(`no valid SKU returned (${choice.sku ?? "none"}) - left null`);
      continue;
    }

    if (apply) {
      const { error: updateError } = await db
        .from("fault_code_articles")
        .update({ recommended_tool_sku: choice.sku })
        .eq("id", article.id);
      if (updateError) {
        console.log(`WRITE FAILED - ${updateError.message}`);
        continue;
      }
    }

    console.log(`${choice.sku}\n      ${choice.reason ?? ""}`);
  } catch (err) {
    console.log(`FAILED - ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nSpend: $${cost.toFixed(3)}${apply ? "" : "  (nothing written)"}\n`);
