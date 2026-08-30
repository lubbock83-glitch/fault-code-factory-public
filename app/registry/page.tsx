import Link from "next/link";
import { getRegistry } from "../lib/queries";
import { Badge, Card, CodeChip, EmptyState, SectionTitle, StatusBadge } from "../components/ui";
import { AddCodeForm } from "./AddCodeForm";

export const dynamic = "force-dynamic";

/**
 * The code dictionary.
 *
 * One row per SPN x FMI x platform combination the pipeline may write about.
 * The source count is the column that matters: it is the difference between a
 * code that can be written and one that cannot, and seeing it here avoids
 * spending generation money to discover the same thing.
 */
export default async function RegistryPage() {
  const rows = await getRegistry();

  const researched = rows.filter((row) => row.source_count > 0).length;
  const written = rows.filter((row) => row.article_id).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-tight text-ink">
            Registry
          </h1>
          <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-dim">
            {rows.length} codes · {researched} with sources · {written} written. Codes
            are processed in demand-rank order, so a halted run still leaves the
            valuable pages done.
          </p>
        </div>
        <AddCodeForm />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No codes yet">
          Add a code above to exercise the pipeline end to end. For the real run, the
          registry gets filled in bulk &mdash; from an SPN dictionary, or from the
          unmet-demand list built out of what technicians actually search for on the
          live site.
        </EmptyState>
      ) : (
        <Card className="p-0">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline">
                {["Code", "Platform", "Identifies", "Sources", "Article"].map((heading) => (
                  <th
                    key={heading}
                    className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-hairline last:border-0">
                  <td className="px-5 py-3">
                    <CodeChip spn={row.spn_code} fmi={row.fmi_code} />
                  </td>
                  <td className="px-5 py-3 text-ink-dim">{row.engine_platform}</td>
                  <td className="max-w-md px-5 py-3 text-ink-dim">
                    {row.spn_description}
                  </td>
                  <td className="px-5 py-3">
                    {row.source_count > 0 ? (
                      <Badge tone="pass">{row.source_count}</Badge>
                    ) : (
                      // Stated rather than left blank. "No sources" is a
                      // finding - it means this code should not be written -
                      // and an empty cell reads as "not yet checked".
                      <Badge tone="neutral">none</Badge>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {row.article_id ? (
                      <Link href={`/review/${row.article_id}`} className="inline-block">
                        <StatusBadge status={row.article_status ?? "queued"} />
                      </Link>
                    ) : (
                      <span className="text-ink-faint">&mdash;</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <section>
        <SectionTitle hint="how to run the pipeline over these">Next step</SectionTitle>
        <Card>
          <p className="text-[13px] leading-relaxed text-ink-dim">
            Start the task runner with{" "}
            <code className="rounded bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink">
              npm run trigger:dev
            </code>{" "}
            and trigger <code className="font-mono text-ink">batch-generate</code>.
            Pass{" "}
            <code className="rounded bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink">
              {"{ \"limit\": 20, \"researchOnly\": true }"}
            </code>{" "}
            first: research output is durable and reusable, so gathering sources for the
            whole batch before writing anything means a code with no documentation costs
            one call rather than four.
          </p>
        </Card>
      </section>
    </div>
  );
}
