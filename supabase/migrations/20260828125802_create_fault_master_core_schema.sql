-- Fault Master core schema.
-- Supabase is the system of record; Webflow CMS is a rendered projection of it.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- taxonomy
create table public.taxonomy (
  id                uuid primary key default gen_random_uuid(),
  webflow_item_id   text unique,
  name              text not null,
  slug              text not null unique,
  taxonomy_type     text not null check (taxonomy_type in
                      ('Engine Make','System Subsystem','Protocol','Code Family')),
  intro_copy        text,
  meta_description  text,
  synced_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- hardware
create table public.hardware (
  id                       uuid primary key default gen_random_uuid(),
  webflow_item_id          text unique,
  name                     text not null,
  slug                     text not null unique,
  -- numeric(10,2) is the guard the Webflow Number field cannot enforce
  base_price               numeric(10,2) not null check (base_price >= 0),
  unique_sku               text not null unique,
  snipcart_variant_string  text,
  supported_protocols      text,
  vehicle_engine_coverage  text,
  financing_display_text   text,
  technical_description    text,
  bidirectional_functions  text,
  in_stock                 boolean not null default true,
  synced_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ------------------------------------------------------------- fault codes
create table public.fault_codes (
  id                    uuid primary key default gen_random_uuid(),
  webflow_item_id       text unique,
  name                  text not null,
  slug                  text not null unique,
  spn_code              integer not null check (spn_code >= 0),
  fmi_code              integer not null check (fmi_code between 0 and 31),
  engine_platform       text,
  severity              text not null default 'Informational' check (severity in
                          ('Informational','Active Fault','Derate Imminent','Shutdown Risk')),
  symptom_keywords      text,
  meta_description      text,
  diagnostic_content    text,
  json_ld               text,
  required_hardware_id  uuid references public.hardware(id) on delete set null,
  review_status         text not null default 'draft' check (review_status in
                          ('draft','tech_review','approved','published')),
  synced_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- one SPN/FMI pair per engine platform
  unique (spn_code, fmi_code, engine_platform)
);

-- many-to-many: fault code <-> taxonomy
create table public.fault_code_taxonomy (
  fault_code_id  uuid not null references public.fault_codes(id) on delete cascade,
  taxonomy_id    uuid not null references public.taxonomy(id)    on delete cascade,
  primary key (fault_code_id, taxonomy_id)
);

-- ------------------------------------------------------------ search index
-- Weighted: title and codes rank above symptoms, symptoms above body.
alter table public.fault_codes add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(spn_code::text, '') || ' ' ||
                                     coalesce(fmi_code::text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(engine_platform, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(symptom_keywords, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(meta_description, '')), 'C')
  ) stored;

create index fault_codes_search_idx    on public.fault_codes using gin (search_vector);
create index fault_codes_name_trgm_idx on public.fault_codes using gin (name gin_trgm_ops);
create index fault_codes_spn_fmi_idx   on public.fault_codes (spn_code, fmi_code);
create index fault_codes_platform_idx  on public.fault_codes (engine_platform);
create index fault_codes_severity_idx  on public.fault_codes (severity);
create index fault_codes_hardware_idx  on public.fault_codes (required_hardware_id);
create index fct_taxonomy_idx          on public.fault_code_taxonomy (taxonomy_id);
create index taxonomy_type_idx         on public.taxonomy (taxonomy_type);

-- --------------------------------------------------------------- updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger taxonomy_touch    before update on public.taxonomy
  for each row execute function public.touch_updated_at();
create trigger hardware_touch    before update on public.hardware
  for each row execute function public.touch_updated_at();
create trigger fault_codes_touch before update on public.fault_codes
  for each row execute function public.touch_updated_at();
