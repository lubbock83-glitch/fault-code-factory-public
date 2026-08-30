import { marked } from "marked";

/**
 * Convert article markdown into HTML for a Webflow Rich Text field.
 *
 * Webflow Rich Text stores HTML, but it is not a general HTML container: it
 * renders a fixed vocabulary of tags and quietly discards or mangles the rest.
 * Sending it arbitrary converter output means content that looks correct in the
 * database and is missing on the page - a failure that shows up only on the
 * rendered site, long after the sync reported success.
 *
 * So conversion is followed by an explicit allowlist pass. Anything outside the
 * vocabulary is unwrapped (its text survives, its tag does not) rather than
 * dropped, because losing a paragraph is worse than losing its styling.
 */

/**
 * Tags Webflow Rich Text renders.
 *
 * `table`/`thead`/`tbody`/`tr`/`th`/`td` are included deliberately: pinout data
 * is the highest-value content on these pages and it belongs in a table. This
 * is verified rather than assumed - the existing fault code page on the live
 * site renders a pinout table from exactly this field.
 */
const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "strong", "em", "b", "i", "u", "sup", "sub",
  "a", "img",
  "blockquote", "figure", "figcaption",
  "table", "thead", "tbody", "tr", "th", "td",
  "code", "pre",
]);

/** Attributes kept per tag. Everything else is stripped. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
};

export function markdownToWebflowHtml(markdown: string): string {
  if (!markdown.trim()) return "";

  const html = marked.parse(markdown, {
    // GFM gives us pipe tables, which is the whole reason tables are usable
    // here. Without it a markdown pinout table arrives as a wall of pipes.
    gfm: true,
    // Single newlines stay single. Technicians' step lists read better without
    // a <br> inserted at every wrap point.
    breaks: false,
    async: false,
  }) as string;

  return sanitise(html).trim();
}

/**
 * Strip disallowed tags and attributes.
 *
 * A regex-based pass, not a DOM parse. That is a deliberate limit: this runs on
 * output from our own converter over our own generated markdown, not on
 * untrusted third-party HTML. If this function ever starts receiving content
 * from outside the pipeline, replace it with a real sanitiser - a regex is not
 * an XSS defence and should not be relied on as one.
 */
function sanitise(html: string): string {
  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)\/?>/g, (match, closing, rawTag, rawAttrs) => {
    const tag = String(rawTag).toLowerCase();

    // Unwrap rather than delete: the tag goes, its contents stay.
    if (!ALLOWED_TAGS.has(tag)) return "";

    if (closing) return `</${tag}>`;

    const permitted = ALLOWED_ATTRS[tag];
    if (!permitted) return `<${tag}>`;

    const kept: string[] = [];
    const attrPattern = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
    let attr: RegExpExecArray | null;

    while ((attr = attrPattern.exec(String(rawAttrs))) !== null) {
      const name = attr[1]?.toLowerCase() ?? "";
      const value = attr[2] ?? "";
      if (!permitted.has(name)) continue;

      // javascript: and data: URLs have no legitimate use in generated
      // reference content, and allowing them through would turn a CMS field
      // into a script injection point.
      if ((name === "href" || name === "src") && !/^(https?:|\/|#|mailto:)/i.test(value)) {
        continue;
      }

      kept.push(`${name}="${escapeAttr(value)}"`);
    }

    // External links open in a new tab and disclaim the referrer relationship.
    // These pages cite manufacturer documentation heavily; sending a technician
    // off the page mid-diagnosis loses their place in the procedure.
    if (tag === "a" && kept.some((a) => a.startsWith('href="http'))) {
      kept.push('target="_blank"', 'rel="noopener noreferrer"');
    }

    return kept.length > 0 ? `<${tag} ${kept.join(" ")}>` : `<${tag}>`;
  });
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Rough reading time, for the review queue.
 *
 * 220 words per minute is the usual prose figure. It over-estimates for this
 * content - nobody reads a pinout table linearly - but the number exists to
 * let a reviewer triage a queue, not to be accurate.
 */
export function readingTimeMinutes(markdown: string): number {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
