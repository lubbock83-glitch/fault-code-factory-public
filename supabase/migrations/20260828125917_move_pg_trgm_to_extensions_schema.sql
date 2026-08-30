-- Extensions in the public schema are flagged by Supabase's security advisor.
-- The trigram index depends on the opclass, so it has to be dropped and rebuilt
-- around the move.
drop index if exists public.fault_codes_name_trgm_idx;

alter extension pg_trgm set schema extensions;

create index fault_codes_name_trgm_idx
  on public.fault_codes using gin (name extensions.gin_trgm_ops);
