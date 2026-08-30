import Anthropic from "@anthropic-ai/sdk";
import { env, modelFor, RESEARCH_ALLOWED_DOMAINS, type AgentName } from "./env.js";

let client: Anthropic | undefined;

/** Lazy, for the same reason as the Supabase and Webflow clients. */
export function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

/** USD per million tokens. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Cost of one call, in dollars.
 *
 * Cache reads bill at roughly a tenth of the input rate and cache writes at
 * about 1.25x. Both are tracked because the shared reference block is identical
 * on every run, so cache behaviour is the difference between the input side of
 * this pipeline being trivial and being the largest line item.
 *
 * Unknown models cost 0 rather than throwing - a wrong number in a log is worth
 * less than a failed run.
 */
export function costUsd(model: string, usage: Anthropic.Usage): number {
  const price = PRICING[model];
  if (!price) return 0;

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  return (
    (usage.input_tokens * price.input +
      cacheRead * price.input * 0.1 +
      cacheWrite * price.input * 1.25 +
      usage.output_tokens * price.output) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

export interface AgentResult {
  text: string;
  model: string;
  costUsd: number;
  usage: Anthropic.Usage;
  stopReason: string | null;
}

export interface RunAgentOptions {
  agent: AgentName;
  /**
   * Stable instructions. Cached - so it must not contain timestamps, run ids or
   * anything else that varies per call, or the cache never hits and the input
   * saving evaporates silently.
   */
  system: string;
  /** Per-call content. Everything that varies belongs here, not in `system`. */
  prompt: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Give the agent Anthropic-hosted web search and fetch, domain-restricted. */
  withWebResearch?: boolean;
  maxSearches?: number;
}

/**
 * One agent turn.
 *
 * Always streamed. Output here runs long - a full diagnostic workflow plus
 * schema - and a non-streaming request at these token counts risks an HTTP
 * timeout that looks like a model failure but is not.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const model = modelFor(options.agent);
  const tools = options.withWebResearch ? researchTools(options.maxSearches) : undefined;

  try {
    const stream = anthropic().messages.stream({
      model,
      max_tokens: options.maxTokens ?? 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: options.effort ?? "high" },
      system: [
        {
          type: "text",
          text: options.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: options.prompt }],
      ...(tools ? { tools } : {}),
    });

    const message = await stream.finalMessage();

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return {
      text,
      model,
      costUsd: costUsd(model, message.usage),
      usage: message.usage,
      stopReason: message.stop_reason,
    };
  } catch (error) {
    // Most specific first. The distinction matters to the caller: a rate limit
    // is worth retrying, a bad request never is.
    if (error instanceof Anthropic.RateLimitError) {
      throw new Error(`${options.agent}: rate limited by the Anthropic API`, { cause: error });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error(
        `${options.agent}: ANTHROPIC_API_KEY is missing or invalid`,
        { cause: error },
      );
    }
    if (error instanceof Anthropic.BadRequestError) {
      throw new Error(`${options.agent}: bad request - ${error.message}`, { cause: error });
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`${options.agent}: API error ${error.status} - ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Server-side web search and fetch, restricted to the research allowlist.
 *
 * The allowlist is the whole point. Fault code content farms rank well and are
 * abundant; grounding on one would import its errors and re-publish them
 * wearing a citation, which is worse than having no citation at all.
 */
function researchTools(maxSearches = 6): Anthropic.ToolUnion[] {
  const allowed = [...RESEARCH_ALLOWED_DOMAINS];
  return [
    {
      type: "web_search_20260318",
      name: "web_search",
      max_uses: maxSearches,
      allowed_domains: allowed,
    },
    {
      type: "web_fetch_20260318",
      name: "web_fetch",
      // Fetch is allowed more uses than search: one search surfaces several
      // candidate documents and each is worth opening.
      max_uses: maxSearches * 2,
      allowed_domains: allowed,
      citations: { enabled: true },
    },
  ];
}

/**
 * Pull the first JSON object or array out of a model response.
 *
 * Models wrap JSON in prose or fences often enough that demanding clean output
 * costs more retries than parsing tolerantly does. Throws with a truncated
 * sample so a failure is diagnosable from the log alone.
 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new Error(`No JSON found in response: ${text.slice(0, 300)}`);
  }

  const opener = candidate[start];
  const closer = opener === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(closer);
  if (end <= start) {
    throw new Error(`Unbalanced JSON in response: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (error) {
    throw new Error(
      `Malformed JSON in response: ${candidate.slice(start, start + 300)}`,
      { cause: error },
    );
  }
}
