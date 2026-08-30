import { WebflowClient } from "webflow-api";
import { env } from "./env.js";

/**
 * Constructed on first use rather than at import.
 *
 * The research and generation tasks never touch Webflow, and a module-level
 * `new WebflowClient({ accessToken: env.webflowToken })` would make importing
 * any helper from this file throw when WEBFLOW_TOKEN is unset - failing a job
 * over a credential it was never going to use.
 */
let client: WebflowClient | undefined;

export function webflowClient(): WebflowClient {
  client ??= new WebflowClient({ accessToken: env.webflowToken });
  return client;
}

/**
 * Webflow's Data API allows 60 requests per minute on standard plans, and
 * answers a breach with HTTP 429. Bulk endpoints accept up to 100 items per
 * call, so a large sync is ~100 requests: comfortably over the limit without
 * pacing.
 *
 * One second between calls keeps us at 60/min with no burst. Slower than
 * strictly necessary, but a sync that takes two minutes and completes beats one
 * that takes ninety seconds and dies halfway with Supabase and Webflow out of
 * agreement about what is published.
 */
export const WEBFLOW_BATCH_SIZE = 100;
export const WEBFLOW_REQUEST_SPACING_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Retry a Webflow call on 429 and 5xx, honouring Retry-After when present.
 * Other errors - a 400 from bad field data, say - are thrown immediately,
 * because retrying them just wastes the rate limit budget.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : undefined;

      const retryable = status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt === maxAttempts) throw error;

      const backoffMs = 2000 * 2 ** (attempt - 1);
      console.warn(
        `${label}: HTTP ${status}, attempt ${attempt}/${maxAttempts}, retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

/** One purchasable tool, reduced to what a writer needs to choose between them. */
export interface CatalogueTool {
  sku: string;
  name: string;
  /** Bi-directional capabilities, plain text. Empty for adapters and readers -
   *  which is exactly the signal the writer needs: a fault requiring a forced
   *  regen cannot be closed out with a code reader. */
  capabilities: string;
  coverage: string;
}

/**
 * The hardware catalogue, for the writer's tool recommendation.
 *
 * Read from Webflow rather than Supabase for the same reason the sync's
 * reference maps are: Supabase holds one hardware row against seven live
 * products, so Webflow is the only complete copy.
 *
 * Reduced to four fields deliberately. The writer is choosing which tool a
 * technician needs for one specific fault, and the full product records - specs,
 * images, pricing, financing copy - would be several thousand tokens of
 * irrelevance per article, paid for on every generation.
 */
export async function loadToolCatalogue(collectionId: string): Promise<CatalogueTool[]> {
  const page = await withRetry("listHardware", () =>
    webflowClient().collections.items.listItems(collectionId, { limit: 100 }),
  );

  const stripHtml = (value: unknown): string =>
    typeof value === "string"
      ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)
      : "";

  const tools: CatalogueTool[] = [];

  for (const item of page.items ?? []) {
    const data = item.fieldData as Record<string, unknown> | undefined;
    const sku = data?.["unique-sku"];
    const name = data?.name;
    if (typeof sku !== "string" || typeof name !== "string") continue;

    tools.push({
      sku,
      name,
      capabilities: stripHtml(data?.["bidirectional-functions"]),
      coverage: stripHtml(data?.["vehicle-and-engine-coverage"]),
    });
  }

  return tools;
}
