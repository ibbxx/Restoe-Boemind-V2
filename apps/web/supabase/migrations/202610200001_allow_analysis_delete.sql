-- Allow an owner to remove one current Analysis from the application.
create policy owner_delete on procurement.current_workbooks for delete to procurement_runtime
  using (owner_id = (select procurement.current_actor_id()));
create policy owner_delete on procurement.analyses for delete to procurement_runtime
  using (owner_id = (select procurement.current_actor_id()));

grant delete on procurement.current_workbooks, procurement.analyses to procurement_runtime;
