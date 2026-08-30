import Link from "next/link";
import { getPipelineStats, getUnmetDemand } from "./lib/queries";
import { Card, EmptyState, Meter, SectionTitle, Stat } from "./components/ui";

/**
 * Pipeline overview.
 *
 * Answers the three questions worth asking before starting a session: how much
 * of the registry has been researched, what is waiting on a human, and what has
 * this cost so far.
 *
 * `force-dynamic` because every number here changes as tasks run in the
 * background. A cached dashboard telling a reviewer there is nothing to do,
 * while forty articles sit in the queue, is worse than a slightly slower page.
 */
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [stats, unmetDemand] = await Promise.all([getPipelineStats(), getUnmetDemand()]);

  const pendingReview = stats.byStatus.pending_review ?? 0;
  const failed = stats.byStatus.failed ?? 0;
  const approved = (stats.byStatus.approved ?? 0) + (stats.byStatus.published ?? 0);
  const totalArticles = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-display text-[26px] font-bold tracking-tight text-ink">
          Pipeline overview
        </h1>
        <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-dim">
          Research runs first and its output is durable, so sources can be inspected
          before any generation spend. Nothing reaches the public site without passing
          through review.
        </p>
      </div>

      <section>
        <SectionTitle hint="what is waiting on you">Queue</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Pending review"
            value={pendingReview}
            tone={pendingReview > 0 ? "warn" : "neutral"}
            sub={pendingReview > 0 ? "needs a human decision" : "nothing waiting"}
          />
          <Stat
            label="Approved"
            value={approved}
            tone={approved > 0 ? "pass" : "neutral"}
            sub="cleared to sync to Webflow"
          />
          <Stat
            label="Failed audit"
            value={failed}
            sub="caught before publication"
          />
          <Stat
            label="Total spend"
            value={`$${stats.totalCostUsd.toFixed(2)}`}
            sub={
              totalArticles > 0
                ? `$${stats.avgCostPerArticle.toFixed(3)} per article`
                : "no articles generated yet"
            }
          />
        </div>
      </section>

      <section>
        <SectionTitle hint="grounding material gathered so far">Research coverage</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="space-y-5">
              <Meter
                label="Registry codes with at least one source"
                value={stats.codesWithSources}
                total={stats.registryTotal}
              />
              <Meter
                label="Registry codes processed"
                value={stats.registryTotal - stats.registryUnprocessed}
                total={stats.registryTotal}
              />
            </div>
            <p className="mt-5 border-t border-hairline pt-4 text-[13px] leading-relaxed text-ink-dim">
              A code with no sources is not a failure to fix. Many individual
              SPN/FMI/platform combinations have no public technical documentation, and
              the correct outcome is that no page gets written for them &mdash; a page
              built on nothing is exactly the artefact this pipeline exists to avoid.
            </p>
          </Card>

          <div className="space-y-4">
            <Stat label="Registry codes" value={stats.registryTotal} sub="in the dictionary" />
            <Stat
              label="Grounding sources"
              value={stats.sourcesTotal}
              sub="cited claims stored"
            />
          </div>
        </div>
      </section>

      <section>
        <SectionTitle hint="searches on the live site that returned nothing">
          Unmet demand
        </SectionTitle>

        {unmetDemand.length === 0 ? (
          <EmptyState title="No unmet searches recorded yet">
            Once the site search logs queries, anything a technician looked for and did
            not find shows up here, ranked by how many people asked. It is the
            highest-signal topic list available &mdash; demonstrated demand rather than
            a guess about what to write next.
          </EmptyState>
        ) : (
          <Card className="p-0">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-hairline">
                  <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                    Query
                  </th>
                  <th className="w-32 px-5 py-3 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                    Times asked
                  </th>
                </tr>
              </thead>
              <tbody>
                {unmetDemand.map((row) => (
                  <tr key={row.q} className="border-b border-hairline last:border-0">
                    <td className="px-5 py-2.5 font-mono text-ink">{row.q}</td>
                    <td className="tabular px-5 py-2.5 text-right text-ink-dim">
                      {row.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {stats.registryTotal === 0 ? (
        <EmptyState title="The registry is empty" action={{ href: "/registry", label: "Open the registry" }}>
          Nothing can be researched or written until there are codes to work from. Seed
          the registry with SPN/FMI/platform combinations, then run the batch task to
          gather sources.
        </EmptyState>
      ) : null}

      <footer className="border-t border-hairline pt-5 text-[12px] leading-relaxed text-ink-faint">
        <p>
          Tasks run through Trigger.dev, not from this interface. Start them with{" "}
          <code className="rounded bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink-dim">
            npm run trigger:dev
          </code>{" "}
          and trigger <code className="font-mono text-ink-dim">batch-generate</code> from
          the dashboard. This console is for the decisions only a person can make.
        </p>
        <p className="mt-2">
          <Link href="/review" className="text-accent hover:underline">
            Go to the review queue
          </Link>
        </p>
      </footer>
    </div>
  );
}
