import Link from "next/link";
import { notFound } from "next/navigation";
import { getArticle } from "../../lib/queries";
import { markdownToWebflowHtml } from "@/src/lib/markdown";
import type { ProvenanceClaim } from "../../lib/db";
import { Badge, Card, CodeChip, SectionTitle, SeverityBadge, StatusBadge } from "../../components/ui";
import { ReviewActions } from "./ReviewActions";

export const dynamic = "force-dynamic";

/**
 * Single article review.
 *
 * The layout is the argument. A reviewer given a wall of prose will skim it and
 * approve; the failure mode being guarded against - a confidently worded,
 * entirely invented pin voltage - is invisible to skimming, because fabricated
 * text reads exactly like sourced text.
 *
 * So claims come first, each next to the source backing it, and the prose comes
 * second. The job on this page is verifying roughly eight facts, not
 * proofreading an article. That is the difference between reviewing 300
 * articles in four hours and not reviewing them at all.
 */
export default async function ArticleReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getArticle(id);

  if (!detail) notFound();

  const { article, registry, sources } = detail;
  const audit = article.provenance_audit;
  const claims = audit?.claims ?? [];

  const unsupported = claims.filter((c) => c.verdict === "unsupported");
  const contradicted = claims.filter((c) => c.verdict === "contradicted");
  const supported = claims.filter((c) => c.verdict === "supported");

  // Rendered through the same converter the sync uses. Reviewing a different
  // rendering than the one that ships would mean approving an artefact nobody
  // has actually looked at.
  const html = markdownToWebflowHtml(article.content_markdown ?? "");

  return (
    <div className="space-y-8">
      <div>
        <Link href="/review" className="text-[13px] text-ink-faint hover:text-ink">
          &larr; Back to queue
        </Link>

        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <CodeChip spn={article.spn_code} fmi={article.fmi_code} />
          <SeverityBadge severity={article.severity} />
          <StatusBadge status={article.status} />
          {article.model_used ? (
            <Badge tone="neutral">{article.model_used}</Badge>
          ) : null}
          {article.cost_usd != null ? (
            <Badge tone="neutral">${article.cost_usd.toFixed(3)}</Badge>
          ) : null}
        </div>

        <h1 className="mt-3 max-w-4xl font-display text-[24px] font-bold leading-tight tracking-tight text-ink">
          {article.title}
        </h1>
        <p className="mt-1.5 font-mono text-[12px] text-ink-faint">
          /fault-codes/{article.slug} · {article.engine_platform}
        </p>
      </div>

      <Card>
        <ReviewActions
          articleId={article.id}
          status={article.status}
          markdown={article.content_markdown ?? ""}
        />
      </Card>

      {/* ---- Verdict summary ------------------------------------------- */}
      <section>
        <SectionTitle hint="what the auditor concluded">Audit</SectionTitle>

        {audit ? (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                Verdict
              </div>
              <div
                className={`mt-2 font-display text-[22px] font-bold ${
                  audit.verdict === "pass" ? "text-pass" : "text-warn"
                }`}
              >
                {audit.verdict === "pass" ? "Passed" : "Failed"}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
                {audit.verdict === "pass"
                  ? "Machine checks cleared. Your judgement is still the gate."
                  : "The auditor rejected this. Worth reading precisely because it caught something."}
              </p>
            </Card>

            <Card>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                Claims
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge tone="pass">{supported.length} supported</Badge>
                {unsupported.length > 0 ? (
                  <Badge tone="fail">{unsupported.length} unsupported</Badge>
                ) : null}
                {contradicted.length > 0 ? (
                  <Badge tone="fail">{contradicted.length} contradicted</Badge>
                ) : null}
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">
                {audit.stripped.length > 0
                  ? `${audit.stripped.length} unsupported specific${audit.stripped.length === 1 ? "" : "s"} already removed from the body below.`
                  : "Nothing needed stripping."}
              </p>
            </Card>

            <Card>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                Notes
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
                {audit.notes ?? "None."}
              </p>
            </Card>
          </div>
        ) : (
          <Card>
            <p className="text-[13px] text-ink-dim">
              No audit was recorded for this article. It predates the pipeline, or
              generation failed before the auditor ran.
            </p>
          </Card>
        )}
      </section>

      {/* ---- The core screen: claims beside their sources ---------------- */}
      <section>
        <SectionTitle hint="verify these, not the prose">Checkable claims</SectionTitle>

        {claims.length === 0 ? (
          <Card>
            <p className="text-[13px] text-ink-dim">
              No checkable claims were extracted. For a page that asserts no specific
              values that is correct and expected &mdash; there is nothing a meter could
              contradict.
            </p>
          </Card>
        ) : (
          <Card className="p-0">
            <ul>
              {claims.map((claim, index) => (
                <ClaimRow key={`${claim.claim}-${index}`} claim={claim} />
              ))}
            </ul>
          </Card>
        )}

        {audit && audit.stripped.length > 0 ? (
          <Card className="mt-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              Removed before you saw it
            </div>
            <ul className="mt-2.5 space-y-1.5">
              {audit.stripped.map((item, index) => (
                <li key={index} className="text-[13px] leading-relaxed text-ink-dim">
                  <span className="mr-2 text-fail">&times;</span>
                  {item}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </section>

      {/* ---- Pinout data ------------------------------------------------ */}
      {article.pinout_test_data.length > 0 ? (
        <section>
          <SectionTitle hint="every row carries the source that stated it">
            Pinout data
          </SectionTitle>
          <Card className="p-0">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-hairline">
                  {["Pin", "Circuit", "Expected", "Source"].map((heading) => (
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
                {article.pinout_test_data.map((entry, index) => (
                  <tr key={index} className="border-b border-hairline last:border-0">
                    <td className="tabular px-5 py-2.5 font-mono text-ink">{entry.pin}</td>
                    <td className="px-5 py-2.5 text-ink-dim">{entry.circuit}</td>
                    <td className="tabular px-5 py-2.5 font-mono text-ink">
                      {entry.expected}
                    </td>
                    <td className="px-5 py-2.5">
                      <a
                        href={entry.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {hostOf(entry.source_url)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ) : null}

      {/* ---- Rendered body ---------------------------------------------- */}
      <section>
        <SectionTitle hint="rendered exactly as the sync will send it to Webflow">
          Article
        </SectionTitle>
        <Card>
          <div
            className="article-body max-w-3xl"
            // Safe here: this HTML comes from our own converter, which runs an
            // explicit tag allowlist over its own output, applied to markdown
            // this pipeline generated. It is not third-party content.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </Card>
      </section>

      {/* ---- Sources ---------------------------------------------------- */}
      <section>
        <SectionTitle hint={`${sources.length} gathered for this code`}>Sources</SectionTitle>

        {sources.length === 0 ? (
          <Card>
            <p className="text-[13px] text-ink-dim">
              No sources are stored for this code. An article should not exist without
              them &mdash; treat anything specific in the body above as unverified.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {sources.map((source) => (
              <Card key={source.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{source.claim_type}</Badge>
                  {source.confidence != null ? (
                    <Badge tone={source.confidence >= 0.7 ? "pass" : "warn"}>
                      confidence {source.confidence.toFixed(2)}
                    </Badge>
                  ) : null}
                  <a
                    href={source.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto font-mono text-[11px] text-accent hover:underline"
                  >
                    {source.source_domain}
                  </a>
                </div>
                <p className="mt-2.5 text-[13px] leading-relaxed text-ink">
                  {source.claim_value}
                </p>
                <blockquote className="mt-2.5 border-l-2 border-edge pl-3 text-[12px] leading-relaxed text-ink-faint">
                  {source.snippet}
                </blockquote>
              </Card>
            ))}
          </div>
        )}
      </section>

      {registry ? (
        <footer className="border-t border-hairline pt-5 text-[12px] leading-relaxed text-ink-faint">
          Registry entry: SPN {registry.spn_code} &mdash; {registry.spn_description}. FMI{" "}
          {registry.fmi_code} &mdash; {registry.fmi_description}.
        </footer>
      ) : null}
    </div>
  );
}

/**
 * One claim and its verdict.
 *
 * The source link is the whole point of the row. An unsupported claim has no
 * link to give, and saying so explicitly is better than an empty cell that
 * could be read as a rendering problem rather than a finding.
 */
function ClaimRow({ claim }: { claim: ProvenanceClaim }) {
  const tone =
    claim.verdict === "supported"
      ? "pass"
      : claim.verdict === "contradicted"
        ? "fail"
        : "warn";

  return (
    <li className="border-b border-hairline px-5 py-3.5 last:border-0">
      <div className="flex flex-wrap items-start gap-3">
        <Badge tone={tone}>{claim.verdict}</Badge>
        <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">
          {claim.claim}
        </span>
        {claim.source_url ? (
          <a
            href={claim.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 font-mono text-[11px] text-accent hover:underline"
          >
            {hostOf(claim.source_url)}
          </a>
        ) : (
          <span className="shrink-0 font-mono text-[11px] text-ink-faint">
            no source
          </span>
        )}
      </div>
    </li>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
}
