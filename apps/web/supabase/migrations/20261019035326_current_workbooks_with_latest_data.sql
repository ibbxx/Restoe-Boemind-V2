-- Stop application writes before applying this migration and running the backfill command.
-- Existing archives remain untouched; the runtime loses access to them.
alter table procurement.analyses add constraint analyses_project_owner_key unique (id, project_id, owner_id);

create table procurement.current_workbooks (
  analysis_id uuid primary key,
  project_id uuid not null,
  owner_id uuid not null,
  snapshot jsonb not null,
  configuration jsonb,
  version uuid not null,
  saved_at timestamptz not null,
  saved_by uuid not null,
  mutation_id uuid not null,
  request_signature text not null check (request_signature ~ '^[0-9a-f]{64}$'),
  foreign key (analysis_id, project_id, owner_id) references procurement.analyses(id, project_id, owner_id),
  check (saved_by = owner_id),
  check ((jsonb_typeof(snapshot) = 'object'
    and snapshot ?& array['schemaVersion','id','projectId','project','analysisId','analysis','worksheets','formulas','profiles','policy','mappings','calculationRunRefs','selectedOfferRevisionId','activeProfile']
    and snapshot->'schemaVersion' in ('2'::jsonb, '3'::jsonb)
    and (snapshot->>'analysisId')::uuid = analysis_id
    and (snapshot->>'projectId')::uuid = project_id
    and (snapshot#>>'{project,id}')::uuid = project_id
    and (snapshot#>>'{analysis,analysis,id}')::uuid = analysis_id
    and (snapshot#>>'{analysis,analysis,projectId}')::uuid = project_id
    and snapshot->'calculationRunRefs' = '[]'::jsonb
    and snapshot#>'{profiles,INU,reviewContext}' = 'null'::jsonb
    and snapshot#>'{profiles,SOLAR_BAWAH,reviewContext}' = 'null'::jsonb
    and snapshot#>'{profiles,INU,hppBase,contextRunId}' = 'null'::jsonb
    and snapshot#>'{profiles,SOLAR_BAWAH,hppBase,contextRunId}' = 'null'::jsonb) is true),
  check ((case when configuration is null then snapshot#>>'{policy,status}' = 'UNCONFIGURED'
    else jsonb_typeof(configuration) = 'object'
      and configuration ?& array['version','policyVersionId','decimal','units','aggregates','selectionDependentCellIds']
      and snapshot#>>'{policy,status}' = 'CONFIGURED'
      and (configuration->>'policyVersionId')::uuid = (snapshot#>>'{policy,versionId}')::uuid end) is true),
  check ((snapshot->'schemaVersion' <> '3'::jsonb or snapshot#>'{workbook,configuration}' = coalesce(configuration, 'null'::jsonb)) is true)
);
create index current_workbooks_owner_idx on procurement.current_workbooks(owner_id);
alter table procurement.current_workbooks enable row level security;
alter table procurement.current_workbooks force row level security;
revoke all on procurement.current_workbooks from public, anon, authenticated, procurement_runtime;
create policy owner_read on procurement.current_workbooks for select to procurement_runtime
  using (owner_id = (select procurement.current_actor_id()));
create policy owner_insert on procurement.current_workbooks for insert to procurement_runtime
  with check (owner_id = (select procurement.current_actor_id()));
create policy owner_update on procurement.current_workbooks for update to procurement_runtime
  using (owner_id = (select procurement.current_actor_id()))
  with check (owner_id = (select procurement.current_actor_id()));
grant select, insert on procurement.current_workbooks to procurement_runtime;
grant update (snapshot, configuration, version, saved_at, saved_by, mutation_id, request_signature)
  on procurement.current_workbooks to procurement_runtime;

do $$
declare t text; c record;
begin
  foreach t in array array['workbook_snapshots','revisions','analysis_heads','change_events','revision_mutations',
    'vendors','offers','offer_revisions','mapping_versions','formula_versions','calculation_runs','latest_calculation_runs'] loop
    execute format('revoke all on procurement.%I from procurement_runtime', t);
    -- Table revocation alone does not remove separately granted column privileges.
    for c in select attname from pg_attribute where attrelid = format('procurement.%I', t)::regclass and attnum > 0 and not attisdropped loop
      execute format('revoke all (%I) on procurement.%I from procurement_runtime', c.attname, t);
    end loop;
  end loop;
end $$;
