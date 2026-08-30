/**
 * Prove the three external services are reachable before a batch is launched.
 *
 * A batch that fails on its fortieth article because a token was wrong has
 * already spent real money and left the database half-populated. This costs a
 * fraction of a cent and a few seconds, and it checks the things that actually
 * go wrong: a mistyped key, a revoked token, a model id that no longer exists.
 *
 * Usage: node scripts/smoke-test.mjs
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { WebflowClient } from "webflow-api";

// Loaded by hand rather than with dotenv: this script runs before anything else
// and should not depend on the pipeline's own module graph resolving correctly.
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match?.[1] && !process.env[match[1]]) process.env[match[1]] = (match[2] ?? "").trim();
}

let failures = 0;

const check = async (name, fn) => {
  process.stdout.write(`  ${name.padEnd(28)}`);
  try {
    console.log(await fn());
  } catch (error) {
    failures++;
    console.log(`FAILED - ${error instanceof Error ? error.message : String(error)}`);
  }
};

console.log("\nSmoke test\n");

await check("Anthropic API", async () => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.MODEL_WRITER || "claude-opus-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
  });
  const text = response.content.find((b) => b.type === "text")?.text.trim() ?? "";
  return `ok - ${response.model} replied "${text}"`;
});

await check("Anthropic web search", async () => {
  // The researcher's single most important capability. Verified separately
  // because a working API key does not imply the server-side tools are enabled
  // for this account, and that difference only shows up mid-batch otherwise.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.MODEL_RESEARCHER || "claude-opus-5",
    max_tokens: 2048,
    tools: [
      {
        type: "web_search_20260318",
        name: "web_search",
        max_uses: 1,
        allowed_domains: ["sae.org"],
      },
    ],
    messages: [
      { role: "user", content: "Search sae.org for J1939. Then reply with just: ready" },
    ],
  });
  const used = response.content.some((b) => b.type === "server_tool_use");
  return used ? "ok - search tool executed" : "ok - key valid, but the model did not invoke search";
});

await check("Supabase", async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });
  const { count, error } = await db
    .from("fault_code_registry")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return `ok - registry reachable, ${count} codes`;
});

await check("Webflow", async () => {
  const wf = new WebflowClient({ accessToken: process.env.WEBFLOW_TOKEN });
  const page = await wf.collections.items.listItems(
    process.env.WEBFLOW_COLLECTION_HARDWARE,
    { limit: 1 },
  );
  return `ok - hardware collection reachable, ${page.pagination?.total ?? "?"} products`;
});

console.log(
  failures === 0
    ? "\nAll services reachable.\n"
    : `\n${failures} check(s) failed - fix before running a batch.\n`,
);

process.exit(failures === 0 ? 0 : 1);
