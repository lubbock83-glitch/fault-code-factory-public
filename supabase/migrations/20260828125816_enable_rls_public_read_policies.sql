-- The search hub runs in the browser with the publishable key, so anon gets
-- read-only access and only to content cleared for publication. Writes belong
-- exclusively to the service role (Trigger.dev sync jobs), which bypasses RLS.

alter table public.taxonomy            enable row level security;
alter table public.hardware            enable row level security;
alter table public.fault_codes         enable row level security;
alter table public.fault_code_taxonomy enable row level security;

-- taxonomy: fully public, it is navigation
create policy "taxonomy readable by anyone"
  on public.taxonomy for select
  to anon, authenticated
  using (true);

-- hardware: public catalogue
create policy "hardware readable by anyone"
  on public.hardware for select
  to anon, authenticated
  using (true);

-- fault codes: only content that cleared tech review is exposed.
-- Drafts and in-review items stay invisible to the public search hub.
create policy "approved fault codes readable by anyone"
  on public.fault_codes for select
  to anon, authenticated
  using (review_status in ('approved','published'));

-- join rows are only useful alongside a visible fault code
create policy "taxonomy links readable by anyone"
  on public.fault_code_taxonomy for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.fault_codes fc
      where fc.id = fault_code_taxonomy.fault_code_id
        and fc.review_status in ('approved','published')
    )
  );
