-- PostgREST filters compare a column to a literal; there is no syntax for
-- column-to-column comparison, so "updated_at > synced_at" cannot be expressed
-- as a query filter. Push the comparison into the table as a stored generated
-- column, which the sync can then filter on directly and which stays correct
-- without any application logic.

alter table public.fault_codes
  add column needs_sync boolean
  generated always as (synced_at is null or updated_at > synced_at) stored;

-- Partial index: the sync only ever asks for rows where this is true, and that
-- set is small once the backlog is cleared.
create index fault_codes_needs_sync_idx
  on public.fault_codes (spn_code)
  where needs_sync;
