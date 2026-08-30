-- ---------------------------------------------------------------------------
-- fault_code_articles becomes the system of record for article content, and
-- search_fault_codes is repointed at it.
--
-- fault_codes is deliberately LEFT IN PLACE. It is dropped in a separate
-- migration so the live site's search can be verified against the new table
-- while the old one is still there to fall back to.
-- ---------------------------------------------------------------------------

create table public.fault_code_articles (
  id               uuid primary key default gen_random_uuid(),
  registry_id      uuid references public.fault_code_registry (id) on delete set null,
  webflow_item_id  text unique,

  title            text not null,
  slug             text not null unique,
  spn_code         integer not null check (spn_code >= 0),
  fmi_code         integer not null check (fmi_code between 0 and 31),
  engine_platform  text not null,

  content_markdown text,
  meta_description text,
  symptom_keywords text,
  schema_jsonld    jsonb,
  schematic_svg    text,
  source_tsb_url   text,

  -- Tag STRINGS proposed by the generator. Distinct from fault_code_taxonomy,
  -- which holds the resolved links to real taxonomy rows. These are two stages
  -- of one pipeline, not two copies of one fact: the writer emits names, a
  -- promotion step resolves them to ids.
  taxonomy_tags    jsonb not null default '[]'::jsonb,

  -- Per-platform electrical data, when a source actually stated it. NOT part of
  -- the approval gate below: requiring it would pressure the pipeline into
  -- inventing pin voltages on the pages where no public source gives them,
  -- which is the exact failure this whole design exists to prevent.
  pinout_test_data jsonb not null default '[]'::jsonb,

  recommended_tool_sku text,
  severity         text not null default 'Informational'
                     check (severity in ('Informational','Active Fault','Derate Imminent','Shutdown Risk')),

  uniqueness_audit_log jsonb,
  provenance_audit     jsonb,
  model_used           text,
  cost_usd             numeric(10,4),

  status           text not null default 'queued'
                     check (status in ('queued','processing','pending_review','approved','published','failed')),

  synced_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  needs_sync       boolean generated always as
                     ((synced_at is null) or (updated_at > synced_at)) stored,

  search_vector    tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
    || setweight(to_tsvector('english',
         coalesce(spn_code::text, '') || ' ' || coalesce(fmi_code::text, '')), 'A')
    || setweight(to_tsvector('english', coalesce(engine_platform, '')), 'B')
    || setweight(to_tsvector('english', coalesce(symptom_keywords, '')), 'B')
    || setweight(to_tsvector('english', coalesce(meta_description, '')), 'C')
  ) stored,

  -- Completeness enforced by the database, not by hope. An article physically
  -- cannot reach 'approved' without the fields a published page needs.
  constraint fault_code_articles_ready_for_approval check (
    status not in ('approved','published')
    or (
      content_markdown is not null
      and meta_description is not null
      and recommended_tool_sku is not null
      and jsonb_array_length(taxonomy_tags) > 0
    )
  )
);

create index fault_code_articles_search_idx on public.fault_code_articles using gin (search_vector);
create index fault_code_articles_status_idx on public.fault_code_articles (status);
create index fault_code_articles_pending_sync_idx
  on public.fault_code_articles (spn_code, fmi_code)
  where status in ('approved','published');

create trigger fault_code_articles_touch
  before update on public.fault_code_articles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Carry the existing row across, ids preserved so the taxonomy join survives.
-- required_hardware_id (uuid) becomes recommended_tool_sku (text) via hardware.
-- ---------------------------------------------------------------------------
insert into public.fault_code_articles (
  id, webflow_item_id, title, slug, spn_code, fmi_code, engine_platform,
  content_markdown, meta_description, symptom_keywords, schema_jsonld,
  taxonomy_tags, recommended_tool_sku, severity, status, synced_at,
  created_at, updated_at
)
select
  fc.id,
  fc.webflow_item_id,
  fc.name,
  fc.slug,
  fc.spn_code,
  fc.fmi_code,
  coalesce(fc.engine_platform, 'Unspecified'),
  fc.diagnostic_content,
  fc.meta_description,
  fc.symptom_keywords,
  case when fc.json_ld is null or fc.json_ld = '' then null
       else fc.json_ld::jsonb end,
  coalesce(
    (select jsonb_agg(t.name)
       from public.fault_code_taxonomy fct
       join public.taxonomy t on t.id = fct.taxonomy_id
      where fct.fault_code_id = fc.id),
    '[]'::jsonb
  ),
  (select h.unique_sku from public.hardware h where h.id = fc.required_hardware_id),
  fc.severity,
  case fc.review_status
    when 'draft'       then 'queued'
    when 'tech_review' then 'pending_review'
    else fc.review_status
  end,
  fc.synced_at,
  fc.created_at,
  fc.updated_at
from public.fault_codes fc;

-- Repoint the join table at the new home. Ids were preserved, so every existing
-- link still resolves.
alter table public.fault_code_taxonomy
  drop constraint fault_code_taxonomy_fault_code_id_fkey;

alter table public.fault_code_taxonomy
  add constraint fault_code_taxonomy_fault_code_id_fkey
  foreign key (fault_code_id) references public.fault_code_articles (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- RLS: same public contract as before, expressed against status rather than
-- review_status. Drafts and in-review articles stay invisible to anon.
-- ---------------------------------------------------------------------------
alter table public.fault_code_articles enable row level security;

create policy "approved articles readable by anyone"
  on public.fault_code_articles for select
  using (status in ('approved','published'));

drop policy "taxonomy links readable by anyone" on public.fault_code_taxonomy;

create policy "taxonomy links readable by anyone"
  on public.fault_code_taxonomy for select
  using (exists (
    select 1 from public.fault_code_articles a
     where a.id = fault_code_taxonomy.fault_code_id
       and a.status in ('approved','published')
  ));

-- ---------------------------------------------------------------------------
-- Repoint the search function.
--
-- FROZEN CONTRACT: name, parameters and return columns are byte-identical to
-- the previous definition. The live /diagnostics page calls this from the site
-- footer with the publishable key; any signature drift breaks it silently.
-- title is aliased back to `name` for exactly that reason.
-- ---------------------------------------------------------------------------
create or replace function public.search_fault_codes(
  q text default ''::text,
  platform text default null::text,
  severity_filter text default null::text,
  limit_n integer default 20,
  offset_n integer default 0
)
returns table(
  id uuid, name text, slug text, spn_code integer, fmi_code integer,
  engine_platform text, severity text, meta_description text,
  rank real, total_count bigint
)
language sql
stable
set search_path to ''
as $function$
  with params as (
    select
      nullif(btrim(q), '')                                      as raw,
      case
        when nullif(btrim(q), '') is null then null
        else websearch_to_tsquery('english', btrim(q))
      end                                                       as tsq,
      (regexp_match(coalesce(q, ''), '(\d{1,6})'))[1]::integer  as num
  )
  select
    a.id,
    a.title as name,
    a.slug,
    a.spn_code,
    a.fmi_code,
    a.engine_platform,
    a.severity,
    a.meta_description,
    (
      coalesce(ts_rank(a.search_vector, p.tsq), 0)
      + case when p.num is not null and a.spn_code = p.num then 2.0 else 0 end
      + case when p.num is not null and a.fmi_code = p.num then 0.4 else 0 end
      + case when p.raw is not null
             then extensions.word_similarity(p.raw, a.title) * 0.8 else 0 end
    )::real          as rank,
    count(*) over () as total_count
  from public.fault_code_articles a, params p
  where
        a.status in ('approved','published')
    and (platform        is null or a.engine_platform = platform)
    and (severity_filter is null or a.severity        = severity_filter)
    and (
          p.raw is null
       or (p.tsq is not null and a.search_vector @@ p.tsq)
       or (p.num is not null and (a.spn_code = p.num or a.fmi_code = p.num))
       or extensions.word_similarity(p.raw, a.title) > 0.45
    )
  order by rank desc, a.spn_code, a.fmi_code
  limit least(coalesce(limit_n, 20), 100)
  offset greatest(coalesce(offset_n, 0), 0)
$function$;
