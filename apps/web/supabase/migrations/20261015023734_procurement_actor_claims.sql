-- Forward-only migration; the CLI owns DDL + ledger atomicity. No auth-schema grants.
-- Claims are trusted only because the server verifies Bearer tokens before setting them.
create function procurement.current_actor_id() returns uuid
language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
declare
  subject text := nullif(current_setting('request.jwt.claim.sub', true), '');
  claims jsonb;
begin
  claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if subject is null
    or subject !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(claims) is distinct from 'object'
    or jsonb_typeof(claims->'sub') is distinct from 'string'
    or lower(claims->>'sub') is distinct from lower(subject)
    or claims->>'role' is distinct from 'authenticated' then
    return null;
  end if;
  return subject::uuid;
exception when invalid_text_representation then
  return null;
end $$;
revoke all on function procurement.current_actor_id() from public, anon, authenticated;
grant execute on function procurement.current_actor_id() to procurement_runtime;

do $$
declare t text;
begin
  -- Refuse drift/partial schemas rather than silently leaving extra permissive policies.
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'procurement' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity) <> 14
    or (select count(*) from pg_policies where schemaname = 'procurement') <> 34 then
    raise exception 'Expected the reviewed 14 FORCE RLS tables and 34 policies';
  end if;
  foreach t in array array['projects','analyses','workbook_snapshots','revisions','analysis_heads','change_events',
    'revision_mutations','vendors','offers','offer_revisions','mapping_versions','formula_versions','calculation_runs','latest_calculation_runs'] loop
    execute format('alter policy owner_read on procurement.%I to procurement_runtime using (owner_id = (select procurement.current_actor_id()))', t);
    execute format('alter policy owner_insert on procurement.%I to procurement_runtime with check (owner_id = (select procurement.current_actor_id()))', t);
  end loop;
  foreach t in array array['projects','analyses','analysis_heads','vendors','offers','latest_calculation_runs'] loop
    execute format('alter policy owner_update on procurement.%I to procurement_runtime using (owner_id = (select procurement.current_actor_id())) with check (owner_id = (select procurement.current_actor_id()))', t);
  end loop;
end $$;
