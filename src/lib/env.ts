/**
 * Configuration access.
 *
 * Two rules hold this file together:
 *
 * 1. Nothing is hardcoded. Every credential AND every project identifier comes
 *    from the environment, which is what makes this source tree safe to publish
 *    without a scrubbing step that someone will eventually forget to run.
 *
 * 2. Reads are lazy getters, not module-level constants. A missing variable then
 *    throws at the point of use rather than at import time, so a task that never
 *    touches Webflow does not fail because WEBFLOW_TOKEN is unset.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("REPLACE_ME")) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in .env at the repo root, and in the Trigger.dev dashboard for deployed runs.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export const env = {
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  /** Server-side only. Bypasses RLS - never expose to a browser. */
  get supabaseSecretKey() {
    return required("SUPABASE_SECRET_KEY");
  },
  get webflowToken() {
    return required("WEBFLOW_TOKEN");
  },
  get webflowSiteId() {
    return required("WEBFLOW_SITE_ID");
  },
};

/**
 * Webflow CMS collection IDs, supplied by the environment.
 *
 * These are not secrets, but they are deployment-specific: the same code should
 * be able to point at a staging site by changing .env alone.
 */
export const COLLECTIONS = {
  get faultCodes() {
    return required("WEBFLOW_COLLECTION_FAULT_CODES");
  },
  get hardware() {
    return required("WEBFLOW_COLLECTION_HARDWARE");
  },
  get taxonomy() {
    return required("WEBFLOW_COLLECTION_TAXONOMY");
  },
};

/**
 * The default model for every agent.
 *
 * Costed across a 300-article run the whole spread between the cheapest and
 * dearest model is around $158 - less than four months of site hosting - so the
 * default is the capable one and the cheaper tiers are something you opt into
 * after measuring, not something assumed to be fine.
 */
const DEFAULT_MODEL = "claude-opus-5";

export type AgentName = "researcher" | "writer" | "editor" | "auditor";

/**
 * Per-agent model selection.
 *
 * The auditor is deliberately called out: it is the gate that catches an
 * invented pin voltage before it reaches a page a technician will act on. Its
 * failure mode is silent - a weaker auditor does not error, it simply approves
 * things it should not - so it is the one agent where saving money buys risk
 * that does not announce itself.
 */
export function modelFor(agent: AgentName): string {
  switch (agent) {
    case "researcher":
      return optional("MODEL_RESEARCHER", DEFAULT_MODEL);
    case "writer":
      return optional("MODEL_WRITER", DEFAULT_MODEL);
    case "editor":
      return optional("MODEL_EDITOR", DEFAULT_MODEL);
    case "auditor":
      return optional("MODEL_AUDITOR", DEFAULT_MODEL);
  }
}

/**
 * Domains the researcher may ground on.
 *
 * Restricting this is a quality control, not a formality. Fault code content
 * farms are abundant and well ranked; grounding on them would import their
 * errors and launder them as sourced fact, which is exactly the failure this
 * pipeline exists to avoid. Manufacturers, standards bodies and established
 * technical publishers only.
 */
export const RESEARCH_ALLOWED_DOMAINS = [
  // Engine and vehicle manufacturers
  "cummins.com",
  "quickserve.cummins.com",
  "demanddetroit.com",
  "detroitdiesel.com",
  "freightliner.com",
  "daimler-trucksnorthamerica.com",
  "paccar.com",
  "kenworth.com",
  "peterbilt.com",
  "volvotrucks.us",
  "macktrucks.com",
  "internationaltrucks.com",
  "cat.com",
  "isuzucv.com",
  "hino.com",
  // Aftertreatment, braking and component suppliers
  "bosch-mobility.com",
  "wabco-customercentre.com",
  "bendix.com",
  "haldex.com",
  "donaldson.com",
  // Standards, regulators and public technical record
  "sae.org",
  "nhtsa.gov",
  "static.nhtsa.gov",
  "epa.gov",
  // Diagnostic equipment vendors with published technical documentation
  "autel.com",
  "autel.us",
  "noregon.com",
  "snapon.com",
] as const;
