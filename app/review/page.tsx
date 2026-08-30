import Link from "next/link";
import { getReviewQueue } from "../lib/queries";
import {
  Badge,
  Card,
  CodeChip,
  EmptyState,
  SeverityBadge,
  StatusBadge,
} from "../components/ui";

export const dynamic = "force-dynamic";

const FILTERS = [
  { value: "pending_review", label: "Pending review" },
  { value: "failed", label: "Failed audit" },
  { value: "approved", label: "Approved" },
  { value: "all", label: "All" },
];

/**
 * The review queue.
 *
 * Ordered by unsupported claim count, highest first - see getReviewQueue. The
 * ordering is the design: attention is the scarce resource in this system, and
 * spending it where fabrication is most likely beats working through in
 * whatever order things happened to be generated.
 *
 * In Next 16 searchParams arrives as a promise, so the component awaits it.
 */
export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = params.status ?? "pending_review";
  const items = await getReviewQueue(status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-tight text-ink">
            Review queue
          </h1>
          <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-dim">
            Sorted by unsupported claims, most first. Work top-down and the riskiest
            pages get your sharpest attention.
          </p>
        </div>

        <nav className="flex flex-wrap gap-1.5">
          {FILTERS.map((filter) => {
            const active = filter.value === status;
            return (
              <Link
                key={filter.value}
                href={`/review?status=${filter.value}`}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                  active
                    ? "bg-accent text-canvas"
                    : "bg-inset text-ink-dim hover:text-ink"
                }`}
              >
                {filter.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={
            status === "pending_review"
              ? "Nothing waiting for review"
              : "No articles with this status"
          }
        >
          {status === "pending_review"
            ? "Every generated article has been decided on. Run the batch task to produce more, or check the failed queue for articles the auditor rejected."
            : "Try another filter, or run the pipeline to generate articles."}
        </EmptyState>
      ) : (
        <Card className="p-0">
          <ul>
            {items.map((item) => (
              <li key={item.id} className="border-b border-hairline last:border-0">
                <Link
                  href={`/review/${item.id}`}
                  className="block px-5 py-4 transition-colors hover:bg-raised"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <CodeChip spn={item.spn_code} fmi={item.fmi_code} />
                    <SeverityBadge severity={item.severity} />
                    <StatusBadge status={item.status} />

                    {/* The number that decides whether this row needs care.
                        Zero is stated rather than hidden: "0 unsupported" is
                        information, and an absent badge would read as "not
                        checked" instead of "checked and clean". */}
                    {item.unsupported_count > 0 ? (
                      <Badge tone="fail">
                        {item.unsupported_count} unsupported
                      </Badge>
                    ) : item.claim_count > 0 ? (
                      <Badge tone="pass">{item.claim_count} claims verified</Badge>
                    ) : null}

                    <span className="ml-auto tabular font-mono text-[11px] text-ink-faint">
                      {item.word_count} words
                      {item.cost_usd != null ? ` · $${item.cost_usd.toFixed(3)}` : ""}
                    </span>
                  </div>

                  <div className="mt-2 font-display text-[15px] font-semibold leading-snug text-ink">
                    {item.title}
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
                    <span>{item.engine_platform}</span>
                    {item.model_used ? (
                      <span className="font-mono">{item.model_used}</span>
                    ) : null}
                    <span>{new Date(item.updated_at).toLocaleString()}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
