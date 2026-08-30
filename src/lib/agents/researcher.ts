import { runAgent, extractJson, type AgentResult } from "../anthropic.js";
import { REFERENCE_BLOCK } from "./shared.js";
import type { ClaimType, GroundingSourceDraft, RegistryRow } from "../supabase.js";

const SYSTEM = `${REFERENCE_BLOCK}

# Your role: Researcher

You gather source material. You do not write articles and you do not draw
conclusions beyond what a document states.

Search the permitted domains for published technical material about the fault
code you are given, open the promising results, and extract discrete factual
claims. Each claim must be traceable to one URL you actually opened.

## Claim types

- "definition"  - what the SPN identifies; what the FMI failure mode means here.
- "symptom"     - observable behaviour: lamp, message, driveability, smoke, noise.
- "procedure"   - a diagnostic or repair step a source describes.
- "threshold"   - any measurable figure: voltage, resistance, pressure, pin
                  number, temperature, time, distance. The highest-value type
                  and the one most often absent. Never infer one.
- "severity"    - derate, inducement, shutdown or limp-home behaviour.
- "hardware"    - tooling or capability a source says the job requires.

## Rules

1. Every claim needs a real URL you opened. Never cite a URL you only saw in a
   search result summary without fetching it.
2. "snippet" must be text that genuinely appears in the source, at most about
   600 characters. It exists to prove the source said this. Do not paraphrase
   into the snippet and do not stitch together separated sentences.
3. "claim_value" is your own concise statement of the fact, in your words.
4. Do not extract a claim the source does not support. If a source discusses a
   related but different SPN or a different engine platform, either skip it or
   record it with low confidence and say so in claim_value.
5. **Returning an empty array is a correct and acceptable result.** Many
   individual SPN/FMI/platform combinations have no public technical
   documentation. Reporting that honestly is useful; padding the list with
   generic filler or half-relevant material is not, because downstream this
   becomes a page a technician relies on.
6. confidence is 0 to 1: how directly the source supports the claim for THIS
   specific code on THIS specific platform. A general article about NOx sensors
   supporting a claim about one particular SPN is perhaps 0.4. An OEM document
   naming the exact code is 0.9.

## Output

Return ONLY a JSON array. No prose before or after.

[
  {
    "source_url": "https://...",
    "source_domain": "example.com",
    "source_title": "Page title, or null",
    "snippet": "Verbatim text from the source.",
    "claim_type": "definition",
    "claim_value": "Your concise statement of the fact.",
    "confidence": 0.8
  }
]

An empty array is written as: []`;

const VALID_CLAIM_TYPES: readonly ClaimType[] = [
  "definition",
  "symptom",
  "procedure",
  "threshold",
  "severity",
  "hardware",
];

interface RawClaim {
  source_url?: unknown;
  source_domain?: unknown;
  source_title?: unknown;
  snippet?: unknown;
  claim_type?: unknown;
  claim_value?: unknown;
  confidence?: unknown;
}

export interface ResearchOutcome {
  sources: GroundingSourceDraft[];
  result: AgentResult;
  /** Claims the model returned that failed validation, kept for the run log. */
  rejected: string[];
}

export async function research(registry: RegistryRow): Promise<ResearchOutcome> {
  const prompt = `Research this fault code.

SPN: ${registry.spn_code}
FMI: ${registry.fmi_code}
Engine platform: ${registry.engine_platform}
SPN describes: ${registry.spn_description}
FMI describes: ${registry.fmi_description}

Search for published technical material covering this code on this platform.
Prioritise, in order:

1. Material naming this exact SPN and FMI on this exact platform.
2. Material naming this SPN on this platform with a different FMI.
3. Manufacturer documentation for the component this SPN identifies.

Pay particular attention to anything giving measurable values - pin
assignments, expected voltages, resistances, derate thresholds. Those are the
claims worth the most and the ones you must never supply from your own
knowledge.

Return the JSON array.`;

  const result = await runAgent({
    agent: "researcher",
    system: SYSTEM,
    prompt,
    withWebResearch: true,
    maxSearches: 6,
    maxTokens: 24000,
  });

  const raw = extractJson<RawClaim[]>(result.text);
  if (!Array.isArray(raw)) {
    throw new Error(`Researcher returned ${typeof raw}, expected an array`);
  }

  const sources: GroundingSourceDraft[] = [];
  const rejected: string[] = [];

  for (const claim of raw) {
    const problem = validate(claim);
    if (problem) {
      rejected.push(`${problem}: ${JSON.stringify(claim).slice(0, 200)}`);
      continue;
    }

    const url = String(claim.source_url);
    sources.push({
      registry_id: registry.id,
      source_url: url,
      source_domain: String(claim.source_domain ?? domainOf(url)),
      source_title: claim.source_title == null ? null : String(claim.source_title),
      // Hard-truncated rather than rejected: the column caps at 1200, and losing
      // a claim over an over-long quote helps nobody.
      snippet: String(claim.snippet).slice(0, 1200),
      claim_type: claim.claim_type as ClaimType,
      claim_value: String(claim.claim_value),
      confidence: typeof claim.confidence === "number" ? clamp01(claim.confidence) : null,
    });
  }

  return { sources, result, rejected };
}

function validate(claim: RawClaim): string | null {
  if (typeof claim.source_url !== "string" || !/^https?:\/\//i.test(claim.source_url)) {
    return "missing or non-http source_url";
  }
  if (typeof claim.snippet !== "string" || claim.snippet.trim().length < 20) {
    return "snippet missing or too short to evidence anything";
  }
  if (typeof claim.claim_value !== "string" || claim.claim_value.trim().length === 0) {
    return "missing claim_value";
  }
  if (!VALID_CLAIM_TYPES.includes(claim.claim_type as ClaimType)) {
    return `unknown claim_type ${String(claim.claim_type)}`;
  }
  return null;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
