import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startTestCluster } from "./postgres-test-cluster.ts";
import { fixture, id } from "./phase2-fixture.ts";
import type { Mutable } from "./phase2-fixture.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import type { SaveOutcome } from "../src/application/contracts.ts";
import { canonicalJson, captureSnapshot } from "../src/domain/snapshots.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import { AccessDeniedError, PostgresRevisionRepository } from "../src/persistence/postgres-revision-repository.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import type { EngineConfiguration } from "../src/engine/contracts.ts";
import { createWorkbookHandler } from "../src/server/workbook-handler.ts";
import { enterRuntimeRole } from "../src/persistence/runtime-role.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import postgres from "postgres";

const migration = readFileSync(new URL("../supabase/migrations/202610140001_procurement_storage.sql", import.meta.url), "utf8");
const migrationVersion = "202610140001";
const actorClaimsVersion = "20261015023734";
const actorClaimsMigration = readFileSync(new URL("../supabase/migrations/20261015023734_procurement_actor_claims.sql", import.meta.url), "utf8");

// Exercise the actual CLI transaction/ledger runner, not a mock or an independent wrapper.
async function migrationFixture(t: TestContext) {
  assert.equal(execFileSync("supabase", ["--version"], { encoding: "utf8" }).trim(), "2.109.1");
  const cluster = await startTestCluster();
  const socket = cluster.sql.options.host[0]!;
  assert.ok(socket.startsWith("/"));
  const sql = postgres({ host: socket, port: cluster.port, database: "migration_atomicity", username: "postgres",
    prepare: false, max: 1, onnotice: () => {} });
  t.after(async () => { await sql.end(); await cluster.stop(); });
  await cluster.sql.unsafe("alter role procurement_runtime rename to procurement_existing_fixture");
  await cluster.sql.unsafe("create database migration_atomicity");
  await sql.unsafe(`revoke create on schema public from public;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
    $$`);
  const [server] = await sql`select current_setting('server_version') as version`;
  t.diagnostic(`Migration test server: PostgreSQL ${server!.version}; Supabase CLI 2.109.1`);
  const workdir = mkdtempSync(join(socket, "cli-"));
  const migrations = join(workdir, "supabase", "migrations");
  mkdirSync(migrations, { recursive: true });
  // Only the newly initialized local cluster; the password never appears in CLI arguments.
  const url = `postgresql://postgres@127.0.0.1:${cluster.port}/migration_atomicity?sslmode=verify-full`;
  const cliEnvironment = { ...process.env, PGPASSWORD: cluster.password, PGSSLROOTCERT: cluster.certificate };
  function run(source = migration, repair = false) {
    writeFileSync(join(migrations, migrationVersion + "_procurement_storage.sql"), source);
    return spawnSync("supabase", ["migration", repair ? "repair" : "up",
      ...(repair ? [migrationVersion, "--status", "applied"] : []),
      "--db-url", url, "--workdir", workdir, "--yes", "--agent", "no"],
    { encoding: "utf8", timeout: 30000, env: cliEnvironment });
  }
  function runActorClaims(source = actorClaimsMigration, dryRun = false) {
    writeFileSync(join(migrations, actorClaimsVersion + "_procurement_actor_claims.sql"), source);
    return spawnSync("supabase", [...(dryRun ? ["db", "push", "--dry-run"] : ["migration", "up"]),
      "--db-url", url, "--workdir", workdir, "--yes", "--agent", "no"],
    { encoding: "utf8", timeout: 30000, env: cliEnvironment });
  }
  async function state() {
    const [row] = await sql`select exists(select 1 from pg_namespace where nspname = 'procurement') as schema,
      exists(select 1 from pg_roles where rolname = 'procurement_runtime') as role,
      (select count(*)::int from pg_tables where schemaname = 'procurement') as tables,
      (select count(*)::int from supabase_migrations.schema_migrations where version = ${migrationVersion}) as ledger`;
    return row;
  }
  async function failLedger(timing: "before" | "after") {
    await sql.unsafe(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);
      create function public.fail_ledger() returns trigger language plpgsql as $$
        begin raise exception 'injected ${timing} ledger failure' using errcode = '23514'; end $$;
      create ${timing === "after" ? "constraint" : ""} trigger fail_ledger ${timing} insert on supabase_migrations.schema_migrations
        ${timing === "after" ? "deferrable initially deferred" : ""}
        for each row execute function public.fail_ledger()`);
  }
  return { sql, run, runActorClaims, state, failLedger };
}

describe("Supabase CLI 2.109.1 migration/ledger atomicity (isolated PostgreSQL)",
  { skip: process.env.RUN_POSTGRES_TESTS !== "1" }, () => {
    it("rolls back schema, newly created runtime role and tables on failure before ledger INSERT", async t => {
      const f = await migrationFixture(t);
      const result = f.run(migration + "\nselect 1/0;");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /select 1\/0/);
      assert.deepEqual(await f.state(), { schema: false, role: false, tables: 0, ledger: 0 });
    });
    for (const timing of ["before", "after"] as const) {
      it(`rolls back DDL and ledger when an ${timing.toUpperCase()} INSERT ledger trigger fails`, async t => {
        const f = await migrationFixture(t);
        await f.failLedger(timing);
        const result = f.run();
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /(?:INSERT INTO supabase_migrations.schema_migrations|Failed to execute statement)/);
        assert.deepEqual(await f.state(), { schema: false, role: false, tables: 0, ledger: 0 });
      });
    }
    it("commits DDL and ledger together; a CLI retry does not rerun the initial migration", async t => {
      const f = await migrationFixture(t);
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await f.state(), { schema: true, role: true, tables: 14, ledger: 1 });
      const catalog = await f.sql`select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'procurement' and c.relkind = 'r' order by c.relname`;
      assert.ok(catalog.every(c => c.relrowsecurity && c.relforcerowsecurity));
      const [role] = await f.sql`select rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
        from pg_roles where rolname = 'procurement_runtime'`;
      assert.ok(Object.values(role!).every(value => value === false));
      const [ledger] = await f.sql`select name, statements from supabase_migrations.schema_migrations where version = ${migrationVersion}`;
      assert.equal(ledger!.name, "procurement_storage");
      assert.ok((ledger!.statements as string[]).length > 20);
      const retry = f.run();
      assert.equal(retry.status, 0, retry.stderr);
      assert.deepEqual(await f.state(), { schema: true, role: true, tables: 14, ledger: 1 });
      assert.deepEqual(await f.sql`select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'procurement' and c.relkind = 'r' order by c.relname`, catalog);
    });
    it("reproduces legacy COMMIT orphan state; explicit ledger reconciliation preserves existing data", async t => {
      const f = await migrationFixture(t);
      await f.failLedger("after");
      // Deliberately recreate the old transaction boundaries only inside this disposable fixture.
      const legacy = "begin;\n" + migration + "\ncommit;";
      const failed = f.run(legacy);
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /(?:INSERT INTO supabase_migrations.schema_migrations|Failed to execute statement)/);
      assert.deepEqual(await f.state(), { schema: true, role: true, tables: 14, ledger: 0 });
      // Current runtime requires the forward contract, including in this legacy recovery fixture.
      await f.sql.begin(tx => tx.unsafe(actorClaimsMigration));
      const actor = id<"user">(), snapshot = fixture();
      await f.sql.unsafe(`create role procurement_recovery_connection login noinherit;
        grant procurement_runtime to procurement_recovery_connection`);
      const connection = postgres({ host: f.sql.options.host[0]!, port: f.sql.options.port[0]!, database: "migration_atomicity",
        username: "procurement_recovery_connection", prepare: false, max: 1, onnotice: () => {} });
      t.after(() => connection.end());
      const repo = new PostgresRevisionRepository(connection, actor);
      const first = saved(await repo.save(request(snapshot), actor));
      const history = await repo.history(snapshot.analysisId);
      const objects = await f.sql`select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'procurement' order by c.oid`;
      // Inspection cannot repair the orphan; an attempted first-time rerun is rejected, not destructive.
      const rerun = f.run();
      assert.equal(rerun.status, 1, rerun.stderr);
      assert.match(rerun.stderr, /create schema procurement/i);
      assert.deepEqual(await repo.history(snapshot.analysisId), history);
      assert.deepEqual(await f.state(), { schema: true, role: true, tables: 14, ledger: 0 });
      // Simulate separately authorized, ledger-only repair after review of the known complete artifact.
      await f.sql.unsafe("drop trigger fail_ledger on supabase_migrations.schema_migrations");
      const repair = f.run(legacy, true);
      assert.equal(repair.status, 0, repair.stderr);
      assert.deepEqual(await f.state(), { schema: true, role: true, tables: 14, ledger: 1 });
      assert.deepEqual(await f.sql`select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'procurement' order by c.oid`, objects);
      assert.deepEqual(await repo.history(snapshot.analysisId), history);
      assert.deepEqual(await repo.replay(snapshot.analysisId, first.revisionId), first.snapshot);
      const retry = f.run(legacy);
      assert.equal(retry.status, 0, retry.stderr);
      assert.deepEqual(await repo.history(snapshot.analysisId), history);
    });
  });

describe("forward actor-claim migration with the real CLI", { skip: process.env.RUN_POSTGRES_TESTS !== "1" }, () => {
  it("dry-runs only the forward migration without applying it", async t => {
    const f = await migrationFixture(t);
    assert.equal(f.run().status, 0);
    const dryRun = f.runActorClaims(actorClaimsMigration, true);
    assert.equal((await f.sql`select to_regprocedure('procurement.current_actor_id()') as helper`)[0]!.helper, null);
    assert.equal((await f.sql`select count(*)::int as n from supabase_migrations.schema_migrations where version = ${actorClaimsVersion}`)[0]!.n, 0);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout + dryRun.stderr, /20261015023734/);
    assert.doesNotMatch(dryRun.stdout + dryRun.stderr, /202610140001_procurement_storage/);
  });
  it("rolls back the forward migration on DDL/ledger failure and retries without rewriting existing rows", async t => {
    const f = await migrationFixture(t);
    assert.equal(f.run().status, 0);
    const actor = id<"user">(), project = id<"project">();
    await f.sql`insert into procurement.projects values (${project}, ${actor}, 'Preserved metadata')`;
    const before = await f.sql`select tablename, policyname, qual, with_check from pg_policies where schemaname = 'procurement' order by tablename, policyname`;
    async function structure() {
      return {
        tables: await f.sql`select c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity
          from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='procurement' and c.relkind='r' order by c.oid`,
        constraints: await f.sql`select oid,pg_get_constraintdef(oid) as definition from pg_constraint
          where connamespace='procurement'::regnamespace order by oid`,
        indexes: await f.sql`select indexname,indexdef from pg_indexes where schemaname='procurement' order by indexname`,
        triggers: await f.sql`select t.oid,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
          where c.relnamespace='procurement'::regnamespace and not t.tgisinternal order by t.oid`,
      };
    }
    const originalStructure = await structure();
    assert.equal(originalStructure.tables.length, 14);
    assert.equal(originalStructure.triggers.length, 8);
    assert.equal(before.length, 34);
    const failed = f.runActorClaims(actorClaimsMigration + "\nselect 1/0;");
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal((await f.sql`select to_regprocedure('procurement.current_actor_id()') as helper`)[0]!.helper, null);
    assert.equal((await f.sql`select count(*)::int as n from supabase_migrations.schema_migrations where version = ${actorClaimsVersion}`)[0]!.n, 0);
    assert.deepEqual(await f.sql`select tablename, policyname, qual, with_check from pg_policies where schemaname = 'procurement' order by tablename, policyname`, before);
    assert.deepEqual(await structure(), originalStructure);
    await f.sql.unsafe(`create function public.fail_forward_ledger() returns trigger language plpgsql as $$
      begin raise exception 'injected forward ledger failure'; end $$;
      create constraint trigger fail_forward_ledger after insert on supabase_migrations.schema_migrations
      deferrable initially deferred for each row when (new.version = '20261015023734') execute function public.fail_forward_ledger()`);
    const ledgerFailed = f.runActorClaims();
    assert.equal(ledgerFailed.status, 1, ledgerFailed.stderr);
    assert.equal((await f.sql`select to_regprocedure('procurement.current_actor_id()') as helper`)[0]!.helper, null);
    assert.equal((await f.sql`select count(*)::int as n from supabase_migrations.schema_migrations where version = ${actorClaimsVersion}`)[0]!.n, 0);
    assert.deepEqual(await f.sql`select tablename, policyname, qual, with_check from pg_policies where schemaname = 'procurement' order by tablename, policyname`, before);
    await f.sql.unsafe("drop trigger fail_forward_ledger on supabase_migrations.schema_migrations; drop function public.fail_forward_ledger()");
    const applied = f.runActorClaims();
    assert.equal(applied.status, 0, applied.stderr);
    const retry = f.runActorClaims();
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal((await f.sql`select count(*)::int as n from supabase_migrations.schema_migrations where version = ${actorClaimsVersion}`)[0]!.n, 1);
    assert.deepEqual(await structure(), originalStructure);
    assert.deepEqual([...(await f.sql`select * from procurement.projects where id = ${project}`)], [{ id: project, owner_id: actor, name: "Preserved metadata" }]);
    assert.equal((await f.sql`select count(*)::int as n from pg_policies where schemaname = 'procurement' and (coalesce(qual, '') like '%auth.uid%' or coalesce(with_check, '') like '%auth.uid%')`)[0]!.n, 0);
  });
});

function saved(outcome: SaveOutcome) {
  assert.equal(outcome.status, "SAVED", JSON.stringify(outcome));
  if (outcome.status !== "SAVED") throw new Error("Expected saved draft.");
  return outcome.revision;
}
function request(snapshot: WorkbookSnapshot, expectedRevisionId: unknown = null) {
  return { intent: "SAVE_DRAFT", snapshot, expectedRevisionId, mutationId: id<"mutation">() };
}
function configuration(snapshot: Mutable<WorkbookSnapshot>): EngineConfiguration {
  for (const cell of snapshot.worksheets.flatMap(w => w.tables).flatMap(t => t.cells)) {
    if (cell.source.kind === "INPUT") cell.source.input = { kind: "NUMERIC_TEXT", text: "2" };
  }
  for (const f of snapshot.formulas) { f.activation = "ACTIVE"; f.expression = "1+2"; f.referenceCellIds = []; }
  const policyVersionId = id<"policy">(); snapshot.policy = { status: "CONFIGURED", versionId: policyVersionId };
  return { version: "structural-test-only", policyVersionId, decimal: { scale: 8, rounding: "HALF_EVEN", roundAt: "EVERY_OPERATION" },
    units: snapshot.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).map(c => ({ cellId: c.id, symbol: "test", dimensions: {} })),
    aggregates: [], selectionDependentCellIds: [] };
}

describe("real PostgreSQL persistence (isolated temporary cluster)", { skip: process.env.RUN_POSTGRES_TESTS !== "1" }, () => {
  let cluster: Awaited<ReturnType<typeof startTestCluster>>;
  before(async () => { cluster = await startTestCluster(); });
  after(async () => { if (cluster) await cluster.stop(); });

  it("rejects administrative login credentials before downgrading to the runtime role", async () => {
    const repo = new PostgresRevisionRepository(cluster.sql, id<"user">());
    await assert.rejects(repo.head(id<"analysis">()), { code: "UNSAFE_DATABASE_ROLE" });
    const snapshot = fixture();
    await assert.rejects(repo.save(request(snapshot), repo.actorId), { code: "UNSAFE_DATABASE_ROLE" });
    const [count] = await cluster.sql`select count(*)::int as n from procurement.analyses where id = ${snapshot.analysisId}`;
    assert.equal(count!.n, 0);
  });

  it("uses only the restricted invoker helper in all 34 policies, without auth schema access", async () => {
    const [permissions] = await cluster.sql`select
      has_schema_privilege('procurement_runtime', 'auth', 'USAGE') as auth_usage,
      has_function_privilege('procurement_runtime', 'procurement.current_actor_id()', 'EXECUTE') as runtime_execute,
      has_function_privilege('anon', 'procurement.current_actor_id()', 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', 'procurement.current_actor_id()', 'EXECUTE') as authenticated_execute,
      (select prosecdef from pg_proc where oid = 'procurement.current_actor_id()'::regprocedure) as definer`;
    assert.deepEqual(permissions, { auth_usage: false, runtime_execute: true, anon_execute: false, authenticated_execute: false, definer: false });
    const policies = await cluster.sql`select qual, with_check, roles from pg_policies where schemaname = 'procurement'`;
    assert.equal(policies.length, 34);
    for (const policy of policies) {
      for (const expression of [policy.qual, policy.with_check].filter(Boolean)) {
        assert.match(expression, /procurement.current_actor_id\(\)/);
        assert.doesNotMatch(expression, /auth\.uid/);
      }
      assert.deepEqual(policy.roles, ["procurement_runtime"]);
    }
    const actor = id<"user">(), snapshot = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(snapshot), actor));
    assert.deepEqual((await repo.head(snapshot.analysisId))!.revision, first);
  });

  it("fails closed for missing, malformed, conflicting and foreign-user claims on reads and writes", async () => {
    const alice = id<"user">(), bob = id<"user">(), snapshot = fixture();
    const repo = new PostgresRevisionRepository(cluster.runtimeSql, alice);
    saved(await repo.save(request(snapshot), alice));
    const claims = (sub: string, role: unknown = "authenticated") => JSON.stringify({ sub, role });
    const cases: [string, string, string | null][] = [
      ["", "", null], ["", claims(alice), null], [alice, "", null], [alice, "{}", null],
      [alice, "not-json", null], [alice, "null", null], [alice, "[]", null],
      ["not-uuid", claims("not-uuid"), null], [alice, claims(bob), null],
      [alice, claims(alice, "anon"), null], [alice, claims(alice, null), null],
      [alice, JSON.stringify({ sub: alice }), null], [bob, claims(bob), bob],
    ];
    for (const [subject, payload, expected] of cases) {
      async function context<T>(work: (tx: postgres.TransactionSql) => Promise<T>) {
        return cluster.runtimeSql.begin(async tx => {
          await enterRuntimeRole(tx);
          await tx`select set_config('request.jwt.claim.sub', ${subject}, true), set_config('request.jwt.claims', ${payload}, true)`;
          return work(tx);
        });
      }
      await context(async tx => {
        assert.equal((await tx`select procurement.current_actor_id() as actor`)[0]!.actor, expected);
        assert.equal((await tx`select * from procurement.revisions where analysis_id = ${snapshot.analysisId}`).length, 0);
        assert.equal((await tx`update procurement.projects set name = 'forged' where id = ${snapshot.projectId} returning id`).length, 0);
      });
      await assert.rejects(context(tx => tx`insert into procurement.projects values (${id<"project">()}, ${alice}, 'forged')`), { code: "42501" });
    }
    assert.equal((await repo.history(snapshot.analysisId)).length, 1);
    assert.equal((await repo.listProjects())[0]!.name, snapshot.project.name);
  });

  it("rejects dangerous login attributes regardless of username", async () => {
    for (const attribute of ["superuser", "bypassrls", "createrole", "createdb", "replication", "inherit"]) {
      const role = "unsafe_" + attribute;
      await cluster.sql.unsafe(`create role ${role} login noinherit; alter role ${role} ${attribute}; grant procurement_runtime to ${role}`);
      const connection = cluster.connect(role);
      try { await assert.rejects(new PostgresRevisionRepository(connection, id<"user">()).listProjects(), { code: "UNSAFE_DATABASE_ROLE" }); }
      finally { await connection.end(); }
    }
  });

  it("rejects missing membership, grantable membership and indirect escalation paths", async () => {
    await cluster.sql.unsafe(`create role missing_membership login noinherit;
      create role grantable_membership login noinherit; grant procurement_runtime to grantable_membership with admin option;
      create role unsafe_bridge nologin; grant pg_read_all_data to unsafe_bridge;
      create role indirect_membership login noinherit; grant procurement_runtime, unsafe_bridge to indirect_membership;`);
    for (const role of ["missing_membership", "grantable_membership", "indirect_membership"]) {
      const connection = cluster.connect(role);
      try { await assert.rejects(new PostgresRevisionRepository(connection, id<"user">()).listProjects(), { code: "UNSAFE_DATABASE_ROLE" }); }
      finally { await connection.end(); }
    }
  });

  it("rejects login ownership and direct application grants, not just role attributes", async () => {
    await cluster.sql.unsafe(`create role owning_login login noinherit; grant procurement_runtime to owning_login;
      create schema owned_by_login authorization owning_login;
      create role directly_granted_login login noinherit; grant procurement_runtime to directly_granted_login;
      grant usage on schema procurement to directly_granted_login;
      grant select on procurement.projects to directly_granted_login;`);
    for (const role of ["owning_login", "directly_granted_login"]) {
      const connection = cluster.connect(role);
      try { await assert.rejects(new PostgresRevisionRepository(connection, id<"user">()).listProjects(), { code: "UNSAFE_DATABASE_ROLE" }); }
      finally { await connection.end(); }
    }
  });

  it("rechecks runtime memberships, RLS and effective grants after an earlier successful connection", async () => {
    const repo = new PostgresRevisionRepository(cluster.runtimeSql, id<"user">());
    assert.deepEqual(await repo.listProjects(), []);
    for (const [grant, revoke] of [
      ["grant pg_read_all_data to procurement_runtime", "revoke pg_read_all_data from procurement_runtime"],
      ["grant create on schema public to public", "revoke create on schema public from public"],
      ["grant delete on procurement.revisions to procurement_runtime", "revoke delete on procurement.revisions from procurement_runtime"],
      ["grant delete on procurement.revisions to public", "revoke delete on procurement.revisions from public"],
      ["grant update(owner_id) on procurement.projects to procurement_runtime", "revoke update(owner_id) on procurement.projects from procurement_runtime"],
      ["grant select on procurement.projects to procurement_runtime with grant option", "revoke grant option for select on procurement.projects from procurement_runtime"],
      ["alter table procurement.revisions no force row level security", "alter table procurement.revisions force row level security"],
      ["revoke update(name) on procurement.projects from procurement_runtime", "grant update(name) on procurement.projects to procurement_runtime"],
      ["create function procurement.unsafe_definer() returns int language sql security definer as 'select 1'", "drop function procurement.unsafe_definer()"],
      ["revoke execute on function procurement.current_actor_id() from procurement_runtime", "grant execute on function procurement.current_actor_id() to procurement_runtime"],
      ["grant execute on function procurement.current_actor_id() to authenticated", "revoke execute on function procurement.current_actor_id() from authenticated"],
      ["alter function procurement.current_actor_id() rename to temporarily_missing_actor", "alter function procurement.temporarily_missing_actor() rename to current_actor_id"],
    ]) {
      await cluster.sql.unsafe(grant!);
      try { await assert.rejects(repo.listProjects(), { code: "UNSAFE_DATABASE_ROLE" }); }
      finally { await cluster.sql.unsafe(revoke!); }
      assert.deepEqual(await repo.listProjects(), []);
    }
  });

  it("checks per-membership INHERIT/SET options on PostgreSQL 17", async () => {
    const [version] = await cluster.sql`select current_setting('server_version_num')::int as number`;
    assert.ok(version!.number >= 170000 && version!.number < 180000);
    await cluster.sql.unsafe(`create role membership_inherits login noinherit;
      grant procurement_runtime to membership_inherits with inherit true;
      create role membership_cannot_set login noinherit;
      grant procurement_runtime to membership_cannot_set with inherit false, set false;`);
    for (const role of ["membership_inherits", "membership_cannot_set"]) {
      const connection = cluster.connect(role);
      try { await assert.rejects(new PostgresRevisionRepository(connection, id<"user">()).listProjects(), { code: "UNSAFE_DATABASE_ROLE" }); }
      finally { await connection.end(); }
    }
  });

  it("verifies login/effective role in the same read-only transaction used by preflight", async () => {
    await cluster.runtimeSql.begin("read only", async tx => {
      await enterRuntimeRole(tx);
      const [row] = await tx`select session_user as login, current_user as effective,
        current_setting('transaction_read_only') as readonly, current_setting('row_security') as rls`;
      assert.deepEqual(row, { login: "procurement_test_connection", effective: "procurement_runtime", readonly: "on", rls: "on" });
    });
  });

  it("saves invalid-for-calculation drafts atomically and reloads identical snapshot/event/history on another connection", async () => {
    const actor = id<"user">(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor), s = fixture();
    const draft = saved(await repo.save(request(s), actor));
    const connection = cluster.connect();
    try {
      const device = new PostgresRevisionRepository(connection, actor), head = await device.head(s.analysisId);
      assert.ok(head);
      assert.deepEqual(head.revision, draft);
      assert.equal(head.changeEvent.actorId, actor);
      assert.deepEqual(head.changeEvent.after, draft.snapshot);
      assert.equal(head.changeEvent.before, null);
      assert.equal(head.revision.run, null);
      assert.equal(draft.kind, "SAVED_DRAFT");
      assert.equal(draft.snapshot.policy.status, "UNCONFIGURED");
      assert.deepEqual(await device.replay(s.analysisId, draft.revisionId), draft.snapshot);
      assert.ok(Object.isFrozen((await device.history(s.analysisId))[0]!.revision.snapshot));
      assert.equal((await device.listProjects()).find(p => p.id === s.projectId)?.name, s.project.name);
      assert.equal((await device.listAnalyses(s.projectId))[0]!.id, s.analysisId);
    } finally { await connection.end(); }
  });
  it("concurrent first saves and two devices with one base cannot overwrite the winning revision", async () => {
    const actor = id<"user">(), s = fixture(), a = new PostgresRevisionRepository(cluster.runtimeSql, actor), b = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const initial = await Promise.all([a.save(request(s), actor), b.save(request(s), actor)]);
    assert.deepEqual(initial.map(o => o.status).sort(), ["CONFLICT", "SAVED"]);
    const first = (await a.head(s.analysisId))!.revision;
    const changed = updateCellInput(first.snapshot, "INU", s.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "3" });
    const results = await Promise.all([a.save(request(changed, first.revisionId), actor), b.save(request(first.snapshot, first.revisionId), actor)]);
    assert.deepEqual(results.map(o => o.status).sort(), ["CONFLICT", "SAVED"]);
    assert.equal((await a.history(s.analysisId)).length, 2);
    const conflict = results.find(o => o.status === "CONFLICT");
    assert.equal(conflict?.code, "STALE_REVISION");
  });
  it("identical concurrent retries and retries after a later head return the original revision/event", async () => {
    const actor = id<"user">(), s = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor), req = request(s);
    const [a, b] = await Promise.all([repo.save(req, actor), repo.save(req, actor)]);
    assert.deepEqual(a, b); const first = saved(a);
    saved(await repo.save(request(first.snapshot, first.revisionId), actor));
    assert.deepEqual(await new PostgresRevisionRepository(cluster.runtimeSql, actor).save(req, actor), a);
    const changed = structuredClone(s); changed.project.name = "different payload";
    const conflict = await repo.save({ ...req, snapshot: changed }, actor);
    assert.ok(conflict.status === "REJECTED"); assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await repo.history(s.analysisId)).length, 2);
    const [count] = await cluster.sql`select count(*)::int as n from procurement.change_events where analysis_id = ${s.analysisId}`;
    assert.equal(count!.n, 2);
  });
  it("restore appends a new draft; replay, manual selection/HPP and historical profile state are preserved", async () => {
    const actor = id<"user">(), s = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    const changed = updateCellInput(first.snapshot, "INU", s.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "later manual HPP" });
    const second = saved(await repo.save(request(changed, first.revisionId), actor));
    const oldHistory = canonicalJson(await repo.history(s.analysisId));
    const restore = { analysisId: s.analysisId, sourceRevisionId: first.revisionId, expectedRevisionId: second.revisionId,
      mutationId: id<"mutation">(), reason: "explicit restore" };
    const restored = saved(await repo.restore(restore, actor));
    assert.notEqual(restored.revisionId, first.revisionId);
    assert.equal(restored.parentRevisionId, second.revisionId);
    assert.deepEqual(restored.restoredFrom, { revisionId: first.revisionId, snapshotId: first.snapshot.id });
    assert.deepEqual({ ...restored.snapshot, id: first.snapshot.id }, first.snapshot);
    assert.equal(canonicalJson((await repo.history(s.analysisId)).slice(0, 2)), oldHistory);
    assert.deepEqual(await repo.restore(restore, actor), { status: "SAVED", revision: restored });
    assert.equal((await repo.head(s.analysisId))!.changeEvent.action, "RESTORE");
    assert.equal((await repo.head(s.analysisId))!.changeEvent.reason, restore.reason);
    assert.deepEqual(await repo.replay(s.analysisId, first.revisionId), first.snapshot);
  });
  it("a failure after snapshot/revision inserts rolls back all rows including identities and event/head/mutation", async () => {
    const actor = id<"user">(), s = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const failedRequest = request(s);
    await cluster.sql.unsafe(`create function procurement.test_fail_event() returns trigger language plpgsql as $$
      begin raise exception 'injected event failure'; end $$;
      create trigger test_fail_event before insert on procurement.change_events for each row execute function procurement.test_fail_event();`);
    try { await assert.rejects(repo.save(failedRequest, actor), /injected event failure/); }
    finally { await cluster.sql.unsafe("drop trigger test_fail_event on procurement.change_events; drop function procurement.test_fail_event()"); }
    for (const table of ["analyses", "workbook_snapshots", "revisions", "change_events", "analysis_heads", "revision_mutations", "vendors", "offers", "offer_revisions", "formula_versions"]) {
      const column = table === "analyses" ? "id" : "analysis_id";
      const [count] = await cluster.sql`select count(*)::int as n from procurement.${cluster.sql(table)} where ${cluster.sql(column)} = ${s.analysisId}`;
      assert.equal(count!.n, 0, table);
    }
    const [project] = await cluster.sql`select count(*)::int as n from procurement.projects where id = ${s.projectId}`;
    assert.equal(project!.n, 0);
    saved(await repo.save(failedRequest, actor));
  });
  it("RLS denies other users, anonymous access and forged actors without leaking snapshots or creating partial projects", async () => {
    const alice = id<"user">(), bob = id<"user">(), s = fixture();
    const a = new PostgresRevisionRepository(cluster.runtimeSql, alice), b = new PostgresRevisionRepository(cluster.runtimeSql, bob);
    const first = saved(await a.save(request(s), alice));
    assert.equal(await b.head(s.analysisId), null);
    assert.deepEqual(await b.history(s.analysisId), []);
    assert.deepEqual(await b.listProjects(), []);
    await assert.rejects(b.get(s.analysisId, first.revisionId), AccessDeniedError);
    await assert.rejects(b.save(request(s), bob), AccessDeniedError);
    await assert.rejects(b.save(request(s), alice), AccessDeniedError);
    await assert.rejects(b.restore({ analysisId: s.analysisId, sourceRevisionId: first.revisionId, expectedRevisionId: first.revisionId,
      mutationId: id<"mutation">() }, bob));
    await assert.rejects(b.transaction(tx => tx`insert into procurement.projects (id, owner_id, name) values (${id<"project">()}, ${alice}, 'forged')`));
    await cluster.sql.begin(async tx => {
      await tx`set local role procurement_runtime`;
      await tx`select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{}', true)`;
      assert.equal((await tx`select * from procurement.revisions`).length, 0);
    });
    for (const role of ["anon", "authenticated"]) await assert.rejects(cluster.sql.begin(async tx => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select * from procurement.projects`;
    }), /permission denied/);
    assert.equal((await a.history(s.analysisId)).length, 1);
    await a.transaction(async tx => {
      const [role] = await tx`select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      assert.equal(role!.name, "procurement_runtime");
      assert.equal(role!.rolsuper, false); assert.equal(role!.rolbypassrls, false);
    });
  });
  it("two analyses in one project keep independent heads and restore/history state", async () => {
    const actor = id<"user">(), a = fixture(), b = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    b.projectId = a.projectId; b.project = structuredClone(a.project); b.analysis.analysis.projectId = a.projectId;
    const first = saved(await repo.save(request(a), actor)), other = saved(await repo.save(request(b), actor));
    const edited = updateCellInput(first.snapshot, "INU", a.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "3" });
    saved(await repo.save(request(edited, first.revisionId), actor));
    assert.deepEqual((await repo.head(b.analysisId))!.revision, other);
    assert.equal((await repo.history(a.analysisId)).length, 2); assert.equal((await repo.history(b.analysisId)).length, 1);
  });
  it("migration removes inherited public/anon/authenticated table grants and keeps runtime history append-only", async () => {
    const rows = await cluster.sql`select c.relname, acl.grantee from pg_class c
      join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) acl
      where n.nspname = 'procurement' and c.relkind = 'r'
        and (acl.grantee = 0 or acl.grantee in (select oid from pg_roles where rolname in ('anon','authenticated')))`;
    assert.equal(rows.length, 0);
    const [permissions] = await cluster.sql`select
      has_schema_privilege('anon','procurement','USAGE') as anon_usage,
      has_schema_privilege('authenticated','procurement','USAGE') as authenticated_usage,
      has_column_privilege('procurement_runtime','procurement.projects','owner_id','UPDATE') as owner_update,
      has_table_privilege('procurement_runtime','procurement.revisions','UPDATE') as history_update,
      has_table_privilege('procurement_runtime','procurement.revisions','DELETE') as history_delete`;
    assert.deepEqual(permissions, { anon_usage: false, authenticated_usage: false,
      owner_update: false, history_update: false, history_delete: false });
  });
  it("a non-superuser NOINHERIT connection can use the repository without leaking role or user claims between transactions", async () => {
    const connection = cluster.connect("procurement_test_connection");
    try {
      await assert.rejects(connection`select * from procurement.projects`, { code: "42501" });
      const actor = id<"user">(), other = id<"user">(), s = fixture();
      const repo = new PostgresRevisionRepository(connection, actor);
      const first = saved(await repo.save(request(s), actor));
      assert.deepEqual((await repo.head(s.analysisId))!.revision, first);
      assert.equal(await new PostgresRevisionRepository(connection, other).head(s.analysisId), null);
      const [session] = await connection`select current_user as role, nullif(current_setting('request.jwt.claim.sub', true), '') as subject`;
      assert.deepEqual(session, { role: "procurement_test_connection", subject: null });
    } finally { await connection.end(); }
  });
  it("database triggers reject rewriting historical snapshots/events even through a privileged test connection", async () => {
    const actor = id<"user">(), s = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    await assert.rejects(cluster.sql`update procurement.workbook_snapshots set payload = payload where id = ${first.snapshot.id}`, /immutable/);
    await assert.rejects(cluster.sql`delete from procurement.change_events where revision_id = ${first.revisionId}`, /immutable/);
    await assert.rejects(repo.transaction(tx => tx`update procurement.revisions set payload = payload where id = ${first.revisionId}`), /permission denied/);
    const tampered = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>;
    tampered.analysis.offerRevisions[0]!.values[0]!.input = { kind: "NUMERIC_TEXT", text: "rewrite" };
    const rejected = await repo.save(request(tampered, first.revisionId), actor);
    assert.ok(rejected.status === "REJECTED"); assert.equal(rejected.code, "INVALID_HISTORY_TRANSITION");
  });
  it("mapping versions survive reload and new versions cannot alter the historical mapping snapshot", async () => {
    const actor = id<"user">(), s = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    s.mappings.push({ id: id<"mapping">(), versionId: id<"mapping-version">(), analysisId: s.analysisId, scope: "INU",
      sourceCellId: s.worksheets[0]!.tables[0]!.cells[0]!.id, targetCellId: s.worksheets[2]!.tables[0]!.cells[1]!.id,
      sourceComponent: "test", transformExpression: null, sourceUnit: "unapproved-test", targetUnit: "unapproved-test", status: "DRAFT",
      provenance: { actorId: actor, changeEventId: id<"change-event">(), sourceRef: null, reason: null } });
    const first = saved(await repo.save(request(s), actor));
    s.mappings[0]!.versionId = id<"mapping-version">(); s.mappings[0]!.status = "NEEDS_REVIEW";
    const second = saved(await repo.save(request(s, first.revisionId), actor));
    assert.notEqual(first.snapshot.mappings[0]!.versionId, second.snapshot.mappings[0]!.versionId);
    assert.deepEqual((await repo.get(s.analysisId, first.revisionId)).revision.snapshot.mappings, first.snapshot.mappings);
    const [count] = await cluster.sql`select count(*)::int as n from procurement.mapping_versions where analysis_id = ${s.analysisId}`;
    assert.equal(count!.n, 2);
  });
  it("stores real engine manifests, reloads/reproduces results, and prevents stale publication and operational confirmation", async () => {
    const actor = id<"user">(), s = fixture(), config = configuration(s), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    const result = await repo.calculate(s.analysisId, first.revisionId, config);
    assert.equal(result.status, "STORED_PREVIEW"); if (result.status !== "STORED_PREVIEW") throw new Error();
    assert.equal(result.run.status, "NONFINAL");
    assert.deepEqual((await repo.runs(s.analysisId))[0], result.run);
    assert.equal(result.run.manifest.revisionId, first.revisionId);
    assert.deepEqual(result.run.manifest.snapshot, first.snapshot);
    const engine = new FormulaEngine(config), old = engine.evaluateRevision(first);
    const changed = updateCellInput(first.snapshot, "INU", s.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "3" });
    const second = saved(await repo.save(request(changed, first.revisionId), actor));
    assert.equal(await repo.latestRun(s.analysisId, "INU"), null);
    const current = await repo.calculate(s.analysisId, second.revisionId, config);
    assert.ok(current.status === "STORED_PREVIEW");
    assert.deepEqual(await repo.persistRun(old, engine), { status: "STALE_RUN" });
    assert.equal((await repo.latestRun(s.analysisId, "INU"))!.id, current.run.id);
    const reviewed = new FormulaEngine(config).reviewRun(second.snapshot, current.run);
    const third = saved(await repo.save(request(reviewed, second.revisionId), actor));
    assert.equal(third.snapshot.profiles.INU.reviewContext!.runId, current.run.id);
    assert.deepEqual(third.snapshot.profiles.INU.hppBase, second.snapshot.profiles.INU.hppBase);
    const replay = new FormulaEngine(result.run.manifest.configuration).evaluateRevision({ ...first, snapshot: result.run.manifest.snapshot });
    assert.deepEqual(replay.results, result.run.results);
    const rejected = await repo.save({ ...request(third.snapshot, third.revisionId), intent: "CONFIRM_RESULT" }, actor);
    assert.ok(rejected.status === "REJECTED"); assert.equal(rejected.code, "CONFIRMATION_UNAVAILABLE");
  });
  it("a failed run publication rolls back the run and latest pointer without publishing phantom in-memory results", async () => {
    const actor = id<"user">(), s = fixture(), config = configuration(s), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    const prior = await repo.calculate(s.analysisId, first.revisionId, config);
    assert.ok(prior.status === "STORED_PREVIEW");
    const engine = new FormulaEngine(config), candidate = engine.evaluateRevision(first);
    await cluster.sql.unsafe(`create function procurement.test_fail_run() returns trigger language plpgsql as $$
      begin raise exception 'injected run publication failure'; end $$;
      create trigger test_fail_run before insert or update on procurement.latest_calculation_runs for each row execute function procurement.test_fail_run();`);
    try { await assert.rejects(repo.persistRun(candidate, engine), /injected run publication failure/); }
    finally { await cluster.sql.unsafe("drop trigger test_fail_run on procurement.latest_calculation_runs; drop function procurement.test_fail_run()"); }
    assert.equal(engine.latest(s.analysisId, "INU"), null);
    assert.equal((await repo.latestRun(s.analysisId, "INU"))!.id, prior.run.id);
    assert.deepEqual((await repo.runs(s.analysisId)).map(run => run.id), [prior.run.id]);
  });
  it("policy IDs cannot be reused for a different numeric policy through another repository/engine instance", async () => {
    const actor = id<"user">(), s = fixture(), config = configuration(s), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    const prior = await repo.calculate(s.analysisId, first.revisionId, config);
    assert.ok(prior.status === "STORED_PREVIEW");
    const changed = { ...config, decimal: { ...config.decimal, scale: 2 } };
    await assert.rejects(new PostgresRevisionRepository(cluster.runtimeSql, actor).calculate(s.analysisId, first.revisionId, changed), /new policy version/);
    assert.equal((await repo.runs(s.analysisId)).length, 1);
    assert.equal((await repo.latestRun(s.analysisId, "INU"))!.id, prior.run.id);
  });
  it("retrying a stored run is idempotent and cannot replace a newer preview on the same revision", async () => {
    const actor = id<"user">(), s = fixture(), config = configuration(s), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    const engine = new FormulaEngine(config), run = engine.evaluateRevision(first);
    assert.equal((await repo.persistRun(run, engine)).status, "STORED_PREVIEW");
    const newer = await repo.calculate(s.analysisId, first.revisionId, config);
    assert.ok(newer.status === "STORED_PREVIEW");
    assert.equal((await repo.persistRun(run, engine)).status, "STORED_PREVIEW");
    assert.equal((await repo.latestRun(s.analysisId, "INU"))!.id, newer.run.id);
    assert.equal((await repo.runs(s.analysisId)).length, 2);
  });
  it("latest preview pointers cannot reference a run from the other profile", async () => {
    const actor = id<"user">(), s = fixture(), config = configuration(s), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    const result = await repo.calculate(s.analysisId, first.revisionId, config);
    assert.ok(result.status === "STORED_PREVIEW");
    await assert.rejects(repo.transaction(tx => tx`insert into procurement.latest_calculation_runs (analysis_id, profile, owner_id, run_id)
      values (${s.analysisId}, 'SOLAR_BAWAH', ${actor}, ${result.run.id})`), { code: "23503" });
    assert.equal(await repo.latestRun(s.analysisId, "SOLAR_BAWAH"), null);
    assert.equal((await repo.latestRun(s.analysisId, "INU"))!.id, result.run.id);
  });
  it("API integration persists explicit Save and reloads on a second handler without trusting a body actor", async () => {
    const actor = id<"user">(), snapshot = fixture();
    const auth = { async authenticate() { return actor; } };
    const one = createWorkbookHandler(auth, id => new PostgresRevisionRepository(cluster.runtimeSql, id));
    const post = (body: unknown) => new Request("http://localhost/api/workbook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await one(post({ operation: "SAVE", request: request(snapshot) }));
    assert.equal(response.status, 200);
    const result = await response.json() as SaveOutcome; const first = saved(result);
    const two = createWorkbookHandler(auth, id => new PostgresRevisionRepository(cluster.runtimeSql, id));
    const reload = await two(new Request(`http://localhost/api/workbook?analysisId=${snapshot.analysisId}`));
    assert.equal(reload.status, 200); assert.equal((await reload.json()).revision.revisionId, first.revisionId);
    const forged = await one(post({ operation: "SAVE", request: { ...request(snapshot, first.revisionId), actorId: id<"user">() } }));
    assert.equal(forged.status, 400);
    assert.deepEqual(captureSnapshot(first.snapshot), first.snapshot);
  });

  it("Analysis Save/Restore never renames an existing Project from carried historical metadata", async () => {
    const actor = id<"user">(), a = fixture(), b = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    b.projectId = a.projectId; b.project = structuredClone(a.project); b.analysis.analysis.projectId = a.projectId;
    const first = saved(await repo.save(request(a), actor));
    const historyBefore = canonicalJson(await repo.history(a.analysisId));
    // Simulate an explicit Project-only change, not an Analysis Save command.
    await repo.transaction(tx => tx`update procurement.projects set name = 'Explicit Project rename' where id = ${a.projectId}`);
    const other = saved(await repo.save(request(b), actor));
    const draft = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>; draft.project.name = "Snapshot metadata, not a Project rename";
    const second = saved(await repo.save(request(draft, first.revisionId), actor));
    const restored = saved(await repo.restore({ analysisId: a.analysisId, sourceRevisionId: first.revisionId,
      expectedRevisionId: second.revisionId, mutationId: id<"mutation">() }, actor));
    assert.equal((await repo.listProjects()).find(p => p.id === a.projectId)!.name, "Explicit Project rename");
    assert.equal(restored.snapshot.project.name, first.snapshot.project.name);
    assert.equal(canonicalJson((await repo.history(a.analysisId)).slice(0, 1)), historyBefore);
    assert.deepEqual((await repo.head(b.analysisId))!.revision, other);
  });

  it("PostgreSQL accepts the domain's full revision number range and rejects values outside it", async () => {
    for (const value of [1, 2147483648, Number.MAX_SAFE_INTEGER]) {
      const actor = id<"user">(), s = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
      s.analysis.offerRevisions[0]!.revisionNumber = value;
      const first = saved(await repo.save(request(s), actor));
      assert.equal((await repo.get(s.analysisId, first.revisionId)).revision.snapshot.analysis.offerRevisions[0]!.revisionNumber, value);
      const [row] = await repo.transaction(tx => tx`select revision_number::text as number from procurement.offer_revisions where id = ${s.analysis.offerRevisions[0]!.id}`);
      assert.equal(row!.number, String(value));
      for (const invalid of ["0", "-1", "9007199254740992"]) {
        const revisionId = id<"offer-revision">(), offerId = s.analysis.offers[0]!.id;
        await assert.rejects(repo.transaction(tx => tx`insert into procurement.offer_revisions
          (id, analysis_id, owner_id, offer_id, revision_number, payload)
          values (${revisionId}, ${s.analysisId}, ${actor}, ${offerId}, ${invalid}::bigint,
          jsonb_build_object('id', ${revisionId}::uuid, 'offerId', ${offerId}::uuid,
            'revisionNumber', ${invalid}::numeric, 'values', '[]'::jsonb))`), { code: "23514" });
      }
    }
  });

  it("repository and SQL reserve offer numbers after removal without blocking restore or retry", async () => {
    const actor = id<"user">(), s = fixture(), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor), initial = request(s);
    const first = saved(await repo.save(initial, actor)), original = first.snapshot.analysis.offerRevisions[0]!;
    const removed = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>; removed.analysis.offerRevisions = []; removed.selectedOfferRevisionId = null;
    const second = saved(await repo.save(request(removed, first.revisionId), actor));
    const replacement = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>, replacementId = id<"offer-revision">();
    replacement.analysis.offerRevisions[0]!.id = replacementId; replacement.selectedOfferRevisionId = replacementId;
    const anotherDevice = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const rejected = await anotherDevice.save(request(replacement, second.revisionId), actor);
    assert.ok(rejected.status === "REJECTED"); assert.equal(rejected.code, "INVALID_HISTORY_TRANSITION");
    assert.equal((await repo.history(s.analysisId)).length, 2);
    const payload = { ...original, id: replacementId };
    await assert.rejects(repo.transaction(tx => tx`insert into procurement.offer_revisions
      (id, analysis_id, owner_id, offer_id, revision_number, payload)
      values (${replacementId}, ${s.analysisId}, ${actor}, ${original.offerId}, ${original.revisionNumber}, ${tx.json(payload)})`), { code: "23505" });
    const restored = saved(await anotherDevice.restore({ analysisId: s.analysisId, sourceRevisionId: first.revisionId,
      expectedRevisionId: second.revisionId, mutationId: id<"mutation">() }, actor));
    assert.deepEqual(restored.snapshot.analysis.offerRevisions, first.snapshot.analysis.offerRevisions);
    assert.deepEqual(await repo.save(initial, actor), { status: "SAVED", revision: first });
    assert.deepEqual(await repo.replay(s.analysisId, first.revisionId), first.snapshot);
  });

  it("JSONB constraints reject every missing envelope key, required nested identity and malformed root", async () => {
    const actor = id<"user">(), s = fixture(), config = configuration(s), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    s.mappings.push({ id: id<"mapping">(), versionId: id<"mapping-version">(), analysisId: s.analysisId, scope: "INU",
      sourceCellId: s.worksheets[0]!.tables[0]!.cells[0]!.id, targetCellId: s.worksheets[2]!.tables[0]!.cells[1]!.id,
      sourceComponent: "structural test", transformExpression: null, sourceUnit: "test", targetUnit: "test", status: "DRAFT",
      provenance: { actorId: actor, changeEventId: id<"change-event">(), sourceRef: null, reason: null } });
    const first = saved(await repo.save(request(s), actor));
    assert.equal((await repo.calculate(s.analysisId, first.revisionId, config)).status, "STORED_PREVIEW");
    const nested: Record<string, string[][]> = {
      workbook_snapshots: [["project", "id"], ["project", "name"], ["analysis", "analysis", "id"], ["policy", "status"], ["profiles", "INU"]],
      revisions: [["revision", "revisionId"], ["revision", "run"], ["revision", "parentRevisionId"], ["revision", "snapshot", "id"]],
      mapping_versions: [["provenance", "actorId"], ["provenance", "changeEventId"], ["provenance", "reason"]],
      calculation_runs: [["manifest", "revisionId"], ["manifest", "configuration"], ["manifest", "snapshot", "id"]],
    };
    for (const table of ["workbook_snapshots", "revisions", "change_events", "offer_revisions", "mapping_versions", "formula_versions", "calculation_runs"]) {
      const [result] = await cluster.sql`select to_jsonb(t) as row from procurement.${cluster.sql(table)} t where analysis_id = ${s.analysisId} limit 1`;
      const row = result!.row as Record<string, unknown>, payload = row.payload as Record<string, unknown>;
      await cluster.sql.begin(async tx => {
        // Copy the actual CHECKs, but no unique indexes/FKs/triggers that could mask a missing-key failure.
        await tx`create temporary table payload_contract (like procurement.${tx(table)} including constraints) on commit drop`;
        const insert = (candidate: unknown) => tx.savepoint(sub => sub`insert into payload_contract
          select * from jsonb_populate_record(null::procurement.${sub(table)}, ${sub.json(JSON.parse(canonicalJson({ ...row, payload: candidate })))})`);
        await insert(payload); // Valid nullable fields must remain accepted.
        for (const key of Object.keys(payload)) {
          const missing = { ...payload }; delete missing[key];
          await assert.rejects(insert(missing), { code: "23514" }, table + ": missing " + key);
        }
        // Present JSON null must not turn identity equality into an accepted UNKNOWN CHECK.
        const identity = table === "revisions" ? "actorId" : table.endsWith("_versions") ? "versionId" : "id";
        await assert.rejects(insert({ ...payload, [identity]: null }), { code: "23514" }, table + ": null " + identity);
        for (const path of nested[table] ?? []) {
          const missing = structuredClone(payload);
          let parent = missing;
          for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
          delete parent[path.at(-1)!];
          await assert.rejects(insert(missing), { code: "23514" }, table + ": missing " + path.join("."));
        }
        for (const malformed of [{}, []]) await assert.rejects(insert(malformed), { code: "23514" });
      });
    }
    assert.deepEqual(await repo.replay(s.analysisId, first.revisionId), first.snapshot);
  });

  it("Calculation Run FK rejects an existing snapshot paired with the wrong revision", async () => {
    const actor = id<"user">(), s = fixture(), config = configuration(s), repo = new PostgresRevisionRepository(cluster.runtimeSql, actor);
    const first = saved(await repo.save(request(s), actor));
    const second = saved(await repo.save(request(first.snapshot, first.revisionId), actor));
    const run = new FormulaEngine(config).evaluateRevision(first);
    const mismatched = { ...run, snapshotId: second.snapshot.id, manifest: { ...run.manifest, snapshot: second.snapshot } };
    await assert.rejects(repo.transaction(tx => tx`insert into procurement.calculation_runs
      (id, analysis_id, owner_id, revision_id, snapshot_id, profile, engine_version, policy_version_id, payload)
      values (${run.id}, ${s.analysisId}, ${actor}, ${first.revisionId}, ${second.snapshot.id}, ${s.activeProfile},
        ${run.engineVersion}, ${run.policyVersionId}, ${tx.json(JSON.parse(canonicalJson(mismatched)))})`), { code: "23503" });
    assert.equal((await repo.runs(s.analysisId)).length, 0);
    const result = await repo.calculate(s.analysisId, second.revisionId, config);
    assert.equal(result.status, "STORED_PREVIEW");
    assert.deepEqual(await repo.replay(s.analysisId, first.revisionId), first.snapshot);
  });
});
