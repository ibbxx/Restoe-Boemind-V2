-- Allow an owner to remove a Project after its current Analyses are removed.
create policy owner_delete
on procurement.projects
for delete
to procurement_runtime
using (
  owner_id = (select procurement.current_actor_id())
);

grant delete on procurement.projects to procurement_runtime;
