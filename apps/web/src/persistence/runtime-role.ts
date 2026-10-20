import type postgres from "postgres";

export class RuntimeDatabaseRoleError extends Error {
  readonly code = "UNSAFE_DATABASE_ROLE";
  constructor() { super("Database login or runtime privileges do not satisfy the runtime role policy."); }
}

export class WorkbookUpgradeRequiredError extends Error {
  constructor() { super("Current workbook storage is not installed."); }
}

// Check each transaction/connection, not just startup: pooled sessions and grants can change.
export async function enterRuntimeRole(tx: postgres.TransactionSql): Promise<void> {
  await tx`set local search_path = pg_catalog, pg_temp`;
  const [identity] = await tx`with recursive reachable(oid) as (
    select oid from pg_roles where rolname = session_user
    union select m.roleid from pg_auth_members m join reachable r on r.oid = m.member
  ) select session_user = current_user
    and l.rolcanlogin and not (l.rolsuper or l.rolbypassrls or l.rolcreaterole or l.rolcreatedb or l.rolreplication or l.rolinherit)
    and not (r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolinherit)
    and pg_has_role(l.oid, r.oid, 'MEMBER') and not pg_has_role(l.oid, r.oid, 'USAGE')
    and not exists (select 1 from reachable where oid not in (l.oid, r.oid))
    and not exists (select 1 from pg_auth_members m join reachable x on x.oid = m.member where m.admin_option)
    and not exists (select 1 from pg_auth_members where member = r.oid)
    as safe from pg_roles l cross join pg_roles r
    where l.rolname = session_user and r.rolname = 'procurement_runtime'`;
  if (identity?.safe !== true) throw new RuntimeDatabaseRoleError();
  try { await tx`set local role procurement_runtime`; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42501") throw new RuntimeDatabaseRoleError();
    throw error;
  }
  await tx`set local row_security = on`;
  const [privileges] = await tx`with actors as (
    select oid from pg_roles where rolname in (session_user, current_user)
  ), objects as (
    select c.*, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'procurement' and c.relkind in ('r','p','v','m','f','S')
  ), updates(table_name, column_name) as (values ('projects','name'),('analyses','name'),
    ('current_workbooks','data'),('current_workbooks','version'),
    ('current_workbooks','saved_at'),('current_workbooks','saved_by'),('current_workbooks','mutation_id'),('current_workbooks','request_signature'))
  select current_user = 'procurement_runtime' and current_setting('row_security') = 'on'
    and has_schema_privilege(current_user, 'procurement', 'USAGE')
    and exists (select 1 from pg_proc p where p.oid = to_regprocedure('procurement.current_actor_id()')
      and not p.prosecdef and p.provolatile = 's' and p.prorettype = 'uuid'::regtype
      and has_function_privilege(current_user, p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    and not has_schema_privilege(session_user, 'procurement', 'USAGE')
    and not exists (select 1 from pg_database where datdba in (select oid from actors))
    and not exists (select 1 from pg_namespace n where n.nspowner in (select oid from actors)
      or (n.nspname !~ '^pg_temp_' and exists (select 1 from actors a where has_schema_privilege(a.oid, n.oid, 'CREATE'))))
    and not exists (select 1 from pg_class where relowner in (select oid from actors))
    and not exists (select 1 from pg_proc where proowner in (select oid from actors))
    and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'procurement' and p.prosecdef and has_function_privilege(current_user, p.oid, 'EXECUTE'))
    and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a where n.nspname <> 'procurement' and n.nspname !~ '^pg_'
      and n.nspname <> 'information_schema' and a.grantee in (select oid from actors))
    and not exists (select 1 from unnest(array['projects','analyses','current_workbooks']) expected(name)
      where not exists (select 1 from objects o where o.relname = expected.name and o.relkind = 'r'
        and o.relrowsecurity and o.relforcerowsecurity and row_security_active(o.oid)
        and has_table_privilege(current_user, o.oid, 'SELECT') and has_table_privilege(current_user, o.oid, 'INSERT')))
    and not exists (select 1 from objects o where o.relname not in ('projects','analyses','current_workbooks')
      and (has_any_column_privilege(current_user, o.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
        or has_table_privilege(current_user, o.oid, 'DELETE,TRUNCATE,TRIGGER')))
    and not exists (select 1 from objects o where o.relname not in ('projects','analyses','current_workbooks') and
      has_table_privilege(current_user, o.oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(current_user, o.oid, 'REFERENCES')
      or has_any_column_privilege(session_user, o.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
    and not exists (select 1 from objects o join pg_attribute a on a.attrelid = o.oid where a.attnum > 0 and not a.attisdropped
      and has_column_privilege(current_user, o.oid, a.attnum, 'UPDATE')
      and (o.relname::text, a.attname::text) not in (select * from updates))
    and not exists (select 1 from updates u where not exists (select 1 from objects o join pg_attribute a on a.attrelid = o.oid
      where o.relname = u.table_name and a.attname = u.column_name and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(current_user, o.oid, a.attnum, 'UPDATE')))
    and not exists (select 1 from objects o cross join lateral aclexplode(o.relacl) a
      where (a.grantee = 0 or a.grantee in (select oid from actors))
        and (a.is_grantable or (a.privilege_type not in ('SELECT','INSERT')
          and not (a.privilege_type = 'DELETE' and o.relname in ('projects','analyses','current_workbooks')))))
    and not exists (select 1 from objects o join pg_attribute c on c.attrelid = o.oid cross join lateral aclexplode(c.attacl) a
      where (a.grantee = 0 or a.grantee in (select oid from actors)) and a.is_grantable)
    as safe, exists (select 1 from information_schema.columns where table_schema = 'procurement'
      and table_name = 'current_workbooks' and column_name = 'data') as storage_ready`;
  if (privileges?.storage_ready !== true) throw new WorkbookUpgradeRequiredError();
  if (privileges?.safe !== true) throw new RuntimeDatabaseRoleError();
}
