-- Shared workspace: every authenticated account reads and edits the same current rows.
-- owner_id remains as the stable workspace scope; saved_by records the last actor.
alter table procurement.current_workbooks drop constraint current_workbooks_check;
alter table procurement.current_workbooks drop constraint current_workbooks_analysis_id_project_id_owner_id_fkey;
alter table procurement.analyses drop constraint analyses_project_id_owner_id_fkey;

update procurement.projects
set owner_id = '00000000-0000-4000-8000-000000000001';
update procurement.analyses
set owner_id = '00000000-0000-4000-8000-000000000001';
update procurement.current_workbooks
set owner_id = '00000000-0000-4000-8000-000000000001';

alter table procurement.analyses
  add constraint analyses_project_id_owner_id_fkey
  foreign key (project_id, owner_id) references procurement.projects(id, owner_id);
alter table procurement.current_workbooks
  add constraint current_workbooks_analysis_id_project_id_owner_id_fkey
  foreign key (analysis_id, project_id, owner_id)
  references procurement.analyses(id, project_id, owner_id);

do $$
declare t text;
begin
  foreach t in array array['projects','analyses','current_workbooks'] loop
    execute format('drop policy if exists owner_read on procurement.%I', t);
    execute format('drop policy if exists owner_insert on procurement.%I', t);
    execute format('drop policy if exists owner_update on procurement.%I', t);
    execute format('drop policy if exists owner_delete on procurement.%I', t);
    execute format('create policy owner_read on procurement.%I for select to procurement_runtime using ((select procurement.current_actor_id()) is not null)', t);
    execute format('create policy owner_insert on procurement.%I for insert to procurement_runtime with check ((select procurement.current_actor_id()) is not null)', t);
    execute format('create policy owner_update on procurement.%I for update to procurement_runtime using ((select procurement.current_actor_id()) is not null) with check ((select procurement.current_actor_id()) is not null)', t);
    execute format('create policy owner_delete on procurement.%I for delete to procurement_runtime using ((select procurement.current_actor_id()) is not null)', t);
  end loop;
end $$;
