import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * Server-side Supabase client.
 *
 * Uses the secret key, which bypasses Row Level Security. That is correct here -
 * the pipeline must read and write queued, processing and pending_review rows
 * that the public site is explicitly forbidden to see. Never import this into
 * anything that ships to a browser.
 *
 * Lazy for the same reason the Webflow client is: constructing at import time
 * makes every module that touches a type from this file fail when the key is
 * unset.
 */
let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  client ??= createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ArticleStatus =
  | "queued"
  | "processing"
  | "pending_review"
  | "approved"
  | "published"
  | "failed";

export type Severity =
  | "Informational"
  | "Active Fault"
  | "Derate Imminent"
  | "Shutdown Risk";

/**
 * What kind of assertion a grounding source underwrites.
 *
 * `threshold` is the one that matters most: it covers every number a technician
 * might put a meter on. The auditor treats a threshold claim with no matching
 * source row as a hard failure rather than something to soften.
 */
export type ClaimType =
  | "definition"
  | "symptom"
  | "procedure"
  | "threshold"
  | "severity"
  | "hardware";

export interface RegistryRow {
  id: string;
  spn_code: number;
  fmi_code: number;
  engine_platform: string;
  spn_description: string;
  fmi_description: string;
  is_processed: boolean;
  demand_rank: number;
}

export interface GroundingSourceRow {
  id: string;
  registry_id: string;
  source_url: string;
  source_domain: string;
  source_title: string | null;
  retrieved_at: string;
  snippet: string;
  claim_type: ClaimType;
  claim_value: string;
  confidence: number | null;
}

/** A grounding row before it has been written - what the researcher emits. */
export type GroundingSourceDraft = Omit<
  GroundingSourceRow,
  "id" | "retrieved_at"
>;

export interface ArticleRow {
  id: string;
  registry_id: string | null;
  webflow_item_id: string | null;
  title: string;
  slug: string;
  spn_code: number;
  fmi_code: number;
  engine_platform: string;
  content_markdown: string | null;
  meta_description: string | null;
  symptom_keywords: string | null;
  schema_jsonld: unknown | null;
  schematic_svg: string | null;
  source_tsb_url: string | null;
  taxonomy_tags: string[];
  pinout_test_data: PinoutEntry[];
  recommended_tool_sku: string | null;
  severity: Severity;
  uniqueness_audit_log: unknown | null;
  provenance_audit: ProvenanceAudit | null;
  model_used: string | null;
  cost_usd: number | null;
  status: ArticleStatus;
  synced_at: string | null;
  needs_sync: boolean | null;
  updated_at: string;
}

/**
 * One row of measurable electrical data.
 *
 * `source_url` is not optional by accident - a pinout entry that cannot name
 * where its numbers came from has no business being rendered on a page someone
 * will act on with a multimeter.
 */
export interface PinoutEntry {
  pin: string;
  circuit: string;
  expected: string;
  source_url: string;
}

/** One checkable assertion, paired with the source that backs it. */
export interface ProvenanceClaim {
  claim: string;
  claim_type: ClaimType;
  /** Null means the auditor found nothing supporting it. */
  source_url: string | null;
  verdict: "supported" | "unsupported" | "contradicted";
}

export interface ProvenanceAudit {
  claims: ProvenanceClaim[];
  unsupported_count: number;
  stripped: string[];
  verdict: "pass" | "fail";
  notes: string | null;
}

export interface TaxonomyRow {
  id: string;
  webflow_item_id: string | null;
  name: string;
  slug: string;
}

export interface HardwareRow {
  id: string;
  webflow_item_id: string | null;
  name: string;
  slug: string;
  unique_sku: string;
}
