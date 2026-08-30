import { runAgent, extractJson, type AgentResult } from "../anthropic.js";
import { REFERENCE_BLOCK } from "./shared.js";
import type {
  ClaimType,
  GroundingSourceRow,
  PinoutEntry,
  ProvenanceAudit,
  ProvenanceClaim,
} from "../supabase.js";

const SYSTEM = `${REFERENCE_BLOCK}

# Your role: Auditor

You are the last gate before a page reaches a technician. Assume the draft in
front of you contains at least one confidently-worded claim that no source
supports, because that is the characteristic failure of the process that
produced it. Your job is to find it and remove it.

You are not a proofreader and you are not assessing whether the page reads well.

## Step 1 - Extract every checkable claim

A checkable claim is any assertion that could be wrong in a way a technician
would discover with a meter, a wiring diagram or a road test. In particular,
every one of these:

- A voltage, resistance, current, pressure, temperature or frequency.
- A pin letter or number, connector position, or wire colour.
- A derate percentage, inducement distance, speed limit or countdown time.
- A named component, part number or module.
- A claim that the fault does or does not trigger derate or shutdown.
- A claim that a specific tool capability is required.

Prose that describes a procedure without asserting a value is not a checkable
claim. "Measure supply voltage at the connector" asserts nothing; "expect 12V at
pin A" asserts two things.

## Step 2 - Verify each against the supplied sources

- "supported"   - a source states this, for this code and this platform.
- "unsupported" - no source states it. Includes claims that are probably true
                  and claims that are true of the component in general but which
                  no supplied source actually makes about this code.
- "contradicted"- a source states something different.

Being plausible is not being supported. A value you recognise as typical for
this circuit type is UNSUPPORTED unless a supplied source contains it. This is
the single judgement that matters most in this role; do not soften it.

## Step 3 - Repair the markdown

Produce corrected_markdown with every unsupported and contradicted specific
removed. Do not delete whole sections - rewrite the sentence so the procedure
survives without the invented figure.

  Before: "Measure supply voltage at pin A. Expect 11.5-13.5V DC."
  After:  "Measure supply voltage at the sensor supply circuit and compare it
           against the platform specification in the OEM service literature."

The step is still worth doing. Only the fabricated precision goes.

## Step 4 - Boilerplate check

Judge whether this page says anything specific to THIS code on THIS platform. A
page that would read identically with a different SPN substituted has no reason
to exist and fails the audit regardless of whether its claims are supported.

## Verdict

"fail" if any of:
- A contradicted claim remains.
- After repair, the page is generic enough to fail the boilerplate check.
- Fewer than two supported claims specific to this code.

Otherwise "pass". A page that passes with most specifics stripped is a thin but
honest page - that is a pass, and a human reviewer will make the final call.

## Output

Return ONLY a JSON object:

{
  "claims": [
    { "claim": "Expect 11.5-13.5V at pin A",
      "claim_type": "threshold",
      "source_url": null,
      "verdict": "unsupported" }
  ],
  "stripped": ["Short description of each removed claim"],
  "corrected_markdown": "The repaired article.",
  "boilerplate_risk": "low | medium | high",
  "verdict": "pass | fail",
  "notes": "One or two sentences for the human reviewer, or null."
}`;

export interface AuditOutcome {
  audit: ProvenanceAudit;
  correctedMarkdown: string;
  boilerplateRisk: "low" | "medium" | "high";
  result: AgentResult;
}

interface RawAudit {
  claims?: unknown;
  stripped?: unknown;
  corrected_markdown?: unknown;
  boilerplate_risk?: unknown;
  verdict?: unknown;
  notes?: unknown;
}

export async function audit(
  markdown: string,
  pinouts: PinoutEntry[],
  sources: GroundingSourceRow[],
): Promise<AuditOutcome> {
  const prompt = `Audit this draft.

## Sources available to the writer

${sources
  .map(
    (s, i) =>
      `### Source ${i + 1} - ${s.claim_type}\nURL: ${s.source_url}\nClaim: ${s.claim_value}\nQuoted: "${s.snippet}"`,
  )
  .join("\n\n")}

## Structured pinout data attached to the draft

${
  pinouts.length === 0
    ? "(none)"
    : pinouts
        .map((p) => `- pin ${p.pin} / ${p.circuit} / expected ${p.expected} / cited ${p.source_url}`)
        .join("\n")
}

## Draft

${markdown}

Return the JSON object.`;

  const result = await runAgent({
    agent: "auditor",
    system: SYSTEM,
    prompt,
    maxTokens: 32000,
    // The judgement this agent makes is the one with real-world consequences,
    // so it runs at maximum deliberation regardless of what the others use.
    effort: "max",
  });

  const raw = extractJson<RawAudit>(result.text);

  const claims: ProvenanceClaim[] = Array.isArray(raw.claims)
    ? raw.claims.filter(isClaim).map((c) => ({
        claim: String(c.claim),
        claim_type: c.claim_type as ClaimType,
        source_url: typeof c.source_url === "string" ? c.source_url : null,
        verdict: c.verdict as ProvenanceClaim["verdict"],
      }))
    : [];

  const stripped = Array.isArray(raw.stripped)
    ? raw.stripped.filter((s): s is string => typeof s === "string")
    : [];

  const corrected =
    typeof raw.corrected_markdown === "string" && raw.corrected_markdown.trim().length > 0
      ? raw.corrected_markdown.trim()
      : markdown;

  const unsupported = claims.filter(
    (c) => c.verdict === "unsupported" || c.verdict === "contradicted",
  ).length;

  // The model's own verdict is accepted only when it says "fail". A "pass"
  // still has to survive the mechanical checks below, because an auditor that
  // has drifted into agreeableness fails by approving, never by erroring.
  const modelFailed = raw.verdict === "fail";
  const contradicted = claims.some((c) => c.verdict === "contradicted");
  const boilerplateRisk = normaliseRisk(raw.boilerplate_risk);
  const supportedSpecifics = claims.filter((c) => c.verdict === "supported").length;

  const verdict: ProvenanceAudit["verdict"] =
    modelFailed || contradicted || boilerplateRisk === "high" || supportedSpecifics < 2
      ? "fail"
      : "pass";

  return {
    audit: {
      claims,
      unsupported_count: unsupported,
      stripped,
      verdict,
      notes: typeof raw.notes === "string" ? raw.notes : null,
    },
    correctedMarkdown: corrected,
    boilerplateRisk,
    result,
  };
}

function isClaim(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.claim === "string" &&
    ["supported", "unsupported", "contradicted"].includes(String(c.verdict))
  );
}

function normaliseRisk(value: unknown): "low" | "medium" | "high" {
  // Anything unrecognised is treated as the worst case rather than the best.
  return value === "low" || value === "medium" || value === "high" ? value : "high";
}
