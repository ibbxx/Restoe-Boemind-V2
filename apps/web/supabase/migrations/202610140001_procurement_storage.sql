-- Additive migration. Apply only to an explicitly selected database; application startup never migrates.
-- Supabase CLI owns the transaction, including its migration-ledger INSERT; do not commit inside this file.

create schema procurement;
revoke all on schema procurement from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'procurement_runtime') then
    create role procurement_runtime nologin noinherit nosuperuser nobypassrls nocreaterole nocreatedb noreplication;
  end if;
  if exists (select 1 from pg_roles where rolname = 'procurement_runtime'
    and (rolsuper or rolbypassrls or rolcanlogin or rolinherit or rolcreaterole or rolcreatedb or rolreplication))
    or exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'procurement_runtime') then
    raise exception 'procurement_runtime must be a non-administrative NOLOGIN/NOINHERIT role without other memberships';
  end if;
  -- Application login provisioning/membership is a separate, explicitly authorized operator action.
end $$;

grant usage on schema procurement, auth to procurement_runtime;
grant execute on function auth.uid() to procurement_runtime;

create table procurement.projects (
  id uuid primary key,
  owner_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  unique (id, owner_id)
);
create table procurement.analyses (
  id uuid primary key,
  project_id uuid not null,
  owner_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  unique (id, owner_id),
  foreign key (project_id, owner_id) references procurement.projects(id, owner_id)
);
create table procurement.workbook_snapshots (
  id uuid primary key,
  analysis_id uuid not null,
  owner_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ?& array[
    'schemaVersion','id','projectId','project','analysisId','analysis','mappings','selectedOfferRevisionId',
    'activeProfile','profiles','worksheets','formulas','policy','calculationRunRefs']),
  unique (analysis_id, id),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  check ((payload->'schemaVersion' = '2'::jsonb and (payload->>'id')::uuid = id and (payload->>'analysisId')::uuid = analysis_id
    and (payload->'project') ?& array['id','name']
    and (payload#>>'{project,id}')::uuid = (payload->>'projectId')::uuid
    and (payload->'analysis') ?& array['analysis','vendors','offers','offerRevisions']
    and (payload#>'{analysis,analysis}') ?& array['id','projectId','name']
    and (payload#>>'{analysis,analysis,id}')::uuid = analysis_id
    and (payload#>>'{analysis,analysis,projectId}')::uuid = (payload->>'projectId')::uuid
    and (payload->'profiles') ?& array['INU','SOLAR_BAWAH']
    and (payload->'policy') ? 'status') is true)
);
create table procurement.revisions (
  id uuid primary key,
  analysis_id uuid not null,
  owner_id uuid not null,
  snapshot_id uuid not null unique,
  parent_revision_id uuid,
  ordinal bigint not null check (ordinal > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ?& array[
    'projectId','analysisId','actorId','mutationId','revision','changeEvent']),
  unique (analysis_id, id),
  unique (analysis_id, id, snapshot_id),
  unique (analysis_id, ordinal),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, snapshot_id) references procurement.workbook_snapshots(analysis_id, id),
  foreign key (analysis_id, parent_revision_id) references procurement.revisions(analysis_id, id),
  check (((payload->'revision') ?& array['kind','revisionId','snapshot','run','parentRevisionId','savedAt','restoredFrom']
    and payload#>>'{revision,kind}' = 'SAVED_DRAFT' and (payload#>>'{revision,revisionId}')::uuid = id
    and payload#>'{revision,run}' = 'null'::jsonb
    and (payload#>>'{revision,snapshot,id}')::uuid = snapshot_id
    and (payload#>>'{revision,snapshot,analysisId}')::uuid = analysis_id
    and (payload->>'analysisId')::uuid = analysis_id and (payload->>'actorId')::uuid = owner_id
    and (payload#>>'{revision,parentRevisionId}')::uuid is not distinct from parent_revision_id) is true)
);
create table procurement.analysis_heads (
  analysis_id uuid primary key,
  owner_id uuid not null,
  revision_id uuid not null,
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, revision_id) references procurement.revisions(analysis_id, id)
);
create table procurement.change_events (
  id uuid primary key,
  analysis_id uuid not null,
  owner_id uuid not null,
  revision_id uuid not null unique,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ?& array[
    'id','actorId','occurredAt','targetProjectId','targetAnalysisId','changes','action',
    'revisionBeforeId','revisionAfterId','before','after','reason']),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, revision_id) references procurement.revisions(analysis_id, id),
  check (((payload->>'id')::uuid = id and (payload->>'actorId')::uuid = owner_id
    and (payload->>'targetAnalysisId')::uuid = analysis_id and (payload->>'revisionAfterId')::uuid = revision_id
    and payload->>'action' in ('SAVE_DRAFT','RESTORE')) is true)
);
create table procurement.revision_mutations (
  analysis_id uuid not null,
  mutation_id uuid not null,
  owner_id uuid not null,
  request_signature text not null,
  revision_id uuid not null,
  primary key (analysis_id, mutation_id),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, revision_id) references procurement.revisions(analysis_id, id)
);
create table procurement.vendors (
  id uuid primary key,
  analysis_id uuid not null,
  owner_id uuid not null,
  name text not null,
  unique (analysis_id, id),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id)
);
create table procurement.offers (
  id uuid primary key,
  analysis_id uuid not null,
  owner_id uuid not null,
  vendor_id uuid not null,
  label text not null,
  unique (analysis_id, id),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, vendor_id) references procurement.vendors(analysis_id, id)
);
create table procurement.offer_revisions (
  id uuid primary key,
  analysis_id uuid not null,
  owner_id uuid not null,
  offer_id uuid not null,
  -- Match the domain's positive JavaScript safe-integer range without narrowing historical values.
  revision_number bigint not null check (revision_number between 1 and 9007199254740991),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ?& array['id','offerId','revisionNumber','values']),
  unique (offer_id, revision_number),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, offer_id) references procurement.offers(analysis_id, id),
  check (((payload->>'id')::uuid = id and (payload->>'offerId')::uuid = offer_id
    and jsonb_typeof(payload->'revisionNumber') = 'number' and (payload->>'revisionNumber')::numeric = revision_number
    and jsonb_typeof(payload->'values') = 'array') is true)
);
create table procurement.mapping_versions (
  version_id uuid primary key,
  mapping_id uuid not null,
  analysis_id uuid not null,
  owner_id uuid not null,
  scope text not null check (scope in ('INU', 'SOLAR_BAWAH', 'SHARED')),
  status text not null check (status in ('DRAFT', 'ACTIVE', 'REJECTED', 'NEEDS_REVIEW')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ?& array[
    'id','versionId','analysisId','scope','sourceCellId','targetCellId','sourceComponent',
    'transformExpression','sourceUnit','targetUnit','status','provenance']),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  check (((payload->>'versionId')::uuid = version_id and (payload->>'id')::uuid = mapping_id
    and (payload->>'analysisId')::uuid = analysis_id and payload->>'scope' = scope and payload->>'status' = status
    and (payload->'provenance') ?& array['actorId','changeEventId','sourceRef','reason']
    and (payload#>>'{provenance,actorId}')::uuid is not null
    and (payload#>>'{provenance,changeEventId}')::uuid is not null) is true)
);
create table procurement.formula_versions (
  version_id uuid primary key,
  formula_id uuid not null,
  analysis_id uuid not null,
  owner_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ?& array[
    'id','versionId','targetCellId','expression','referenceCellIds','sourceKind','activation','provenance']),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  check (((payload->>'versionId')::uuid = version_id and (payload->>'id')::uuid = formula_id) is true)
);
create table procurement.calculation_runs (
  id uuid primary key,
  analysis_id uuid not null,
  owner_id uuid not null,
  revision_id uuid not null,
  snapshot_id uuid not null,
  profile text not null check (profile in ('INU', 'SOLAR_BAWAH')),
  engine_version text not null,
  policy_version_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ?& array[
    'id','snapshotId','engineVersion','policyVersionId','status','diagnostics','results','evaluatedCellIds','manifest']),
  unique (analysis_id, id),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, revision_id, snapshot_id) references procurement.revisions(analysis_id, id, snapshot_id),
  unique (analysis_id, id, profile),
  check ((payload->>'status' in ('NONFINAL', 'ERROR') and (payload->>'id')::uuid = id
    and (payload->'manifest') ?& array['revisionId','snapshot','configuration','signatures']
    and (payload#>>'{manifest,revisionId}')::uuid = revision_id and (payload->>'snapshotId')::uuid = snapshot_id
    and (payload#>>'{manifest,snapshot,id}')::uuid = snapshot_id
    and (payload#>>'{manifest,snapshot,analysisId}')::uuid = analysis_id
    and payload#>>'{manifest,snapshot,activeProfile}' = profile and payload->>'engineVersion' = engine_version
    and (payload->>'policyVersionId')::uuid is not distinct from policy_version_id) is true)
);
create table procurement.latest_calculation_runs (
  analysis_id uuid not null,
  profile text not null check (profile in ('INU', 'SOLAR_BAWAH')),
  owner_id uuid not null,
  run_id uuid not null,
  primary key (analysis_id, profile),
  foreign key (analysis_id, owner_id) references procurement.analyses(id, owner_id),
  foreign key (analysis_id, run_id, profile) references procurement.calculation_runs(analysis_id, id, profile)
);

create function procurement.reject_history_mutation() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Historical rows are immutable; append a new revision/version' using errcode = '23514';
end $$;
revoke all on function procurement.reject_history_mutation() from public;

-- Do not inherit broad table privileges from an operator's ALTER DEFAULT PRIVILEGES.
revoke all on all tables in schema procurement from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['projects','analyses','workbook_snapshots','revisions','analysis_heads','change_events',
    'revision_mutations','vendors','offers','offer_revisions','mapping_versions','formula_versions','calculation_runs','latest_calculation_runs'] loop
    execute format('alter table procurement.%I enable row level security', t);
    execute format('alter table procurement.%I force row level security', t);
    execute format('create policy owner_read on procurement.%I for select to procurement_runtime using (owner_id = (select auth.uid()))', t);
    execute format('create policy owner_insert on procurement.%I for insert to procurement_runtime with check (owner_id = (select auth.uid()))', t);
    execute format('grant select, insert on procurement.%I to procurement_runtime', t);
    execute format('create index on procurement.%I (owner_id)', t);
  end loop;
  foreach t in array array['projects','analyses','analysis_heads','vendors','offers','latest_calculation_runs'] loop
    execute format('create policy owner_update on procurement.%I for update to procurement_runtime using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
  end loop;
  foreach t in array array['workbook_snapshots','revisions','change_events','revision_mutations','offer_revisions','mapping_versions','formula_versions','calculation_runs'] loop
    execute format('create trigger immutable_history before update or delete on procurement.%I for each row execute function procurement.reject_history_mutation()', t);
  end loop;
end $$;
grant update (name) on procurement.projects, procurement.analyses, procurement.vendors to procurement_runtime;
grant update (label, vendor_id) on procurement.offers to procurement_runtime;
grant update (revision_id) on procurement.analysis_heads to procurement_runtime;
grant update (run_id) on procurement.latest_calculation_runs to procurement_runtime;
