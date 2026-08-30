> **Public mirror.** Generated from a private repository by
> `scripts/export-public.mjs`, which copies an allowlist and then scans every
> copied byte for credential-shaped strings, aborting the export on a hit.
> No credentials or project identifiers appear anywhere in this tree - all
> configuration is read from the environment via `src/lib/env.ts`.
>
> This mirror has its own history and shares no commits with the private
> repository.

# Fault Code Factory

A research-and-generation pipeline that produces grounded reference pages for
SAE J1939 diagnostic fault codes, and syncs the approved ones into a Webflow CMS.

## What problem this solves

Programmatic SEO for technical reference content has one failure mode that
matters: asking a language model for "specific pin numbers and multimeter
settings" without giving it sources produces confident, plausible, **invented**
values. On commercial vehicles those are safety-relevant numbers, and a
plausible fabrication is worse than an obvious one because nobody catches it.

The defence here is structural rather than a line in a prompt:

1. A **researcher** agent searches a domain allowlist of manufacturers,
   standards bodies and established technical publishers, and records what it
   finds as rows in `grounding_sources` - each with a URL and verbatim snippet.
2. A **writer** agent may only assert what those rows support. With no sources,
   it refuses to write rather than filling the gap from memory.
3. An **auditor** agent extracts every checkable claim, marks each supported,
   unsupported or contradicted, and rewrites the article to remove the
   unsupported specifics while keeping the procedure intact.
4. Nothing reaches `approved` without a human. The database enforces this: a
   `CHECK` constraint makes it impossible to set that status on an article
   missing content, meta description, tool SKU or taxonomy tags.

A page that survives with most of its numbers stripped is a thin but honest
page. That is the intended outcome, not a degraded one.

## Architecture

```
topic_queue ──► fault_code_registry
                      │
                      ▼
            research-fault-code ──► grounding_sources
                      │
                      ▼
              generate-article
              writer ─► editor ─► auditor
                      │
                      ▼
            fault_code_articles (pending_review)
                      │
                      ▼
              human review console
                      │
                      ▼
                  approved ──► Webflow CMS
```

| Layer | Role |
|---|---|
| Supabase | System of record. Registry, sources, articles, review state |
| Anthropic API | The four agents. Server-side web search, domain-restricted |
| Trigger.dev | Orchestration, concurrency limits, scheduling |
| Webflow | Public rendering of approved articles |

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
npm run typecheck
```

Every credential **and** every project identifier lives in `.env`. Nothing is
hardcoded in `src/`, which is what makes this tree safe to publish without a
scrubbing step someone will eventually forget to run.

## Running

```bash
npm run trigger:dev        # local task runner
npm run export:public      # scrubbed copy for the public mirror
node scripts/dump-migrations.mjs   # pull applied schema back into the repo
```

## The review console

A Next.js app that runs locally against the production database. It is
deliberately **not deployed**: the Supabase secret key stays on one machine and
there is no hosted surface to authenticate, which is why the console has no
login. That tradeoff is only safe while the "not deployed" half stays true.

```bash
npm run dev     # http://localhost:3000
```

| Route | Purpose |
|---|---|
| `/` | Pipeline stats, research coverage, unmet search demand |
| `/review` | Queue, ordered by unsupported claim count |
| `/review/[id]` | Claim-by-claim verification, then the rendered article |
| `/registry` | The code dictionary, with per-code source counts |

The detail screen's layout is the argument. A reviewer given a wall of prose
skims it and approves, and the failure being guarded against — a confidently
worded, entirely invented pin voltage — is invisible to skimming, because
fabricated text reads exactly like sourced text. So claims come first, each
beside the source backing it, and the prose comes second. The job on that page
is verifying roughly eight facts, not proofreading an article. That is the
difference between reviewing 300 articles in four hours and not reviewing them
at all.

The article body renders through the same converter the Webflow sync uses, so
what gets approved is what ships. Reviewing a different rendering than the one
that publishes would mean approving an artefact nobody actually looked at.

Only one component in the console ships JavaScript to the browser — the decision
bar. Everything else is a server component.

## Model configuration

Each agent's model is set independently in `.env`, defaulting to
`claude-opus-5`.

### Measured cost, not estimated

From the first real run, all four agents on `claude-opus-5`:

| Stage | Per code |
|---|---|
| Research (web search + fetch, ~15-35 sources) | ~$0.77 |
| Generation (write → edit → audit) | ~$0.78 |
| **Total** | **~$1.55** |

That is roughly **2.3x** the pre-build estimate of $0.66. The forecast was wrong
in a specific way worth recording: it treated research as a single cheap call,
when in practice the researcher runs several searches and opens a dozen or more
documents, and those fetched documents are input tokens.

At that rate a 300-article run is around **$465**.

Research is also the slow half - five to ten minutes per code, because it is
genuinely reading manufacturer documentation. Sequentially that is 30+ hours for
300 codes; the Trigger.dev queues cap concurrency at 5, bringing it to roughly
six or seven.

Both halves are worth knowing before committing to a batch, and both are why
`researchOnly: true` exists: research output is durable, so it can be gathered
once and written from repeatedly while prompts are still changing.

The **auditor is the exception**. It is the gate that catches an invented pin
voltage, and its failure mode is silent: a weaker auditor does not error, it
approves things it should not.

## Schema notes

`taxonomy_tags` (jsonb on the article) and the `fault_code_taxonomy` join table
are two stages of one pipeline, not two copies of one fact. The writer emits tag
*names*; a promotion step resolves them to taxonomy *rows*.

`pinout_test_data` is deliberately **not** part of the approval `CHECK`
constraint. Requiring it would pressure the pipeline into inventing pin voltages
for the pages where no public source provides them - the exact failure this
design exists to prevent.

Three tables - `fault_code_registry`, `grounding_sources` and `topic_queue` -
have RLS enabled with no policies. That is intentional: RLS on with zero
policies denies all anonymous access, which is correct for back-office data. The
Supabase linter flags it as INFO because it is often a mistake. Here it is not,
and adding a policy to silence it would weaken the configuration.

`search_fault_codes` has a **frozen signature**. A public site calls it directly
with a publishable key; its name, parameters and return columns must not change.
The article table's `title` is aliased back to `name` in its return for exactly
this reason.
