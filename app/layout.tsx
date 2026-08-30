import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fault Code Factory",
  description: "Review console for the fault code generation pipeline",
};

/**
 * Fonts are loaded with a plain stylesheet link rather than next/font.
 *
 * next/font is normally the better choice - it self-hosts and removes a
 * render-blocking request. Here the console is a localhost tool whose fonts
 * must match the live Webflow site exactly, and the live site loads these three
 * families from Google with these exact weights. Using the same source removes
 * any chance of the console rendering in a subtly different cut than the pages
 * a reviewer is approving.
 */
const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/review", label: "Review" },
  { href: "/registry", label: "Registry" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONT_HREF} />
      </head>
      <body>
        <div className="min-h-screen">
          <header className="border-b border-hairline bg-surface/60 backdrop-blur sticky top-0 z-10">
            <div className="mx-auto flex max-w-[1400px] items-center gap-8 px-6 py-4">
              <Link href="/" className="flex items-center gap-2.5">
                {/* A mark rather than a logo file: one less asset to manage in a
                    tool nobody outside the team will ever see. */}
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full bg-accent"
                />
                <span className="font-display text-[15px] font-bold tracking-tight text-ink">
                  Fault Code Factory
                </span>
              </Link>

              <nav className="flex items-center gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-full px-3.5 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-inset hover:text-ink"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>

              <div className="ml-auto font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                {/* Naming the environment is not decoration. This console writes
                    to the same database the live site reads, and a reviewer
                    should never be in any doubt about that. */}
                local · production data
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-[1400px] px-6 py-10">{children}</main>
        </div>
      </body>
    </html>
  );
}
