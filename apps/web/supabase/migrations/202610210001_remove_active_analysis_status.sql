-- Application startup never migrates; apply this file only to an explicitly selected database.
-- Existing ACTIVE analyses were unfinished, so they remain editable as DRAFT.
update procurement.analyses
set status = 'DRAFT'
where status = 'ACTIVE';

alter table procurement.analyses
  drop constraint analyses_status_check,
  add constraint analyses_status_check
    check (status in ('DRAFT', 'HOLD', 'COMPLETED', 'CANCELLED'));
