-- similarity() compares whole strings, so an 87-char fault code title scored only
-- 0.202 against "cascadya nox sensor" and fell below threshold. word_similarity()
-- scores the query against the best-matching extent of the title instead: 0.600.
--
-- The threshold is written as an explicit comparison rather than the <% operator
-- because Supabase does not permit setting pg_trgm.word_similarity_threshold at
-- function level, and relying on the session default would make results depend on
-- connection state. Trade-off: the fuzzy branch cannot use the GIN index, so it is
-- a sequential scan. At 10k rows that is a few milliseconds and the full-text and
-- numeric branches still carry the common queries.

create or replace function public.search_fault_codes(
  q               text    default '',
  platform        text    default null,
  severity_filter text    default null,
  limit_n         integer default 20,
  offset_n        integer default 0
)
returns table (
  id                uuid,
  name              text,
  slug              text,
  spn_code          integer,
  fmi_code          integer,
  engine_platform   text,
  severity          text,
  meta_description  text,
  rank              real,
  total_count       bigint
)
language sql
stable
set search_path = ''
as $$
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
    fc.id,
    fc.name,
    fc.slug,
    fc.spn_code,
    fc.fmi_code,
    fc.engine_platform,
    fc.severity,
    fc.meta_description,
    (
      coalesce(ts_rank(fc.search_vector, p.tsq), 0)
      + case when p.num is not null and fc.spn_code = p.num then 2.0 else 0 end
      + case when p.num is not null and fc.fmi_code = p.num then 0.4 else 0 end
      + case when p.raw is not null
             then extensions.word_similarity(p.raw, fc.name) * 0.8 else 0 end
    )::real          as rank,
    count(*) over () as total_count
  from public.fault_codes fc, params p
  where
        (platform        is null or fc.engine_platform = platform)
    and (severity_filter is null or fc.severity        = severity_filter)
    and (
          p.raw is null
       or (p.tsq is not null and fc.search_vector @@ p.tsq)
       or (p.num is not null and (fc.spn_code = p.num or fc.fmi_code = p.num))
       or extensions.word_similarity(p.raw, fc.name) > 0.45
    )
  order by rank desc, fc.spn_code, fc.fmi_code
  limit least(coalesce(limit_n, 20), 100)
  offset greatest(coalesce(offset_n, 0), 0)
$$;

grant execute on function public.search_fault_codes(text, text, text, integer, integer)
  to anon, authenticated;
