/**
 * Write applied migrations from the remote database into supabase/migrations/.
 *
 * The schema is applied through the Supabase MCP server, which leaves it living
 * only in the remote project. That is how a database ends up with no version
 * control and no way to rebuild it, so this pulls the authoritative SQL back
 * down rather than trusting anyone to keep hand-written copies in step.
 *
 * Requires a temporary export view, because PostgREST does not expose the
 * supabase_migrations schema:
 *
 *   create view public._migration_export as
 *     select version, name, statements from supabase_migrations.schema_migrations;
 *   revoke all on public._migration_export from anon, authenticated, public;
 *   grant select on public._migration_export to service_role;
 *   notify pgrst, 'reload schema';
 *
 * Drop it again immediately afterwards.
 *
 * Usage: node scripts/dump-migrations.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const envText = readFileSync(".env", "utf8");
const readEnv = (key) =>
  (envText.match(new RegExp(`^${key}=(.*)$`, "m")) ?? [])[1]?.trim();

const url = readEnv("SUPABASE_URL");
const secret = readEnv("SUPABASE_SECRET_KEY");

if (!url || !secret) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env");
  process.exit(1);
}

const db = createClient(url, secret, { auth: { persistSession: false } });

const { data, error } = await db.from("_migration_export").select("*");

if (error) {
  console.error(`Export failed: ${error.message}`);
  console.error("Has the _migration_export view been created? See the header of this file.");
  process.exit(1);
}

mkdirSync("supabase/migrations", { recursive: true });

data.sort((a, b) => a.version.localeCompare(b.version));

for (const migration of data) {
  const joined = (migration.statements ?? []).join(";\n\n").trimEnd();
  const sql = joined.endsWith(";") ? joined : `${joined};`;
  const path = `supabase/migrations/${migration.version}_${migration.name}.sql`;
  writeFileSync(path, `${sql}\n`, "utf8");
  console.log(`  ${String(sql.length).padStart(6)} chars  ${path}`);
}

console.log(`\n${data.length} migrations written.`);
