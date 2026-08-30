-- ---------------------------------------------------------------------------
-- Content factory foundations.
--
-- Purely additive: nothing here touches fault_codes, the search function, or
-- anything the live site reads. The fault_codes -> fault_code_articles swap is
-- a later migration so this one can be applied and inspected on its own.
-- ---------------------------------------------------------------------------

-- FMI 0-31 per SAE J1939-73. Small, factual and stable, so it lives as a real
-- table rather than a check constraint: the registry denormalises a
-- platform-specific description, and this is the canonical fallback.
create table public.fmi_reference (
  fmi_code      integer primary key check (fmi_code between 0 and 31),
  short_name    text not null,
  description   text not null,
  is_reserved   boolean not null default false
);

comment on table public.fmi_reference is
  'Failure Mode Identifiers 0-31. Canonical descriptions; registry rows may override per platform.';

insert into public.fmi_reference (fmi_code, short_name, description, is_reserved) values
  (0,  'Above normal (most severe)',      'Data valid but above normal operational range - most severe level', false),
  (1,  'Below normal (most severe)',      'Data valid but below normal operational range - most severe level', false),
  (2,  'Erratic or incorrect',            'Data erratic, intermittent or incorrect', false),
  (3,  'Voltage above normal',            'Voltage above normal, or shorted to high source', false),
  (4,  'Voltage below normal',            'Voltage below normal, or shorted to low source', false),
  (5,  'Current below normal',            'Current below normal or open circuit', false),
  (6,  'Current above normal',            'Current above normal or grounded circuit', false),
  (7,  'Mechanical not responding',       'Mechanical system not responding or out of adjustment', false),
  (8,  'Abnormal frequency',              'Abnormal frequency, pulse width or period', false),
  (9,  'Abnormal update rate',            'Abnormal update rate', false),
  (10, 'Abnormal rate of change',         'Abnormal rate of change', false),
  (11, 'Root cause unknown',              'Root cause not known', false),
  (12, 'Bad component',                   'Bad intelligent device or component', false),
  (13, 'Out of calibration',              'Out of calibration', false),
  (14, 'Special instructions',            'Special instructions', false),
  (15, 'Above normal (least severe)',     'Data valid but above normal operating range - least severe level', false),
  (16, 'Above normal (moderate)',         'Data valid but above normal operating range - moderately severe level', false),
  (17, 'Below normal (least severe)',     'Data valid but below normal operating range - least severe level', false),
  (18, 'Below normal (moderate)',         'Data valid but below normal operating range - moderately severe level', false),
  (19, 'Network data in error',           'Received network data in error', false),
  (20, 'Data drifted high',               'Data drifted high', false),
  (21, 'Data drifted low',                'Data drifted low', false),
  (22, 'Reserved',                        'Reserved for SAE assignment', true),
  (23, 'Reserved',                        'Reserved for SAE assignment', true),
  (24, 'Reserved',                        'Reserved for SAE assignment', true),
  (25, 'Reserved',                        'Reserved for SAE assignment', true),
  (26, 'Reserved',                        'Reserved for SAE assignment', true),
  (27, 'Reserved',                        'Reserved for SAE assignment', true),
  (28, 'Reserved',                        'Reserved for SAE assignment', true),
  (29, 'Reserved',                        'Reserved for SAE assignment', true),
  (30, 'Reserved',                        'Reserved for SAE assignment', true),
  (31, 'Condition exists',                'Condition exists - status indicator, not a failure mode', false);

-- ---------------------------------------------------------------------------
-- The code dictionary. One row per SPN x FMI x platform combination we intend
-- to write about. Descriptions are NOT NULL on purpose: a bare code number is
-- a topic_queue entry, not a registry entry. Promotion requires knowing what
-- the code actually means.
-- ---------------------------------------------------------------------------
create table public.fault_code_registry (
  id               uuid primary key default gen_random_uuid(),
  spn_code         integer not null check (spn_code >= 0),
  fmi_code         integer not null references public.fmi_reference (fmi_code),
  engine_platform  text    not null,
  spn_description  text    not null,
  fmi_description  text    not null,
  is_processed     boolean not null default false,
  -- Higher = more search demand. Drives generation order so the best topics
  -- are written first and a halted run still leaves the valuable pages done.
  demand_rank      integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint fault_code_registry_unique unique (spn_code, fmi_code, engine_platform)
);

create index fault_code_registry_unprocessed_idx
  on public.fault_code_registry (demand_rank desc, spn_code)
  where is_processed = false;

-- ---------------------------------------------------------------------------
-- Provenance. This is the fabrication defence: an article may only assert a
-- number that traces to a row here. No row, no claim.
--
-- snippet is capped at 1200 characters - it exists to prove a source said the
-- thing, not to reproduce the source.
-- ---------------------------------------------------------------------------
create table public.grounding_sources (
  id            uuid primary key default gen_random_uuid(),
  registry_id   uuid not null references public.fault_code_registry (id) on delete cascade,
  source_url    text not null,
  source_domain text not null,
  source_title  text,
  retrieved_at  timestamptz not null default now(),
  snippet       text not null check (length(snippet) <= 1200),
  claim_type    text not null check (
                  claim_type in ('definition','symptom','procedure','threshold','severity','hardware')),
  claim_value   text not null,
  confidence    numeric(3,2) check (confidence >= 0 and confidence <= 1),
  created_at    timestamptz not null default now()
);

create index grounding_sources_registry_idx on public.grounding_sources (registry_id, claim_type);

-- ---------------------------------------------------------------------------
-- Demand signals. search_queries is written by the public site; topic_queue is
-- the ranked candidate list distilled from it plus seeded research.
-- ---------------------------------------------------------------------------
create table public.search_queries (
  id           bigint generated always as identity primary key,
  q            text not null check (length(q) <= 200),
  result_count integer,
  created_at   timestamptz not null default now()
);

create index search_queries_recent_idx on public.search_queries (created_at desc);

create table public.topic_queue (
  id              uuid primary key default gen_random_uuid(),
  spn_code        integer check (spn_code >= 0),
  fmi_code        integer check (fmi_code between 0 and 31),
  engine_platform text,
  raw_query       text,
  demand_score    integer not null default 0,
  status          text not null default 'pending'
                    check (status in ('pending','researching','promoted','rejected')),
  registry_id     uuid references public.fault_code_registry (id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index topic_queue_pending_idx
  on public.topic_queue (demand_score desc, created_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- RLS. Everything here is back-office except one narrow hole: the public site
-- must be able to log what people search for.
-- ---------------------------------------------------------------------------
alter table public.fmi_reference       enable row level security;
alter table public.fault_code_registry enable row level security;
alter table public.grounding_sources   enable row level security;
alter table public.search_queries      enable row level security;
alter table public.topic_queue         enable row level security;

-- FMI definitions are public reference data and get rendered on article pages.
create policy "fmi reference readable by anyone"
  on public.fmi_reference for select using (true);

-- Insert-only for anon: the site logs queries but must never read the log back.
create policy "anyone may log a search query"
  on public.search_queries for insert to anon, authenticated with check (true);

-- fault_code_registry, grounding_sources and topic_queue get no anon policy at
-- all. RLS on with zero policies denies everything; the sync jobs and review
-- console use the secret key, which bypasses RLS.

create trigger fault_code_registry_touch
  before update on public.fault_code_registry
  for each row execute function public.touch_updated_at();

create trigger topic_queue_touch
  before update on public.topic_queue
  for each row execute function public.touch_updated_at();
