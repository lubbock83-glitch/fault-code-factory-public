/**
 * Run the pipeline locally, without Trigger.dev.
 *
 * The Trigger tasks are thin wrappers around the agent functions - they add
 * queueing, retries and observability, none of which matter when the question
 * is "do the prompts work and what does an article cost". This harness answers
 * that in one command against the real database, and it is also what you reach
 * for when iterating on a prompt, because the edit-run loop is seconds rather
 * than a redeploy.
 *
 * Usage:
 *   npx tsx scripts/run-local.ts research 4      research the top 4 unprocessed codes
 *   npx tsx scripts/run-local.ts generate 4      write articles for 4 researched codes
 *   npx tsx scripts/run-local.ts both 4          research then generate
 */
import { readFileSync } from "node:fs";

// Loaded before any pipeline module, because those read process.env at import.
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match?.[1] && !process.env[match[1]]) process.env[match[1]] = (match[2] ?? "").trim();
}

const { supabase } = await import("../src/lib/supabase.js");
const { research } = await import("../src/lib/agents/researcher.js");
const { write } = await import("../src/lib/agents/writer.js");
const { edit } = await import("../src/lib/agents/editor.js");
const { audit } = await import("../src/lib/agents/auditor.js");
const { buildJsonLd } = await import("../src/lib/jsonld.js");
const { loadToolCatalogue } = await import("../src/lib/webflow.js");
const { COLLECTIONS } = await import("../src/lib/env.js");

type RegistryRow = Awaited<ReturnType<typeof loadRegistry>>[number];

const mode = process.argv[2] ?? "both";
const limit = Number(process.argv[3] ?? 4);
const db = supabase();

let totalCost = 0;

function label(code: { spn_code: number; fmi_code: number; engine_platform: string }) {
  return `SPN ${code.spn_code} FMI ${code.fmi_code} (${code.engine_platform})`;
}

async function loadRegistry(onlyUnprocessed: boolean) {
  const query = db
    .from("fault_code_registry")
    .select("*")
    .order("demand_rank", { ascending: false })
    .limit(limit);

  const { data, error } = onlyUnprocessed ? await query.eq("is_processed", false) : await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    spn_code: number;
    fmi_code: number;
    engine_platform: string;
    spn_description: string;
    fmi_description: string;
    is_processed: boolean;
    demand_rank: number;
  }>;
}

async function doResearch(codes: RegistryRow[]) {
  console.log(`\n=== RESEARCH (${codes.length} codes) ===\n`);

  for (const code of codes) {
    const { count } = await db
      .from("grounding_sources")
      .select("id", { count: "exact", head: true })
      .eq("registry_id", code.id);

    if ((count ?? 0) > 0) {
      console.log(`  ${label(code)}\n    already has ${count} sources, skipping`);
      continue;
    }

    process.stdout.write(`  ${label(code)}\n    searching... `);
    try {
      const { sources, rejected, result } = await research(code);
      totalCost += result.costUsd;

      if (sources.length > 0) {
        const { error } = await db.from("grounding_sources").insert(sources);
        if (error) throw new Error(error.message);
      }

      const thresholds = sources.filter((s) => s.claim_type === "threshold").length;
      console.log(
        `${sources.length} sources (${thresholds} with measurable values)` +
          `${rejected.length ? `, ${rejected.length} rejected` : ""}` +
          ` · $${result.costUsd.toFixed(3)}`,
      );
    } catch (error) {
      console.log(`FAILED - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function doGenerate(codes: RegistryRow[]) {
  console.log(`\n=== GENERATE (${codes.length} codes) ===\n`);

  for (const code of codes) {
    const { data: sourceRows } = await db
      .from("grounding_sources")
      .select("*")
      .eq("registry_id", code.id)
      .order("confidence", { ascending: false, nullsFirst: false });

    const sources = (sourceRows ?? []) as Parameters<typeof write>[1];

    if (sources.length === 0) {
      console.log(`  ${label(code)}\n    no sources - skipped, correctly`);
      continue;
    }

    console.log(`  ${label(code)}`);
    let cost = 0;

    try {
      process.stdout.write(`    writing... `);
      const catalogue = await loadToolCatalogue(COLLECTIONS.hardware);
      const { draft, result: writeResult } = await write(code, sources, catalogue);
      cost += writeResult.costUsd;
      console.log(`${draft.content_markdown.split(/\s+/).length} words`);

      process.stdout.write(`    editing... `);
      const { markdown, result: editResult } = await edit(draft.content_markdown);
      cost += editResult.costUsd;
      console.log(`${markdown.split(/\s+/).length} words`);

      process.stdout.write(`    auditing... `);
      const auditOutcome = await audit(markdown, draft.pinout_test_data, sources);
      cost += auditOutcome.result.costUsd;
      totalCost += cost;

      const a = auditOutcome.audit;
      const supported = a.claims.filter((c) => c.verdict === "supported").length;
      console.log(
        `${a.verdict.toUpperCase()} · ${supported} supported, ${a.unsupported_count} unsupported, ` +
          `${a.stripped.length} stripped · boilerplate risk ${auditOutcome.boilerplateRisk}`,
      );

      const supportedUrls = new Set(
        a.claims.filter((c) => c.verdict === "supported" && c.source_url).map((c) => c.source_url!),
      );
      const keptPinouts = draft.pinout_test_data.filter(
        (p) => supportedUrls.size === 0 || supportedUrls.has(p.source_url),
      );

      const { error } = await db.from("fault_code_articles").upsert(
        {
          registry_id: code.id,
          title: draft.title,
          slug: draft.slug,
          spn_code: code.spn_code,
          fmi_code: code.fmi_code,
          engine_platform: code.engine_platform,
          content_markdown: auditOutcome.correctedMarkdown,
          meta_description: draft.meta_description,
          symptom_keywords: draft.symptom_keywords,
          schema_jsonld: buildJsonLd({
            title: draft.title,
            metaDescription: draft.meta_description,
            spn: code.spn_code,
            fmi: code.fmi_code,
            enginePlatform: code.engine_platform,
            slug: draft.slug,
            siteUrl: process.env.PUBLIC_SITE_URL ?? "https://fault-master.webflow.io",
            faq: draft.faq,
            sourceUrls: [...new Set(sources.map((s) => s.source_url))],
          }),
          taxonomy_tags: draft.taxonomy_tags,
          pinout_test_data: keptPinouts,
          severity: draft.severity,
          recommended_tool_sku: draft.recommended_tool_sku,
          provenance_audit: a,
          uniqueness_audit_log: {
            boilerplate_risk: auditOutcome.boilerplateRisk,
            source_count: sources.length,
          },
          model_used: writeResult.model,
          cost_usd: Number(cost.toFixed(4)),
          status: a.verdict === "fail" ? "failed" : "pending_review",
        },
        { onConflict: "slug" },
      );

      if (error) console.log(`    STORE FAILED - ${error.message}`);
      else {
        await db.from("fault_code_registry").update({ is_processed: true }).eq("id", code.id);
        console.log(`    stored · $${cost.toFixed(3)}`);
      }
    } catch (error) {
      console.log(`\n    FAILED - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const codes = await loadRegistry(mode !== "generate");

if (codes.length === 0) {
  console.log("Nothing to do - no matching registry rows.");
} else {
  if (mode === "research" || mode === "both") await doResearch(codes);
  if (mode === "generate" || mode === "both") await doGenerate(codes);
  console.log(`\nTotal spend this run: $${totalCost.toFixed(3)}\n`);
}
