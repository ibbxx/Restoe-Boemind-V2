import assert from "node:assert/strict";
import postgres from "postgres";
import { cloudTestConfig, CloudConfigurationError } from "./cloud-test-config.ts";
import { SupabaseAuthenticator } from "../src/server/supabase-auth.ts";
import { PostgresRevisionRepository } from "../src/persistence/postgres-revision-repository.ts";
import { createWorkbookHandler } from "../src/server/workbook-handler.ts";
import { enterRuntimeRole } from "../src/persistence/runtime-role.ts";
import { canonicalJson, captureSnapshot } from "../src/domain/snapshots.ts";
import { createStableId } from "../src/domain/ids.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import type { StableId } from "../src/domain/ids.ts";
import type { SavedRevision } from "../src/domain/contracts.ts";
import { fixture } from "./phase2-fixture.ts";

type Check = { check: string; status: "PASS" | "FAIL" | "GAP"; detail?: string };
const checks: Check[] = [];
const connectivityOnly = process.argv.includes("--connectivity-only");
let fixtureIds: { projectId: string; analysisId: string } | undefined;
async function check<T>(name: string, work: () => Promise<T>): Promise<T | undefined> {
  try { const value = await work(); checks.push({ check: name, status: "PASS" }); return value; }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "CHECK_FAILED";
    checks.push({ check: name, status: "FAIL", detail: /^[A-Z0-9_]{1,40}$/.test(code) ? code : "CHECK_FAILED" });
    return undefined; // Driver/Auth messages may contain connection information: never print them.
  }
}
function gap(name: string, detail: string) { checks.push({ check: name, status: "GAP", detail }); }
const tables = ["projects", "analyses", "workbook_snapshots", "revisions", "analysis_heads", "change_events", "revision_mutations",
  "vendors", "offers", "offer_revisions", "mapping_versions", "formula_versions", "calculation_runs", "latest_calculation_runs"];

async function main() {
  let config: ReturnType<typeof cloudTestConfig>;
  try { config = cloudTestConfig(process.env, process.argv.includes("--write"), connectivityOnly); }
  catch (error) {
    gap("cloud configuration", error instanceof CloudConfigurationError ? error.message : "Invalid configuration."); return;
  }
  const sql = postgres(config.databaseUrl, { ssl: "verify-full", prepare: false, max: connectivityOnly ? 1 : 2, connect_timeout: 10,
    idle_timeout: 5, connection: { default_transaction_read_only: !config.allowWrites }, onnotice: () => {} });
  try {
    if (connectivityOnly) {
      await check("diagnostic Session Pooler connection and verified TLS (not runtime verification)", () => sql.begin("read only", async tx => {
        await tx`set local statement_timeout = '10s'`;
        const [identity] = await tx`select current_database() as database, current_setting('server_version') as postgres_version,
          session_user::text as session_user, current_user::text as current_user,
          current_setting('transaction_read_only') as transaction_read_only,
          r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication
          from pg_roles r where r.rolname = session_user`;
        assert.equal(identity?.transaction_read_only, "on");
        checks.push({ check: "diagnostic PostgreSQL identity", status: "PASS", detail: JSON.stringify(identity) });
      }));
      return;
    }
    const auth = new SupabaseAuthenticator(config.authUrl, config.publicKey);
    const users: Partial<Record<"A" | "B", StableId<"user">>> = {};
    for (const [name, token] of [["A", config.tokenA], ["B", config.tokenB]] as const) {
      if (!token) { gap("live Auth user " + name, "Provide SUPABASE_TEST_ACCESS_TOKEN_" + name + " from an existing test session."); continue; }
      const user = await check("live Auth user " + name, () => auth.authenticate(new Request("http://localhost/api/workbook", { headers: { authorization: "Bearer " + token } })));
      if (user) users[name] = user;
    }
    const connected = await check("verified TLS connection" + (config.pooler ? " through pooler" : " (direct; pooler still unverified)"), () => sql.begin("read only", async tx => {
      const [row] = await tx`select current_setting('transaction_read_only') as readonly`;
      assert.equal(row?.readonly, "on");
      return true;
    }));
    if (!config.pooler) gap("pooler", "Provide a matching transaction/session pooler DATABASE_URL to verify that path.");
    if (!connected) return;
    const runtimeRole = await check("runtime login, membership and effective privilege policy", () => sql.begin("read only", async tx => {
      await enterRuntimeRole(tx);
      return true;
    }));
    if (!runtimeRole) return;
    try {
      const rows = await sql.begin("read only", tx => tx`select ssl from pg_stat_ssl where pid = pg_backend_pid()`);
      assert.ok(rows[0] && typeof rows[0].ssl === "boolean");
      // pg_stat_ssl describes the backend hop; with a pooler it is not the client's TLS handshake.
      checks.push({ check: "PostgreSQL backend TLS observation", status: "PASS", detail: "ssl=" + String(rows[0].ssl) + "; distinct from verified client-to-pooler TLS" });
    } catch { gap("PostgreSQL backend TLS observation", "Backend hop could not be inspected; client TLS verification remains mandatory."); }
    const schema = await check("migration schema contract and RLS", () => sql.begin("read only", async tx => {
      const rows = await tx`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'procurement' and c.relkind = 'r'`;
      for (const name of tables) assert.ok(rows.some(row => row.relname === name && row.relrowsecurity && row.relforcerowsecurity));
      const [role] = await tx`select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'procurement_runtime'`;
      assert.ok(role && !role.rolsuper && !role.rolbypassrls && !role.rolcanlogin);
      await enterRuntimeRole(tx);
      const [privilege] = await tx`select has_schema_privilege('anon','procurement','USAGE') as anon,
        has_schema_privilege('authenticated','procurement','USAGE') as authenticated`;
      assert.ok(privilege && !privilege.anon && !privilege.authenticated);
      const policies = await tx`select tablename, cmd from pg_policies where schemaname = 'procurement' and roles @> array['procurement_runtime']::name[]`;
      for (const name of tables) for (const cmd of ["SELECT", "INSERT"]) assert.ok(policies.some(p => p.tablename === name && p.cmd === cmd));
      return true;
    }));
    // Operator credentials inspect only the ledger; repositories always retain the restricted login.
    const ledgerSql = config.migrationAuditUrl ? postgres(config.migrationAuditUrl, { ssl: "verify-full", prepare: false,
      max: 1, connect_timeout: 10, onnotice: () => {}, connection: { default_transaction_read_only: true } }) : sql;
    try {
      const ledger = await ledgerSql.begin("read only", async tx => {
        const [permission] = await tx`select exists(select 1 from pg_namespace where nspname = 'supabase_migrations'
          and has_schema_privilege(current_user, oid, 'USAGE')) as accessible`;
        if (!permission?.accessible) return false;
        const versions = await tx`select version from supabase_migrations.schema_migrations where version in ('202610140001', '20261015023734')`;
        return versions.length === 2;
      });
      if (ledger) checks.push({ check: "migration versions 202610140001 and 20261015023734 ledger records", status: "PASS" });
      else gap("migration ledger", "Ledger missing, inaccessible or a required migration not recorded; an authorized operator must inspect it. No migration was applied.");
    } catch { gap("migration ledger", "Ledger could not be read; request an authorized operator to inspect migration history."); }
    finally { if (ledgerSql !== sql) await ledgerSql.end({ timeout: 5 }); }
    const distinct = users.A && users.B && users.A !== users.B;
    if (users.A && users.B && !distinct) checks.push({ check: "distinct test users", status: "FAIL" });
    if (!schema || !distinct) { gap("live data flows and RLS", "Schema access and two distinct verified test users are required."); return; }
    if (!config.allowWrites) {
      gap("Save Draft/reload/restore cloud", "Read-only mode: requires separate remote-write approval and --write with matching project confirmation.");
      if (!config.analysisIdA) gap("RLS live data", "Provide SUPABASE_CLOUD_ANALYSIS_ID_A owned by test user A, or approve creation of isolated fixtures.");
      else await check("RLS on existing A-owned analysis", async () => {
        const a = new PostgresRevisionRepository(sql, users.A), b = new PostgresRevisionRepository(sql, users.B);
        const owned = await a.head(config.analysisIdA); assert.ok(owned);
        assert.equal(await b.head(config.analysisIdA), null); assert.deepEqual(await b.history(config.analysisIdA), []);
      });
      return;
    }
    await check("explicit Save/reload/retry/stale/restore/replay and cross-user RLS", async () => {
      const handler = createWorkbookHandler(auth, actor => new PostgresRevisionRepository(sql, actor));
      async function call(token: string, query: string, payload?: unknown, expected = 200) {
        const response = await handler(new Request("http://localhost/api/workbook" + query, { method: payload === undefined ? "GET" : "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }));
        assert.equal(response.status, expected); return response.json();
      }
      const tokenA = config.tokenA!, tokenB = config.tokenB!;
      const ids = new Map<string, string>();
      const snapshot = captureSnapshot(JSON.parse(JSON.stringify(fixture()).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, old => {
        if (!ids.has(old)) ids.set(old, createStableId<"cell">()); return ids.get(old)!;
      })));
      fixtureIds = { projectId: snapshot.projectId, analysisId: snapshot.analysisId };
      const save = { operation: "SAVE", request: { intent: "SAVE_DRAFT", snapshot, expectedRevisionId: null,
        mutationId: createStableId<"mutation">(), reason: "Cloud verification: synthetic fixture, not approved business values" } };
      const first = (await call(tokenA, "", save)).revision as SavedRevision;
      assert.equal(first.kind, "SAVED_DRAFT"); assert.equal(first.run, null);
      assert.equal((await call(tokenA, `?analysisId=${snapshot.analysisId}`)).revision.revisionId, first.revisionId);
      const changed = updateCellInput(first.snapshot, "INU", snapshot.profiles.INU.hppBase.cellId, { kind: "TEXT", text: "Cloud test manual HPP draft" });
      const second = (await call(tokenA, "", { operation: "SAVE", request: { ...save.request, snapshot: changed,
        expectedRevisionId: first.revisionId, mutationId: createStableId<"mutation">() } })).revision as SavedRevision;
      assert.equal((await call(tokenA, "", save)).revision.revisionId, first.revisionId);
      await call(tokenA, "", { operation: "SAVE", request: { ...save.request, expectedRevisionId: first.revisionId,
        mutationId: createStableId<"mutation">() } }, 409);
      assert.equal(await call(tokenB, `?analysisId=${snapshot.analysisId}`), null);
      assert.deepEqual(await call(tokenB, `?view=history&analysisId=${snapshot.analysisId}`), []);
      await call(tokenB, `?view=revision&analysisId=${snapshot.analysisId}&revisionId=${first.revisionId}`, undefined, 403);
      await call(tokenB, "", save, 403);
      const restored = (await call(tokenA, "", { operation: "RESTORE", request: { analysisId: snapshot.analysisId, sourceRevisionId: first.revisionId,
        expectedRevisionId: second.revisionId, mutationId: createStableId<"mutation">(), reason: "Cloud verification restore" } })).revision as SavedRevision;
      assert.notEqual(restored.revisionId, first.revisionId); assert.equal(restored.parentRevisionId, second.revisionId);
      assert.equal(canonicalJson({ ...restored.snapshot, id: first.snapshot.id }), canonicalJson(first.snapshot));
      assert.equal(canonicalJson(await call(tokenA, `?view=replay&analysisId=${snapshot.analysisId}&revisionId=${first.revisionId}`)), canonicalJson(first.snapshot));
      assert.equal((await call(tokenA, `?view=history&analysisId=${snapshot.analysisId}`)).length, 3);
      checks.push({ check: "retained synthetic cloud fixture", status: "PASS", detail: "projectId=" + snapshot.projectId + "; analysisId=" + snapshot.analysisId + "; three immutable draft revisions retained" });
    });
  } finally { await sql.end({ timeout: 5 }); }
}

try { await main(); }
catch { checks.push({ check: "cloud verifier", status: "FAIL", detail: "Configuration, Auth or connection failed; secrets and raw errors are suppressed." }); }
console.log(JSON.stringify({ scope: connectivityOnly ? "CONNECTIVITY_ONLY" : "RUNTIME", checks,
  ...(fixtureIds ? { fixtureIds, cleanup: "No remote rows deleted; inspect these IDs if the flow failed midway." } : {}) }, null, 2));
process.exitCode = checks.some(c => c.status === "FAIL") ? 1 : checks.some(c => c.status === "GAP") ? 2 : 0;
