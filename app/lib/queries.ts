import "server-only";
import { db, type ArticleRow, type GroundingSourceRow, type RegistryRow } from "./db";

/**
 * Read paths for the console.
 *
 * All of these run on the server with the secret key, so they see every row
 * regardless of status - which is the entire point of the console. The public
 * site sees only `approved` and `published` through Row Level Security.
 */

export interface PipelineStats {
  registryTotal: number;
  registryUnprocessed: number;
  sourcesTotal: number;
  codesWithSources: number;
  byStatus: Record<string, number>;
  totalCostUsd: number;
  avgCostPerArticle: number;
  searchQueries: number;
}

export async function getPipelineStats(): Promise<PipelineStats> {
  const supabase = db();

  // Counts run as parallel head requests. `head: true` fetches no rows at all,
  // which matters once the article table is in the thousands - the dashboard
  // should not pull every row to count them.
  const [registry, unprocessed, sources, articles, queries] = await Promise.all([
    supabase.from("fault_code_registry").select("id", { count: "exact", head: true }),
    supabase
      .from("fault_code_registry")
      .select("id", { count: "exact", head: true })
      .eq("is_processed", false),
    supabase.from("grounding_sources").select("registry_id", { count: "exact" }),
    supabase.from("fault_code_articles").select("status, cost_usd"),
    supabase.from("search_queries").select("id", { count: "exact", head: true }),
  ]);

  const rows = (articles.data ?? []) as Array<{ status: string; cost_usd: number | null }>;

  const byStatus: Record<string, number> = {};
  let totalCostUsd = 0;
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    totalCostUsd += row.cost_usd ?? 0;
  }

  const sourceRows = (sources.data ?? []) as Array<{ registry_id: string }>;
  const codesWithSources = new Set(sourceRows.map((s) => s.registry_id)).size;

  return {
    registryTotal: registry.count ?? 0,
    registryUnprocessed: unprocessed.count ?? 0,
    sourcesTotal: sources.count ?? 0,
    codesWithSources,
    byStatus,
    totalCostUsd,
    avgCostPerArticle: rows.length > 0 ? totalCostUsd / rows.length : 0,
    searchQueries: queries.count ?? 0,
  };
}

export interface QueueItem {
  id: string;
  title: string;
  slug: string;
  spn_code: number;
  fmi_code: number;
  engine_platform: string;
  severity: string;
  status: string;
  cost_usd: number | null;
  model_used: string | null;
  updated_at: string;
  /** Denormalised from provenance_audit so the queue needs no second query. */
  unsupported_count: number;
  claim_count: number;
  word_count: number;
}

/**
 * The review queue.
 *
 * Sorted with the most suspect articles first - those carrying the most
 * unsupported claims. A reviewer working top-down therefore spends their
 * sharpest attention where fabrication is most likely, rather than on whatever
 * happened to be generated first.
 */
/**
 * Shape of the columns this query selects.
 *
 * Declared explicitly because the client is untyped: without a hint,
 * supabase-js widens `data` to a union that includes its error row type, and
 * every field access fails to compile. `.returns<T>()` narrows it. Generating
 * full database types would remove the need for this, at the cost of a
 * generated file that has to be regenerated on every migration - not worth it
 * for a handful of queries.
 */
interface QueueRow {
  id: string;
  title: string;
  slug: string;
  spn_code: number;
  fmi_code: number;
  engine_platform: string;
  severity: string;
  status: string;
  cost_usd: number | null;
  model_used: string | null;
  updated_at: string;
  provenance_audit: { claims?: unknown[]; unsupported_count?: number } | null;
  content_markdown: string | null;
}

export async function getReviewQueue(status?: string): Promise<QueueItem[]> {
  const supabase = db();

  let query = supabase
    .from("fault_code_articles")
    .select(
      "id, title, slug, spn_code, fmi_code, engine_platform, severity, status, " +
        "cost_usd, model_used, updated_at, provenance_audit, content_markdown",
    )
    .order("updated_at", { ascending: false })
    .limit(500);

  query = status && status !== "all" ? query.eq("status", status) : query;

  const { data, error } = await query.returns<QueueRow[]>();
  if (error) throw new Error(`Reading the review queue failed: ${error.message}`);

  const items = (data ?? []).map((row): QueueItem => {
    const audit = row.provenance_audit;

    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      spn_code: row.spn_code,
      fmi_code: row.fmi_code,
      engine_platform: row.engine_platform,
      severity: row.severity,
      status: row.status,
      cost_usd: row.cost_usd,
      model_used: row.model_used,
      updated_at: row.updated_at,
      unsupported_count: audit?.unsupported_count ?? 0,
      claim_count: Array.isArray(audit?.claims) ? audit.claims.length : 0,
      word_count: String(row.content_markdown ?? "")
        .split(/\s+/)
        .filter(Boolean).length,
    };
  });

  return items.sort((a, b) => b.unsupported_count - a.unsupported_count);
}

export interface ArticleDetail {
  article: ArticleRow;
  registry: RegistryRow | null;
  sources: GroundingSourceRow[];
}

export async function getArticle(id: string): Promise<ArticleDetail | null> {
  const supabase = db();

  const { data: article } = await supabase
    .from("fault_code_articles")
    .select("*")
    .eq("id", id)
    .maybeSingle<ArticleRow>();

  if (!article) return null;

  // Sources are fetched by registry_id, not article id: they belong to the
  // fault code, not to any one draft of it. That is what lets a code be
  // regenerated - or generated twice under different models - without paying to
  // search the web again.
  const { data: sources } = article.registry_id
    ? await supabase
        .from("grounding_sources")
        .select("*")
        .eq("registry_id", article.registry_id)
        .order("confidence", { ascending: false, nullsFirst: false })
    : { data: [] };

  const { data: registry } = article.registry_id
    ? await supabase
        .from("fault_code_registry")
        .select("*")
        .eq("id", article.registry_id)
        .maybeSingle<RegistryRow>()
    : { data: null };

  return {
    article,
    registry: registry ?? null,
    sources: (sources ?? []) as GroundingSourceRow[],
  };
}

export interface RegistryListItem extends RegistryRow {
  source_count: number;
  article_id: string | null;
  article_status: string | null;
}

export async function getRegistry(): Promise<RegistryListItem[]> {
  const supabase = db();

  const [{ data: registry }, { data: sources }, { data: articles }] = await Promise.all([
    supabase
      .from("fault_code_registry")
      .select("*")
      .order("demand_rank", { ascending: false })
      .order("spn_code", { ascending: true })
      .limit(500),
    supabase.from("grounding_sources").select("registry_id"),
    supabase.from("fault_code_articles").select("id, registry_id, status"),
  ]);

  // Counted in memory rather than with a grouped SQL view. At registry sizes
  // measured in hundreds this is one round trip against three, and swapping to
  // a view later changes nothing above this function.
  const sourceCounts = new Map<string, number>();
  for (const row of (sources ?? []) as Array<{ registry_id: string }>) {
    sourceCounts.set(row.registry_id, (sourceCounts.get(row.registry_id) ?? 0) + 1);
  }

  const articleByRegistry = new Map<string, { id: string; status: string }>();
  for (const row of (articles ?? []) as Array<{
    id: string;
    registry_id: string | null;
    status: string;
  }>) {
    if (row.registry_id) articleByRegistry.set(row.registry_id, { id: row.id, status: row.status });
  }

  return ((registry ?? []) as RegistryRow[]).map((row) => {
    const article = articleByRegistry.get(row.id);
    return {
      ...row,
      source_count: sourceCounts.get(row.id) ?? 0,
      article_id: article?.id ?? null,
      article_status: article?.status ?? null,
    };
  });
}

/**
 * Most frequent site searches that returned nothing.
 *
 * This is the highest-signal topic list available: a technician searched for a
 * code, the library did not have it, and they wanted it. Ranked by how many
 * people asked.
 */
export async function getUnmetDemand(): Promise<Array<{ q: string; count: number }>> {
  const supabase = db();

  const { data } = await supabase
    .from("search_queries")
    .select("q, result_count")
    .eq("result_count", 0)
    .order("created_at", { ascending: false })
    .limit(1000);

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ q: string }>) {
    const key = row.q.trim().toLowerCase();
    if (key.length < 2) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([q, count]) => ({ q, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}
