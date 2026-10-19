-- Operator cutover only. Stop old writers before applying; application startup never migrates.
-- Applied in the migration runner's transaction. Any failed assertion rolls back the deletion.
set local lock_timeout = '10s';
set local statement_timeout = '120s';
lock table procurement.projects, procurement.analyses, procurement.current_workbooks in access exclusive mode;

do $$ begin
  if exists (select 1 from procurement.analyses a left join procurement.current_workbooks c on c.analysis_id=a.id
    where c.analysis_id is null) then
    raise exception 'Every existing Analysis must have current data before archives can be removed';
  end if;
end $$;

-- Temporary conversion is deliberately unavailable to the application role.
create function pg_temp.current_only_data(s jsonb, configuration jsonb) returns jsonb language plpgsql as $$
declare
  state jsonb; inventory jsonb; offers jsonb := '[]'; worksheets jsonb := '[]'; tables jsonb; cells jsonb;
  o jsonb; w jsonb; t jsonb; c jsonb; v jsonb; binding jsonb; vals jsonb; row_label text; label text;
  refs jsonb := '{}'; value_id text; old_ids jsonb := '{}'; selected jsonb; selections jsonb := '{}';
  profiles jsonb := '{}'; p text; f jsonb; m jsonb; formulas jsonb := '[]'; mappings jsonb := '[]';
begin
  for v in select value from jsonb_array_elements(s#>'{analysis,offerRevisions}') loop
    old_ids := old_ids || jsonb_build_object(v->>'id', v->'offerId');
  end loop;
  for o in select value from jsonb_array_elements(s#>'{analysis,offers}') loop
    vals := '[]';
    select value into binding from jsonb_array_elements(coalesce(s#>'{workbook,offers}','[]')) where value->>'offerId'=o->>'id';
    for t in select tb.value from jsonb_array_elements(s->'worksheets') ws,
      lateral jsonb_array_elements(ws.value->'tables') tb where ws.value->>'stage'='EVALUASI_VENDOR' loop
      for c in select value from jsonb_array_elements(t->'cells') loop
        select value->>'label' into row_label from jsonb_array_elements(t->'rows') where value->>'id'=c->>'rowId';
        if (case when binding is not null then c->>'columnId'=binding->>'columnId'
          else position('|vendor:'||(o->>'id')||':' in row_label)>0 end) and c#>>'{source,kind}'='INPUT' then
          label := case when binding is not null then c->>'id' else split_part(row_label,'|vendor:'||(o->>'id')||':',2) end;
          select vv.value->>'id' into value_id from jsonb_array_elements(s#>'{analysis,offerRevisions}') rr,
            lateral jsonb_array_elements(rr.value->'values') vv
            where rr.value->>'offerId'=o->>'id' and vv.value->>'label'=label
            order by (rr.value->>'revisionNumber')::bigint desc limit 1;
          value_id := coalesce(value_id,gen_random_uuid()::text);
          vals := vals || jsonb_build_array(jsonb_build_object('id',value_id,'label',label,'input',c#>'{source,input}'));
          refs := refs || jsonb_build_object(c->>'id',jsonb_build_object('kind','OFFER_VALUE','offerId',o->'id','valueId',value_id));
        end if;
      end loop;
    end loop;
    offers := offers || jsonb_build_array(o || jsonb_build_object('values',vals));
  end loop;
  for w in select value from jsonb_array_elements(s->'worksheets') loop
    tables := '[]';
    for t in select value from jsonb_array_elements(w->'tables') loop
      cells := '[]';
      for c in select value from jsonb_array_elements(t->'cells') loop
        cells := cells || jsonb_build_array(case when refs ? (c->>'id') then jsonb_set(c,'{source}',refs->(c->>'id')) else c end);
      end loop;
      tables := tables || jsonb_build_array(t || jsonb_build_object('cells',cells,'merges',coalesce(t->'merges','[]')));
    end loop;
    worksheets := worksheets || jsonb_build_array(w || jsonb_build_object('tables',tables));
  end loop;
  foreach p in array array['INU','SOLAR_BAWAH'] loop
    profiles := profiles || jsonb_build_object(p,((s#>array['profiles',p])-'reviewContext') ||
      jsonb_build_object('hppBase',(s#>array['profiles',p,'hppBase'])-'contextRunId'));
    selections := selections || jsonb_build_object(p,coalesce(old_ids->(s#>>array['workbook','selections',p]),'null'));
  end loop;
  for f in select value from jsonb_array_elements(s->'formulas') loop
    formulas := formulas || jsonb_build_array(f-'versionId');
  end loop;
  for m in select value from jsonb_array_elements(s->'mappings') loop
    m := (m-'versionId') || jsonb_build_object('provenance',((m->'provenance')-'changeEventId') ||
      jsonb_build_object('sourceRef',coalesce(old_ids->(m#>>'{provenance,sourceRef}'),m#>'{provenance,sourceRef}')));
    if m->>'sourceComponent' like 'offer-revision:%' then
      m := m || jsonb_build_object('sourceComponent','vendor-live:'||(m#>>'{provenance,sourceRef}')||':'||(m->>'sourceCellId'));
    end if;
    mappings := mappings || jsonb_build_array(m);
  end loop;
  inventory := jsonb_build_object('vendors',s#>'{analysis,vendors}','offers',offers);
  selected := coalesce(old_ids->(s->>'selectedOfferRevisionId'),'null');
  state := (s-array['project','projectId','analysisId','selectedOfferRevisionId','calculationRunRefs']) ||
    jsonb_build_object('analysis',inventory,'worksheets',worksheets,'formulas',formulas,'mappings',mappings,'profiles',profiles,'selectedOfferId',selected);
  if s ? 'workbook' then
    state := jsonb_set(state,'{workbook}',((s->'workbook')-'configuration') || jsonb_build_object('selections',selections,
      'offers',(select coalesce(jsonb_agg(value-'revisionId'),'[]') from jsonb_array_elements(s#>'{workbook,offers}'))));
  end if;
  return jsonb_build_object('schemaVersion',1,'state',state,'configuration',configuration);
end $$;

alter table procurement.current_workbooks add column data jsonb;
update procurement.current_workbooks set data=pg_temp.current_only_data(snapshot,configuration);
alter table procurement.current_workbooks alter column data set not null;
alter table procurement.current_workbooks drop column snapshot, drop column configuration;
alter table procurement.current_workbooks add constraint current_workbooks_data_check check ((
  jsonb_typeof(data)='object' and data ?& array['schemaVersion','state','configuration']
  and data->'schemaVersion'='1'::jsonb and jsonb_typeof(data->'state')='object'
  and data#>'{state,schemaVersion}' in ('2'::jsonb,'3'::jsonb)
  and not (data->'state' ?| array['project','projectId','analysisId','selectedOfferRevisionId','calculationRunRefs'])
  and not (data#>'{state,analysis}' ?| array['analysis','offerRevisions'])
  and jsonb_typeof(data#>'{state,analysis,offers}')='array'
  and not (coalesce(data#>'{state,workbook}','{}') ? 'configuration')
  and (data->'configuration'='null'::jsonb or jsonb_typeof(data->'configuration')='object')
) is true);
grant update(data) on procurement.current_workbooks to procurement_runtime;
create index analyses_project_owner_idx on procurement.analyses(project_id,owner_id);

drop table procurement.latest_calculation_runs, procurement.calculation_runs, procurement.analysis_heads,
  procurement.change_events, procurement.revision_mutations, procurement.revisions, procurement.workbook_snapshots,
  procurement.formula_versions, procurement.mapping_versions, procurement.offer_revisions, procurement.offers, procurement.vendors;
drop function procurement.reject_history_mutation();
drop function pg_temp.current_only_data(jsonb,jsonb);

-- Recreate only explicit owner policies; no history RPC, trigger, or implicit public access.
do $$ declare t text; p record; begin
  foreach t in array array['projects','analyses','current_workbooks'] loop
    for p in select policyname from pg_policies where schemaname='procurement' and tablename=t loop
      execute format('drop policy %I on procurement.%I',p.policyname,t);
    end loop;
    execute format('alter table procurement.%I enable row level security',t);
    execute format('alter table procurement.%I force row level security',t);
    execute format('revoke all on procurement.%I from public,anon,authenticated',t);
    execute format('create policy owner_read on procurement.%I for select to procurement_runtime using (owner_id=(select procurement.current_actor_id()))',t);
    execute format('create policy owner_insert on procurement.%I for insert to procurement_runtime with check (owner_id=(select procurement.current_actor_id()))',t);
    execute format('create policy owner_update on procurement.%I for update to procurement_runtime using (owner_id=(select procurement.current_actor_id())) with check (owner_id=(select procurement.current_actor_id()))',t);
  end loop;
end $$;
