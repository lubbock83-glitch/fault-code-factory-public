import { runAgent, extractJson, type AgentResult } from "../anthropic.js";
import { REFERENCE_BLOCK, SEVERITY_GUIDANCE } from "./shared.js";
import type { CatalogueTool } from "../webflow.js";
import type {
  GroundingSourceRow,
  PinoutEntry,
  RegistryRow,
  Severity,
} from "../supabase.js";

const SYSTEM = `${REFERENCE_BLOCK}

${SEVERITY_GUIDANCE}

# Your role: Writer

You draft the diagnostic reference page for one fault code, working only from
the sources supplied to you.

## Structure

Follow this shape, omitting any section the sources cannot support:

1. **What this code means** - what the SPN identifies, what the FMI failure mode
   means for that component, in two or three sentences.
2. **Symptoms** - what the driver or technician actually observes.
3. **Severity and derate behaviour** - only if a source establishes it. If none
   does, omit the section rather than speculating.
4. **Diagnostic sequence** - ordered steps, cheapest and most likely first.
   Verify the fault is active before anything else; a stored historical code
   from a previous repair sends people chasing a fault that is not there.
5. **Common causes** - only causes a source attributes to this code.
6. **What it takes to clear it** - whether bi-directional capability or a
   specific tool class is genuinely required.

## Length

Long enough to be useful, short enough to be read mid-job. Typically 600-1100
words. Do not pad to hit a length: a thin, honest page beats a padded one, and
padding is precisely what marks a page as machine-generated filler.

## pinout_test_data

Include an entry ONLY where a source states an actual pin and an actual expected
value. Every entry carries the URL of the source that stated it. When no source
provides pinout data, return an empty array - this is common and correct.

## Choosing the recommended tool

You are given the tool catalogue. Pick the ONE product a technician actually
needs to diagnose and clear this specific fault, and return its SKU verbatim.

Judge it on capability, not on price. The question is what the job requires:

- Does clearing this fault need bi-directional control - a forced regen, an
  injector cutout, a component actuation? Then a read-and-clear code reader
  cannot finish the job and must not be recommended.
- Does it only need codes read and cleared? Then recommending the most
  expensive tablet is overselling, and a technician who notices will stop
  trusting the rest of the page.
- Does the fault live on a trailer or on off-highway equipment? Then the
  connector adapter matters more than the tablet.

Recommending the wrong tool is not a neutral error. These pages are read by
people deciding what to buy, and a recommendation that does not match the work
is the fastest way to lose their trust in the diagnostic content too.

## Output

Return ONLY a JSON object:

{
  "title": "SPN <n> FMI <n>: <Platform> <Plain description of the failure>",
  "slug": "spn-<n>-fmi-<n>-<platform-slug>-<short-description>",
  "content_markdown": "## What this code means\\n\\n...",
  "meta_description": "150-160 characters, specific to this code, no boilerplate.",
  "symptom_keywords": "Comma-separated shop-floor phrasing a tech would search",
  "severity": "Informational | Active Fault | Derate Imminent | Shutdown Risk",
  "recommended_tool_sku": "EXACT-SKU-FROM-THE-CATALOGUE",
  "taxonomy_tags": ["Engine platform name", "Subsystem", "Protocol"],
  "pinout_test_data": [
    { "pin": "A", "circuit": "Sensor supply", "expected": "...", "source_url": "https://..." }
  ],
  "faq": [
    { "question": "...", "answer": "..." }
  ]
}

The slug must be lowercase, hyphen-separated, alphanumeric only, and under 100
characters. FAQ entries must be questions a technician would actually ask, with
answers drawn from the sources - two to four of them, or an empty array if the
sources do not support any.`;

export interface WriterDraft {
  title: string;
  slug: string;
  content_markdown: string;
  meta_description: string;
  symptom_keywords: string;
  severity: Severity;
  recommended_tool_sku: string | null;
  taxonomy_tags: string[];
  pinout_test_data: PinoutEntry[];
  faq: Array<{ question: string; answer: string }>;
}

export interface WriteOutcome {
  draft: WriterDraft;
  result: AgentResult;
}

const SEVERITIES: readonly Severity[] = [
  "Informational",
  "Active Fault",
  "Derate Imminent",
  "Shutdown Risk",
];

export async function write(
  registry: RegistryRow,
  sources: GroundingSourceRow[],
  catalogue: CatalogueTool[],
): Promise<WriteOutcome> {
  if (sources.length === 0) {
    // Refusing here rather than in the task keeps the rule with the thing it
    // constrains. A page written from no sources is the exact artefact this
    // pipeline exists to not produce.
    throw new Error(
      `No grounding sources for SPN ${registry.spn_code} FMI ${registry.fmi_code} ` +
        `(${registry.engine_platform}). Refusing to write an ungrounded article.`,
    );
  }

  const prompt = `Write the reference page for this fault code.

SPN: ${registry.spn_code}
FMI: ${registry.fmi_code}
Engine platform: ${registry.engine_platform}
SPN describes: ${registry.spn_description}
FMI describes: ${registry.fmi_description}

## Sources

${formatSources(sources)}

## Tool catalogue

${formatCatalogue(catalogue)}

Every factual claim you make must be supported by one of the sources above.
Where the sources are silent, describe the check without the figure. Do not
supply a value from your own knowledge of similar circuits.

Return the JSON object.`;

  const result = await runAgent({
    agent: "writer",
    system: SYSTEM,
    prompt,
    maxTokens: 32000,
  });

  const raw = extractJson<Partial<WriterDraft>>(result.text);

  const draft: WriterDraft = {
    title: requireString(raw.title, "title"),
    slug: slugify(requireString(raw.slug, "slug")),
    content_markdown: requireString(raw.content_markdown, "content_markdown"),
    meta_description: requireString(raw.meta_description, "meta_description"),
    symptom_keywords: typeof raw.symptom_keywords === "string" ? raw.symptom_keywords : "",
    severity: SEVERITIES.includes(raw.severity as Severity)
      ? (raw.severity as Severity)
      : "Active Fault",
    // Validated against the catalogue rather than trusted. A hallucinated SKU
    // would sync to Webflow as an empty hardware reference - a silently missing
    // conversion link that looks fine in the API response.
    recommended_tool_sku:
      typeof raw.recommended_tool_sku === "string" &&
      catalogue.some((tool) => tool.sku === raw.recommended_tool_sku)
        ? raw.recommended_tool_sku
        : null,
    taxonomy_tags: Array.isArray(raw.taxonomy_tags)
      ? raw.taxonomy_tags.filter((t): t is string => typeof t === "string" && t.length > 0)
      : [],
    // Silently drop any pinout entry without a source URL. The writer is told
    // to attach one; when it does not, the entry is unverifiable by definition
    // and the auditor would strip it anyway.
    pinout_test_data: Array.isArray(raw.pinout_test_data)
      ? raw.pinout_test_data.filter(isSourcedPinout)
      : [],
    faq: Array.isArray(raw.faq)
      ? raw.faq.filter(
          (f): f is { question: string; answer: string } =>
            typeof f?.question === "string" && typeof f?.answer === "string",
        )
      : [],
  };

  return { draft, result };
}

function formatCatalogue(catalogue: CatalogueTool[]): string {
  if (catalogue.length === 0) return "(no catalogue supplied)";
  return catalogue
    .map((tool) =>
      [
        `- SKU: ${tool.sku}`,
        `  Name: ${tool.name}`,
        tool.capabilities ? `  Bi-directional: ${tool.capabilities}` : "  Bi-directional: none - read and clear only",
        tool.coverage ? `  Coverage: ${tool.coverage}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function formatSources(sources: GroundingSourceRow[]): string {
  return sources
    .map((source, index) => {
      const confidence =
        source.confidence == null ? "unrated" : source.confidence.toFixed(2);
      return [
        `### Source ${index + 1} - ${source.claim_type} (confidence ${confidence})`,
        `URL: ${source.source_url}`,
        source.source_title ? `Title: ${source.source_title}` : null,
        `Claim: ${source.claim_value}`,
        `Quoted: "${source.snippet}"`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function isSourcedPinout(entry: unknown): entry is PinoutEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.pin === "string" &&
    typeof candidate.circuit === "string" &&
    typeof candidate.expected === "string" &&
    typeof candidate.source_url === "string" &&
    /^https?:\/\//i.test(candidate.source_url)
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Writer output is missing required field: ${field}`);
  }
  return value.trim();
}

/** Webflow rejects anything outside [a-z0-9-], so normalise rather than trust. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
}
