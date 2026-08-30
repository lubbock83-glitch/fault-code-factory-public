import { schedules, task, logger } from "@trigger.dev/sdk";
import { COLLECTIONS } from "../lib/env.js";
import { supabase, type ArticleRow } from "../lib/supabase.js";
import {
  webflowClient,
  chunk,
  sleep,
  withRetry,
  WEBFLOW_BATCH_SIZE,
  WEBFLOW_REQUEST_SPACING_MS,
} from "../lib/webflow.js";
import { markdownToWebflowHtml } from "../lib/markdown.js";

interface SyncPayload {
  /** Plan the run and report it without writing anything to Webflow. */
  dryRun?: boolean;
  limit?: number;
}

interface SyncResult {
  scanned: number;
  created: number;
  updated: number;
  errors: string[];
  /** Tags the writer proposed that match no Webflow taxonomy item. */
  unmatchedTags: string[];
  /** SKUs referenced by articles that match no Webflow hardware item. */
  unmatchedSkus: string[];
}

/**
 * Push approved articles into the Webflow CMS.
 *
 * Deliberately one-way. Supabase is the system of record and Webflow holds a
 * rendered projection of it, so anything edited directly in the Webflow UI for
 * this collection is overwritten on the next run. That is a real hazard worth
 * stating plainly rather than discovering: authoring in Webflow for a synced
 * collection loses the work silently.
 *
 * Items are created as drafts. Publishing stays a separate, deliberate act -
 * a sync job that pushed unreviewed content live would defeat the review gate
 * that the rest of this pipeline is built around.
 */
export const syncArticles = task({
  id: "sync-articles",
  maxDuration: 3600,
  run: async (payload: SyncPayload = {}): Promise<SyncResult> => {
    const db = supabase();
    const wf = webflowClient();
    const dryRun = payload.dryRun ?? false;

    const result: SyncResult = {
      scanned: 0,
      created: 0,
      updated: 0,
      errors: [],
      unmatchedTags: [],
      unmatchedSkus: [],
    };

    // ---- Reference maps, read from Webflow rather than Supabase -----------
    //
    // The obvious design reads these from Supabase, but Supabase's hardware
    // table holds one row against seven live Webflow products - the catalogue
    // was authored directly in Webflow. Resolving against Webflow makes the
    // sync correct today instead of correct only after a backfill, and removes
    // a whole class of "the map was stale" failure.
    const [hardwareBySku, taxonomyByName] = await Promise.all([
      buildSkuMap(),
      buildTaxonomyMap(),
    ]);

    logger.info("Reference maps built", {
      hardware: hardwareBySku.size,
      taxonomy: taxonomyByName.size,
    });

    // ---- Articles cleared for publication and changed since last sync -----
    //
    // needs_sync is a generated column (synced_at is null OR updated_at is
    // later). PostgREST cannot compare two columns in a filter, so the
    // comparison lives in the table rather than being approximated here.
    const { data, error } = await db
      .from("fault_code_articles")
      .select("*")
      .in("status", ["approved", "published"])
      .eq("needs_sync", true)
      .order("spn_code", { ascending: true })
      .limit(payload.limit ?? 10000);

    if (error) throw new Error(`Reading articles failed: ${error.message}`);

    const pending = (data ?? []) as ArticleRow[];
    result.scanned = pending.length;

    if (pending.length === 0) {
      logger.info("Nothing to sync - Webflow is up to date");
      return result;
    }

    const unmatchedTags = new Set<string>();
    const unmatchedSkus = new Set<string>();

    const toFieldData = (article: ArticleRow) => {
      const tagIds: string[] = [];
      for (const tag of article.taxonomy_tags ?? []) {
        const id = taxonomyByName.get(tag.trim().toLowerCase());
        // Unmatched tags are reported, never auto-created. Creating taxonomy
        // items silently would spend CMS item budget - a hard-capped, paid
        // resource - on terms nobody reviewed.
        if (id) tagIds.push(id);
        else unmatchedTags.add(tag);
      }

      let hardwareId: string | null = null;
      if (article.recommended_tool_sku) {
        hardwareId = hardwareBySku.get(article.recommended_tool_sku) ?? null;
        if (!hardwareId) unmatchedSkus.add(article.recommended_tool_sku);
      }

      return {
        name: article.title,
        slug: article.slug,
        "spn-code": article.spn_code,
        "fmi-code": article.fmi_code,
        "engine-platform": article.engine_platform,
        severity: article.severity,
        "symptom-keywords": article.symptom_keywords ?? "",
        "meta-description": article.meta_description ?? "",
        "diagnostic-workflow-and-content": markdownToWebflowHtml(
          article.content_markdown ?? "",
        ),
        "json-ld-schema": article.schema_jsonld
          ? JSON.stringify(article.schema_jsonld)
          : "",
        "taxonomy-tags": tagIds,
        "required-diagnostic-hardware": hardwareId,
      };
    };

    const toCreate = pending.filter((a) => !a.webflow_item_id);
    const toUpdate = pending.filter((a) => a.webflow_item_id);

    logger.info("Sync plan", { create: toCreate.length, update: toUpdate.length, dryRun });

    if (dryRun) {
      // Field mapping still runs, so a dry run surfaces unmatched tags and
      // SKUs. A dry run that only counted rows would report success and then
      // the live run would drop every reference field.
      for (const article of pending) toFieldData(article);
      result.unmatchedTags = [...unmatchedTags];
      result.unmatchedSkus = [...unmatchedSkus];
      return result;
    }

    // ---- Create ------------------------------------------------------------
    for (const batch of chunk(toCreate, WEBFLOW_BATCH_SIZE)) {
      try {
        const response = await withRetry("createItems", () =>
          wf.collections.items.createItems(COLLECTIONS.faultCodes, {
            isDraft: true,
            isArchived: false,
            fieldData: batch.map(toFieldData),
          }),
        );

        // The bulk endpoint's response type is declared too loosely to trust -
        // fieldData is typed as a single object even when an array comes back -
        // so ids are recovered defensively by slug rather than by position.
        const bySlug = new Map<string, string>();
        for (const item of normaliseCreatedItems(response)) {
          if (item.slug && item.id) bySlug.set(item.slug, item.id);
        }

        const stamped = new Date().toISOString();
        for (const article of batch) {
          const webflowId = bySlug.get(article.slug);
          if (!webflowId) {
            result.errors.push(
              `Created but id unresolved for slug ${article.slug} - run reconcile-webflow-ids`,
            );
            continue;
          }
          const { error: stampError } = await db
            .from("fault_code_articles")
            .update({ webflow_item_id: webflowId, synced_at: stamped })
            .eq("id", article.id);
          if (stampError) {
            result.errors.push(`Stamping ${article.slug} failed: ${stampError.message}`);
          } else {
            result.created++;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Create batch failed: ${message}`);
        logger.error("Create batch failed", { message, size: batch.length });
      }

      await sleep(WEBFLOW_REQUEST_SPACING_MS);
    }

    // ---- Update ------------------------------------------------------------
    for (const batch of chunk(toUpdate, WEBFLOW_BATCH_SIZE)) {
      try {
        await withRetry("updateItems", () =>
          wf.collections.items.updateItems(COLLECTIONS.faultCodes, {
            items: batch.map((article) => ({
              id: article.webflow_item_id as string,
              fieldData: toFieldData(article),
            })),
          }),
        );

        const stamped = new Date().toISOString();
        const { error: stampError } = await db
          .from("fault_code_articles")
          .update({ synced_at: stamped })
          .in(
            "id",
            batch.map((a) => a.id),
          );

        if (stampError) {
          result.errors.push(`Stamping update batch failed: ${stampError.message}`);
        } else {
          result.updated += batch.length;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Update batch failed: ${message}`);
        logger.error("Update batch failed", { message, size: batch.length });
      }

      await sleep(WEBFLOW_REQUEST_SPACING_MS);
    }

    result.unmatchedTags = [...unmatchedTags];
    result.unmatchedSkus = [...unmatchedSkus];

    if (result.unmatchedTags.length > 0) {
      logger.warn("Taxonomy tags with no matching Webflow item", {
        tags: result.unmatchedTags,
      });
    }
    if (result.unmatchedSkus.length > 0) {
      logger.warn("Tool SKUs with no matching Webflow product", {
        skus: result.unmatchedSkus,
      });
    }

    logger.info("Sync complete", { ...result, errorCount: result.errors.length });
    return result;
  },
});

/** SKU -> Webflow item id, read live from the hardware collection. */
async function buildSkuMap(): Promise<Map<string, string>> {
  const wf = webflowClient();
  const map = new Map<string, string>();

  const page = await withRetry("listHardware", () =>
    wf.collections.items.listItems(COLLECTIONS.hardware, { limit: 100 }),
  );

  for (const item of page.items ?? []) {
    const sku = (item.fieldData as { "unique-sku"?: string } | undefined)?.["unique-sku"];
    if (sku && item.id) map.set(sku, item.id);
  }

  return map;
}

/** Lower-cased taxonomy name -> Webflow item id. */
async function buildTaxonomyMap(): Promise<Map<string, string>> {
  const wf = webflowClient();
  const map = new Map<string, string>();

  const page = await withRetry("listTaxonomy", () =>
    wf.collections.items.listItems(COLLECTIONS.taxonomy, { limit: 100 }),
  );

  for (const item of page.items ?? []) {
    const name = (item.fieldData as { name?: string } | undefined)?.name;
    // Matching is case-insensitive because the writer emits human phrasing
    // ("Detroit Diesel DD15") and exact-case matching would silently drop tags
    // over capitalisation nobody would think to check.
    if (name && item.id) map.set(name.trim().toLowerCase(), item.id);
  }

  return map;
}

/**
 * Flatten whatever shape the bulk create endpoint returned into {id, slug}.
 * Handles both the array and single-object forms rather than trusting either,
 * because the SDK's declared type does not match its runtime behaviour.
 */
function normaliseCreatedItems(response: unknown): Array<{ id?: string; slug?: string }> {
  const out: Array<{ id?: string; slug?: string }> = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }

    const obj = node as Record<string, unknown>;

    if (Array.isArray(obj.items)) {
      for (const entry of obj.items) visit(entry);
      return;
    }

    const id = typeof obj.id === "string" ? obj.id : undefined;
    const fieldData = obj.fieldData;

    if (Array.isArray(fieldData)) {
      // Array fieldData carries no per-entry id, so nothing is resolvable here;
      // the slug is recorded so the caller can report it as unresolved.
      for (const entry of fieldData) {
        const slug = (entry as Record<string, unknown>)?.slug;
        out.push({ id: undefined, slug: typeof slug === "string" ? slug : undefined });
      }
      return;
    }

    if (fieldData && typeof fieldData === "object") {
      const slug = (fieldData as Record<string, unknown>).slug;
      out.push({ id, slug: typeof slug === "string" ? slug : undefined });
    }
  };

  visit(response);
  return out;
}

/**
 * Hourly incremental sync.
 *
 * Only rows whose updated_at has moved past synced_at are touched, so a quiet
 * hour costs one Supabase query and no Webflow calls at all.
 */
export const scheduledArticleSync = schedules.task({
  id: "scheduled-article-sync",
  cron: "0 * * * *",
  run: async () => syncArticles.triggerAndWait({}),
});
