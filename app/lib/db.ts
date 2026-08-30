import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Database access for the review console.
 *
 * Deliberately its own client rather than importing src/lib/supabase.ts. Two
 * reasons, and the second is the one that matters:
 *
 * 1. The task code uses explicit `.js` extensions on relative imports, which is
 *    correct for Node ESM but adds bundler resolution complexity for no gain
 *    here.
 * 2. The console and the pipeline are separate consumers of one database. Not
 *    sharing a client module means neither can quietly acquire a dependency on
 *    the other's configuration.
 *
 * `server-only` at the top is load-bearing. This module holds a key that
 * bypasses Row Level Security; importing it into a client component would ship
 * that key to a browser. The package turns that mistake into a build error
 * rather than a breach.
 */

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;

    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env. " +
          "The console reads draft and pending_review rows, which Row Level " +
          "Security hides from the publishable key by design.",
      );
    }

    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Types are imported rather than redeclared so the console cannot drift from
// the pipeline's understanding of the schema. `import type` is erased at build
// time, so this creates no runtime dependency on the task code.
export type {
  ArticleRow,
  ArticleStatus,
  ClaimType,
  GroundingSourceRow,
  PinoutEntry,
  ProvenanceAudit,
  ProvenanceClaim,
  RegistryRow,
  Severity,
} from "@/src/lib/supabase";
