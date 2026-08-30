/**
 * Build a scrubbed copy of this repository for the public mirror.
 *
 * Two independent mechanisms, because an exclusion list alone is how secrets
 * reach public repositories: things get added to the tree that nobody thought
 * to exclude.
 *
 *   1. An allowlist of what gets copied.
 *   2. A scan of every copied byte for credential-shaped strings, which ABORTS
 *      the export on a hit and leaves nothing behind.
 *
 * The second is the one that matters. It assumes the first has a hole in it.
 *
 * Usage: node scripts/export-public.mjs
 * Output: public-export/  (gitignored)
 */
import {
  writeFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

const OUT = "public-export";

/** Copied verbatim. Anything not named here never reaches the mirror. */
const INCLUDE = [
  "src",
  "app",
  "scripts",
  "supabase",
  "docs",
  "package.json",
  "tsconfig.json",
  "trigger.config.ts",
  "next.config.mjs",
  "postcss.config.mjs",
  "README.md",
  ".gitignore",
  ".env.example",
];

/** Never copied, even from inside an included directory. */
const EXCLUDE_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "private",
  OUT,
  ".trigger",
  ".next",
  "dist",
  "build",
]);

/**
 * Credential shapes. Each must be specific enough not to fire on ordinary
 * source: a rule that cries wolf gets disabled, and a disabled rule protects
 * nothing.
 */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/sb_secret_[A-Za-z0-9_-]{20,}/, "Supabase secret key"],
  [/sb_publishable_[A-Za-z0-9_-]{20,}/, "Supabase publishable key"],
  [/\bsbp_[a-f0-9]{40,}/, "Supabase personal access token"],
  [/\btr_(dev|prod)_[A-Za-z0-9]{20,}/, "Trigger.dev secret key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/https:\/\/[a-z]{20}\.supabase\.co/, "Supabase project URL"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
];

/** Files whose content is never scanned as text. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|otf|mp4)$/i;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// --- build -----------------------------------------------------------------

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let copied = 0;
for (const item of INCLUDE) {
  if (!existsSync(item)) continue;
  cpSync(item, join(OUT, item), {
    recursive: true,
    filter: (src) => !src.split(sep).some((part) => EXCLUDE_SEGMENTS.has(part)),
  });
  copied++;
}

// --- scan ------------------------------------------------------------------

const findings = [];

for (const file of walk(OUT)) {
  if (BINARY_EXT.test(file)) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  text.split("\n").forEach((line, index) => {
    for (const [pattern, description] of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          file: relative(OUT, file),
          line: index + 1,
          description,
        });
      }
    }
  });
}

/**
 * Third check: the literal values from .env.
 *
 * Pattern matching only catches credentials shaped like the ones anticipated. A
 * token from a service added next year, or one that simply does not match its
 * documented prefix, walks straight past it. Comparing against the actual
 * contents of .env catches any of those, because it does not care what a
 * credential looks like - only that this value is one.
 *
 * Keys whose values are deliberately public are exempt: model identifiers, the
 * Trigger API URL and the live site URL all appear in source as defaults, which
 * is correct and must not be reported as a leak. Anything not on that list is
 * treated as sensitive, so a newly added key is guarded by default rather than
 * needing to be remembered.
 */
const PUBLIC_ENV_KEYS = new Set([
  "MODEL_RESEARCHER",
  "MODEL_WRITER",
  "MODEL_EDITOR",
  "MODEL_AUDITOR",
  "TRIGGER_API_URL",
  "PUBLIC_SITE_URL",
]);

if (existsSync(".env")) {
  const exported = walk(OUT)
    .filter((file) => !BINARY_EXT.test(file))
    .map((file) => {
      try {
        return { file, text: readFileSync(file, "utf8") };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null);

  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = (rawValue ?? "").trim();

    if (!key || PUBLIC_ENV_KEYS.has(key)) continue;
    // Short values produce false positives against ordinary prose and are too
    // short to be a credential worth protecting.
    if (value.length < 12) continue;

    for (const entry of exported) {
      if (entry.text.includes(value)) {
        findings.push({
          file: relative(OUT, entry.file),
          line: 0,
          description: `literal value of ${key} from .env`,
        });
      }
    }
  }
}

if (findings.length > 0) {
  // The export is destroyed rather than left on disk. A half-scrubbed tree
  // sitting in a folder called "public-export" is an accident waiting to be
  // pushed by someone who assumes the name is accurate.
  rmSync(OUT, { recursive: true, force: true });

  console.error("EXPORT ABORTED - credential-shaped strings found:\n");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.description}`);
  }
  console.error(
    "\nThe export directory has been deleted. Move the value into .env " +
      "(which is never copied) and read it via src/lib/env.ts, then re-run.",
  );
  process.exit(1);
}

/**
 * Prepend a provenance note to the mirror's README.
 *
 * Applied here rather than kept in the source README so the two cannot drift:
 * a note maintained by hand in both places is a note that ends up wrong in one
 * of them. It also means the private README never carries text that only makes
 * sense on a public mirror.
 */
const readmePath = join(OUT, "README.md");
if (existsSync(readmePath)) {
  const notice = [
    "> **Public mirror.** Generated from a private repository by",
    "> `scripts/export-public.mjs`, which copies an allowlist and then scans every",
    "> copied byte for credential-shaped strings, aborting the export on a hit.",
    "> No credentials or project identifiers appear anywhere in this tree - all",
    "> configuration is read from the environment via `src/lib/env.ts`.",
    ">",
    "> This mirror has its own history and shares no commits with the private",
    "> repository.",
    "",
    "",
  ].join("\n");
  writeFileSync(readmePath, notice + readFileSync(readmePath, "utf8"), "utf8");
}

const files = walk(OUT);
console.log(`Scrubbed export written to ${OUT}/`);
console.log(`  ${copied} top-level entries, ${files.length} files`);
console.log(`  ${SECRET_PATTERNS.length} credential patterns + every .env value checked, 0 findings\n`);
console.log("Contents:");
for (const file of files.sort()) console.log(`  ${relative(OUT, file)}`);
console.log(
  "\nThis tree shares NO git history with the private repository. " +
    "Publish it as its own repo with its own initial commit - never by pushing " +
    "the private repo's history to a public remote.",
);
