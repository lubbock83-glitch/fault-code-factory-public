import { task, logger } from "@trigger.dev/sdk";
import { supabase, type RegistryRow } from "../lib/supabase.js";
import { research } from "../lib/agents/researcher.js";

interface ResearchPayload {
  registryId: string;
  /** Re-research a code that already has sources, replacing them. */
  force?: boolean;
}

interface ResearchResult {
  registryId: string;
  found: number;
  rejected: number;
  costUsd: number;
  skipped: boolean;
}

/**
 * Gather public source material for one fault code.
 *
 * Split from generation deliberately. Research is the slow, expensive,
 * network-bound half and its output is durable - once a code's sources are
 * stored they can be reused across regenerations, model comparisons and prompt
 * changes without paying to search the web again.
 */
export const researchFaultCode = task({
  id: "research-fault-code",
  maxDuration: 900,
  // Capped at five concurrent runs. The binding constraint is not our compute
  // but the Anthropic API's rate limit and the politeness of hammering
  // manufacturer documentation sites: a 300-code batch fanning out unbounded
  // would earn a 429 from one and a block from the other.
  queue: { concurrencyLimit: 5 },
  run: async (payload: ResearchPayload): Promise<ResearchResult> => {
    const db = supabase();

    const { data: registry, error } = await db
      .from("fault_code_registry")
      .select("*")
      .eq("id", payload.registryId)
      .single<RegistryRow>();

    if (error || !registry) {
      throw new Error(`Registry row ${payload.registryId} not found: ${error?.message}`);
    }

    const label = `SPN ${registry.spn_code} FMI ${registry.fmi_code} (${registry.engine_platform})`;

    const { count } = await db
      .from("grounding_sources")
      .select("id", { count: "exact", head: true })
      .eq("registry_id", registry.id);

    if ((count ?? 0) > 0 && !payload.force) {
      logger.info("Already researched, skipping", { label, existing: count });
      return {
        registryId: registry.id,
        found: count ?? 0,
        rejected: 0,
        costUsd: 0,
        skipped: true,
      };
    }

    logger.info("Researching", { label });

    const { sources, rejected, result } = await research(registry);

    if (rejected.length > 0) {
      // Not fatal. A claim that fails validation is one the model returned in a
      // shape we cannot trust, and dropping it is the correct outcome - but it
      // is worth seeing in the log if it starts happening constantly.
      logger.warn("Rejected malformed claims", { label, count: rejected.length, rejected });
    }

    if (sources.length === 0) {
      logger.warn("No usable public sources found", { label });
      return {
        registryId: registry.id,
        found: 0,
        rejected: rejected.length,
        costUsd: result.costUsd,
        skipped: false,
      };
    }

    if (payload.force) {
      await db.from("grounding_sources").delete().eq("registry_id", registry.id);
    }

    const { error: insertError } = await db.from("grounding_sources").insert(sources);
    if (insertError) {
      throw new Error(`Storing sources for ${label} failed: ${insertError.message}`);
    }

    logger.info("Research complete", {
      label,
      found: sources.length,
      thresholds: sources.filter((s) => s.claim_type === "threshold").length,
      costUsd: result.costUsd,
    });

    return {
      registryId: registry.id,
      found: sources.length,
      rejected: rejected.length,
      costUsd: result.costUsd,
      skipped: false,
    };
  },
});
