-- Application startup never migrates; apply this file only to an explicitly selected database.
alter table procurement.analyses
  add column status text not null default 'DRAFT'
    check (status in ('DRAFT', 'ACTIVE', 'HOLD', 'COMPLETED', 'CANCELLED'));

grant select on procurement.analyses to procurement_runtime;
grant update (name, status) on procurement.analyses to procurement_runtime;
