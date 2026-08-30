/**
 * Structured data for a fault code page.
 *
 * Assembled in code rather than asked of a model. It is pure mechanical
 * transformation of fields we already hold, so generating it would mean paying
 * tokens for something deterministic and inviting malformed JSON, invented
 * fields and drifting shapes across pages.
 *
 * TechArticle plus FAQPage. Deliberately NOT HowTo - Google withdrew HowTo rich
 * results, so marking a diagnostic procedure up as one gains nothing.
 */

export interface JsonLdInput {
  title: string;
  metaDescription: string;
  spn: number;
  fmi: number;
  enginePlatform: string;
  slug: string;
  siteUrl: string;
  faq: Array<{ question: string; answer: string }>;
  sourceUrls: string[];
}

export function buildJsonLd(input: JsonLdInput): Record<string, unknown> {
  const url = `${input.siteUrl.replace(/\/+$/, "")}/fault-codes/${input.slug}`;

  const graph: Record<string, unknown>[] = [
    {
      "@type": "TechArticle",
      headline: input.title,
      description: input.metaDescription,
      url,
      proficiencyLevel: "Expert",
      about: {
        "@type": "Thing",
        name: `SAE J1939 fault code SPN ${input.spn} FMI ${input.fmi}`,
      },
      // Cited sources are surfaced rather than buried: the provenance is the
      // reason this page is trustworthy, so it belongs in the markup too.
      ...(input.sourceUrls.length > 0
        ? { citation: input.sourceUrls.map((href) => ({ "@type": "CreativeWork", url: href })) }
        : {}),
      author: { "@type": "Organization", name: "Fault Master" },
      publisher: { "@type": "Organization", name: "Fault Master" },
    },
  ];

  if (input.faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: input.faq.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}
