import { task, logger } from "@trigger.dev/sdk";
import { supabase, type RegistryRow } from "../lib/supabase.js";
import { researchFaultCode } from "./research-fault-code.js";
import { generateArticle } from "./generate-article.js";

interface BatchPayload {
  /** How many codes to take from the registry. Keep this small at first. */
  limit?: number;
  /**
   * Research only, no writing. Useful on its own: sources are durable and can
   * be inspected before any generation money is spent.
   */
  researchOnly?: boolean;
  /**
   * Run each code a second time through a comparison model, tagging the result.
   * This is the mechanism behind the model bake-off - it produces two rows for
   * the same code that differ only in which model wrote them.
   */
  comparisonVariant?: string;
}

interface BatchResult {
  requested: number;
  researched: number;
  sourcesFound: number;
  withoutSources: string[];
  generated: number;
  failedAudit: number;
  totalCostUsd: number;
}

/**
 * Run the pipeline across a set of fault codes.
 *
 * Research first, in full, then generation. The sequencing is deliberate: a
 * code with no public sources should cost one research call and stop, not a
 * research call followed by three generation calls that produce something the
 * auditor was always going to reject.
 *
 * Ordered by demand_rank descending, so a run that is halted, rate-limited or
 * cancelled halfway has still produced the pages worth having.
 */
export const batchGenerate = task({
  id: "batch-generate",
  maxDuration: 3600,
  run: async (payload: BatchPayload = {}): Promise<BatchResult> => {
    const db = supabase();
    const limit = payload.limit ?? 20;

    const result: BatchResult = {
      requested: 0,
      researched: 0,
      sourcesFound: 0,
      withoutSources: [],
      generated: 0,
      failedAudit: 0,
      totalCostUsd: 0,
    };

    const { data, error } = await db
      .from("fault_code_registry")
      .select("*")
      .eq("is_processed", false)
      .order("demand_rank", { ascending: false })
      .order("spn_code", { ascending: true })
      .limit(limit);

    if (error) throw new Error(`Reading registry failed: ${error.message}`);

    const codes = (data ?? []) as RegistryRow[];
    result.requested = codes.length;

    if (codes.length === 0) {
      logger.info("No unprocessed registry rows - nothing to do");
      return result;
    }

    const label = (c: RegistryRow) =>
      `SPN ${c.spn_code} FMI ${c.fmi_code} (${c.engine_platform})`;

    // ---- Stage 1: research -------------------------------------------------
    logger.info("Researching batch", { count: codes.length });

    const researchRuns = await researchFaultCode.batchTriggerAndWait(
      codes.map((code) => ({ payload: { registryId: code.id } })),
    );

    const grounded: RegistryRow[] = [];

    researchRuns.runs.forEach((run, index) => {
      const code = codes[index];
      if (!code) return;

      if (!run.ok) {
        logger.error("Research failed", { code: label(code), error: String(run.error) });
        return;
      }

      result.researched++;
      result.totalCostUsd += run.output.costUsd;
      result.sourcesFound += run.output.found;

      if (run.output.found > 0) grounded.push(code);
      else result.withoutSources.push(label(code));
    });

    logger.info("Research stage complete", {
      grounded: grounded.length,
      ungrounded: result.withoutSources.length,
      costUsd: result.totalCostUsd,
    });

    if (payload.researchOnly) return result;

    if (grounded.length === 0) {
      // Not an error. A batch of codes with no public documentation is a real
      // and informative outcome - it says these pages should not exist, which
      // is exactly the judgement the pipeline is supposed to make.
      logger.warn("No codes in this batch had usable sources; nothing to generate");
      return result;
    }

    // ---- Stage 2: generate -------------------------------------------------
    const jobs = grounded.map((code) => ({ payload: { registryId: code.id } }));

    if (payload.comparisonVariant) {
      // The same codes again under a different model, so the two outputs are
      // comparable on identical sources. Which model each run uses is set by
      // the MODEL_* environment variables; the variant string is only a label
      // to tell the resulting rows apart.
      jobs.push(
        ...grounded.map((code) => ({
          payload: { registryId: code.id, variant: payload.comparisonVariant },
        })),
      );
    }

    const generateRuns = await generateArticle.batchTriggerAndWait(jobs);

    for (const run of generateRuns.runs) {
      if (!run.ok) {
        logger.error("Generation failed", { error: String(run.error) });
        continue;
      }
      result.totalCostUsd += run.output.costUsd;
      if (run.output.status === "failed") result.failedAudit++;
      else result.generated++;
    }

    logger.info("Batch complete", {
      ...result,
      costPerArticle:
        result.generated > 0
          ? Number((result.totalCostUsd / result.generated).toFixed(4))
          : 0,
    });

    return result;
  },
});
