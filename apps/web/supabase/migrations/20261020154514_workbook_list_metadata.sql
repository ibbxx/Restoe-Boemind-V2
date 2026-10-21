-- Local verification first; this computes derived metadata for existing rows on deployment.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create function procurement.workbook_analysis_date(data jsonb) returns date
language plpgsql immutable security invoker set search_path = pg_catalog as $$
declare value text;
begin
  select case when cell.value #>> '{source,kind}' = 'INPUT' and cell.value #>> '{source,input,kind}' = 'TEXT'
    then cell.value #>> '{source,input,text}' else null end into value
  from jsonb_array_elements(coalesce(jsonb_path_query_first(data, '$.state.worksheets[*] ? (@.stage == "AHS")')->'tables', '[]'::jsonb)) with ordinality t(value, position)
  cross join lateral jsonb_array_elements(t.value->'cells') with ordinality cell(value, position)
  where (select r.value->>'label' from jsonb_array_elements(t.value->'rows') r(value)
    where r.value->>'id' = cell.value->>'rowId' limit 1) = 'Tgl Analisis (Rn)'
  or (select p.value->>'address' from jsonb_array_elements(coalesce(data #> '{state,workbook,cells}', '[]'::jsonb)) p(value)
    where p.value->>'cellId' = cell.value->>'id' limit 1) = case when cell.value->>'scope' = 'INU' then 'H4' else 'H3' end
  order by t.position, cell.position limit 1;
  if value is null or value !~ '^\d{2}/\d{2}/\d{4}$' then return null; end if;
  return make_date(substring(value,7,4)::int, substring(value,4,2)::int, substring(value,1,2)::int);
exception when datetime_field_overflow then return null;
end $$;
revoke all on function procurement.workbook_analysis_date(jsonb) from public, anon, authenticated;
grant execute on function procurement.workbook_analysis_date(jsonb) to procurement_runtime;

alter table procurement.current_workbooks add column analysis_date date
  generated always as (procurement.workbook_analysis_date(data)) stored;
