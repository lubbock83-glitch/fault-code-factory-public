import Link from "next/link";

/**
 * Shared presentational pieces.
 *
 * Hand-written rather than pulled from shadcn/ui, which the original spec
 * called for. The console needs perhaps six components and already has a fixed
 * palette taken from the live site; shadcn would bring a CLI step, a component
 * registry and its own theming layer to reimplement a badge. The tradeoff would
 * flip if this grew dialogs, comboboxes or a date picker - none of which a
 * review queue needs.
 *
 * These are all server components. Nothing here holds state, so none of them
 * needs to ship JavaScript to the browser.
 */

// ---------------------------------------------------------------------------

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-hairline bg-surface p-5 ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-4 flex items-baseline gap-3">
      <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
        {children}
      </h2>
      {hint ? <span className="text-[13px] text-ink-faint">{hint}</span> : null}
    </div>
  );
}

/**
 * A single headline number.
 *
 * `tabular` matters more than it looks: these sit in a row and the eye compares
 * them horizontally, which proportional digits make harder than it needs to be.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "neutral" | "pass" | "warn" | "fail";
}) {
  const toneClass = {
    neutral: "text-ink",
    pass: "text-pass",
    warn: "text-warn",
    fail: "text-fail",
  }[tone];

  return (
    <Card>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className={`tabular mt-2 font-display text-[28px] font-bold leading-none ${toneClass}`}>
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-[12px] text-ink-faint">{sub}</div> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------

type BadgeTone = "neutral" | "pass" | "warn" | "fail" | "accent";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "bg-inset text-ink-dim",
    pass: "bg-pass-dim text-pass",
    warn: "bg-warn-dim text-warn",
    fail: "bg-fail-dim text-fail",
    accent: "bg-accent/12 text-accent",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Pipeline status as a badge.
 *
 * `failed` is amber, not red. A failed audit is the system working correctly -
 * it caught something - and colouring it as an error trains a reviewer to read
 * the most valuable rows in the queue as noise to clear.
 */
export function StatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "approved" || status === "published"
      ? "pass"
      : status === "failed"
        ? "warn"
        : status === "pending_review"
          ? "accent"
          : "neutral";

  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}

/**
 * Severity as a badge.
 *
 * Only the two levels that actually strand a truck get a loud colour. Most
 * codes are not derate or shutdown events, and if every severity looked urgent
 * the field would carry no information.
 */
export function SeverityBadge({ severity }: { severity: string }) {
  const tone: BadgeTone =
    severity === "Shutdown Risk"
      ? "fail"
      : severity === "Derate Imminent"
        ? "warn"
        : severity === "Active Fault"
          ? "accent"
          : "neutral";

  return <Badge tone={tone}>{severity}</Badge>;
}

export function CodeChip({ spn, fmi }: { spn: number; fmi: number }) {
  return (
    <span className="tabular inline-flex items-center gap-1.5 rounded-md bg-inset px-2 py-1 font-mono text-[11px] text-ink">
      <span className="text-ink-faint">SPN</span>
      {spn}
      <span className="ml-1 text-ink-faint">FMI</span>
      {fmi}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <Card className="py-14 text-center">
      <div className="font-display text-[16px] font-semibold text-ink">{title}</div>
      <div className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-ink-dim">
        {children}
      </div>
      {action ? (
        <Link
          href={action.href}
          className="mt-5 inline-flex rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent-deep hover:text-ink"
        >
          {action.label}
        </Link>
      ) : null}
    </Card>
  );
}

/**
 * A labelled proportion bar.
 *
 * Used for research coverage, where the ratio is the point and the absolute
 * numbers are secondary. Given `role="img"` with a text label so the meaning
 * survives for a screen reader, which a bare styled div would not.
 */
export function Meter({
  value,
  total,
  label,
}: {
  value: number;
  total: number;
  label: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;

  return (
    <div role="img" aria-label={`${label}: ${value} of ${total}, ${pct}%`}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12px] text-ink-dim">{label}</span>
        <span className="tabular font-mono text-[11px] text-ink-faint">
          {value}/{total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-inset">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
