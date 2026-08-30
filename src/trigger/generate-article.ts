import { task, logger } from "@trigger.dev/sdk";
import {
  supabase,
  type GroundingSourceRow,
  type RegistryRow,
} from "../lib/supabase.js";
import { write, slugify } from "../lib/agents/writer.js";
import { edit } from "../lib/agents/editor.js";
import { audit } from "../lib/agents/auditor.js";
import { buildJsonLd } from "../lib/jsonld.js";
import { loadToolCatalogue } from "../lib/webflow.js";
import { COLLECTIONS } from "../lib/env.js";

interface GeneratePayload {
  registryId: string;
  /**
   * Tag written to model_used alongside the real model id. Set this when
   * running the same code twice on different models so the two rows are
   * distinguishable in the comparison.
   */
  variant?: string;
}

interface GenerateResult {
  registryId: string;
  articleId: string | null;
  status: "pending_review" | "failed";
  costUsd: number;
  unsupportedClaims: number;
  strippedCount: number;
}

/**
 * Draft, edit and audit one article.
 *
 * Writes the result whatever the verdict. A failed audit is not an error to be
 * thrown away - it is the most informative artefact the pipeline produces,
 * because it shows exactly which claims the writer invented. Discarding it
 * would hide the failure mode this design exists to surface.
 */
export const generateArticle = task({
  id: "generate-article",
  maxDuration: 1800,
  // Three agents run in series per article, so five concurrent articles means
  // five in-flight model calls, not fifteen. Matched to the research queue so
  // the two stages of a batch cannot together exceed the rate limit.
  queue: { concurrencyLimit: 5 },
  run: async (payload: GeneratePayload): Promise<GenerateResult> => {
    const db = supabase();
    let costUsd = 0;

    const { data: registry, error } = await db
      .from("fault_code_registry")
      .select("*")
      .eq("id", payload.registryId)
      .single<RegistryRow>();

    if (error || !registry) {
      throw new Error(`Registry row ${payload.registryId} not found: ${error?.message}`);
    }

    const label = `SPN ${registry.spn_code} FMI ${registry.fmi_code} (${registry.engine_platform})`;

    const { data: sourceRows, error: sourceError } = await db
      .from("grounding_sources")
      .select("*")
      .eq("registry_id", registry.id)
      .order("confidence", { ascending: false, nullsFirst: false });

    if (sourceError) {
      throw new Error(`Reading sources for ${label} failed: ${sourceError.message}`);
    }

    const sources = (sourceRows ?? []) as GroundingSourceRow[];

    if (sources.length === 0) {
      logger.warn("No grounding sources - refusing to generate", { label });
      return {
        registryId: registry.id,
        articleId: null,
        status: "failed",
        costUsd: 0,
        unsupportedClaims: 0,
        strippedCount: 0,
      };
    }

    // ---- Draft ------------------------------------------------------------
    // The catalogue is loaded per article rather than cached across a batch.
    // One extra Webflow read against a 100-item collection is cheap, and it
    // means a product added or discontinued mid-run is reflected immediately
    // rather than every remaining article recommending a stale SKU.
    const catalogue = await loadToolCatalogue(COLLECTIONS.hardware);
    const { draft, result: writeResult } = await write(registry, sources, catalogue);
    costUsd += writeResult.costUsd;
    logger.info("Drafted", { label, words: draft.content_markdown.split(/\s+/).length });

    // ---- Edit -------------------------------------------------------------
    const { markdown: edited, result: editResult } = await edit(draft.content_markdown);
    costUsd += editResult.costUsd;

    // ---- Audit ------------------------------------------------------------
    const auditOutcome = await audit(edited, draft.pinout_test_data, sources);
    costUsd += auditOutcome.result.costUsd;

    logger.info("Audited", {
      label,
      verdict: auditOutcome.audit.verdict,
      unsupported: auditOutcome.audit.unsupported_count,
      stripped: auditOutcome.audit.stripped.length,
      boilerplateRisk: auditOutcome.boilerplateRisk,
    });

    // Pinouts whose citation the auditor could not stand behind do not survive
    // into the record. This is the value most likely to be acted on physically.
    const supportedUrls = new Set(
      auditOutcome.audit.claims
        .filter((c) => c.verdict === "supported" && c.source_url)
        .map((c) => c.source_url as string),
    );
    const keptPinouts = draft.pinout_test_data.filter(
      (p) => supportedUrls.size === 0 || supportedUrls.has(p.source_url),
    );

    const failed = auditOutcome.audit.verdict === "fail";

    const jsonLd = buildJsonLd({
      title: draft.title,
      metaDescription: draft.meta_description,
      spn: registry.spn_code,
      fmi: registry.fmi_code,
      enginePlatform: registry.engine_platform,
      slug: draft.slug,
      siteUrl: process.env.PUBLIC_SITE_URL ?? "https://fault-master.webflow.io",
      faq: draft.faq,
      sourceUrls: [...new Set(sources.map((s) => s.source_url))],
    });

    const row = {
      registry_id: registry.id,
      title: draft.title,
      slug: await uniqueSlug(draft.slug, registry),
      spn_code: registry.spn_code,
      fmi_code: registry.fmi_code,
      engine_platform: registry.engine_platform,
      content_markdown: auditOutcome.correctedMarkdown,
      meta_description: draft.meta_description,
      symptom_keywords: draft.symptom_keywords,
      schema_jsonld: jsonLd,
      taxonomy_tags: draft.taxonomy_tags,
      pinout_test_data: keptPinouts,
      severity: draft.severity,
      recommended_tool_sku: draft.recommended_tool_sku,
      provenance_audit: auditOutcome.audit,
      uniqueness_audit_log: {
        boilerplate_risk: auditOutcome.boilerplateRisk,
        source_count: sources.length,
        threshold_sources: sources.filter((s) => s.claim_type === "threshold").length,
      },
      model_used: payload.variant
        ? `${writeResult.model} (${payload.variant})`
        : writeResult.model,
      cost_usd: Number(costUsd.toFixed(4)),
      // Never straight to 'approved'. A human decides, always - the audit
      // narrows what they must check, it does not replace them.
      status: failed ? ("failed" as const) : ("pending_review" as const),
    };

    const { data: inserted, error: insertError } = await db
      .from("fault_code_articles")
      .upsert(row, { onConflict: "slug" })
      .select("id")
      .single<{ id: string }>();

    if (insertError) {
      throw new Error(`Storing article for ${label} failed: ${insertError.message}`);
    }

    await db
      .from("fault_code_registry")
      .update({ is_processed: true })
      .eq("id", registry.id);

    return {
      registryId: registry.id,
      articleId: inserted?.id ?? null,
      status: row.status,
      costUsd: row.cost_usd,
      unsupportedClaims: auditOutcome.audit.unsupported_count,
      strippedCount: auditOutcome.audit.stripped.length,
    };
  },
});

/**
 * Slugs are unique across the collection and shared with live URLs, so a
 * collision must not silently overwrite another code's page. Falls back to
 * appending the code, which is both unique and readable.
 */
async function uniqueSlug(preferred: string, registry: RegistryRow): Promise<string> {
  const db = supabase();

  const { data } = await db
    .from("fault_code_articles")
    .select("registry_id")
    .eq("slug", preferred)
    .maybeSingle<{ registry_id: string | null }>();

  if (!data || data.registry_id === registry.id) return preferred;

  return slugify(
    `${preferred}-spn-${registry.spn_code}-fmi-${registry.fmi_code}-${registry.engine_platform}`,
  );
}
