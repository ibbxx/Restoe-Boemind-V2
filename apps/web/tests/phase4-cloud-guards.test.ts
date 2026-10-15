import assert from "node:assert/strict";
import { it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cloudTestConfig } from "./cloud-test-config.ts";
import { runtimeConfiguration } from "../src/server/runtime-configuration.ts";

function environment(): Record<string, string | undefined> {
  return { DATABASE_URL: "postgresql://runtime:synthetic-password@db.testref.supabase.co/postgres?sslmode=verify-full",
    SUPABASE_URL: "https://testref.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic" };
}
it("cloud verification defaults to read-only even if write environment flags were left enabled", () => {
  const env = { ...environment(), SUPABASE_CLOUD_ALLOW_WRITES: "1", SUPABASE_CLOUD_CONFIRM_PROJECT: "testref" };
  assert.equal(cloudTestConfig(env).allowWrites, false);
  assert.equal(cloudTestConfig(env, true).allowWrites, true);
});
it("cloud writes require both explicit flags and matching project confirmation", () => {
  assert.throws(() => cloudTestConfig(environment(), true), /Writes require/);
  assert.throws(() => cloudTestConfig({ ...environment(), SUPABASE_CLOUD_ALLOW_WRITES: "1", SUPABASE_CLOUD_CONFIRM_PROJECT: "other" }, true));
});
it("missing credentials identify only missing variable names", () => {
  assert.throws(() => cloudTestConfig({}), /DATABASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY/);
});
it("wrong-project connections and insecure TLS settings fail before connecting", () => {
  for (const url of ["postgresql://runtime:synthetic-password@db.other.supabase.co/postgres",
    "postgresql://runtime.other:synthetic-password@aws-0-region.pooler.supabase.com/postgres",
    environment().DATABASE_URL!.replace("verify-full", "disable")]) {
    assert.throws(() => cloudTestConfig({ ...environment(), DATABASE_URL: url }), error =>
      error instanceof Error && !error.message.includes("synthetic-password"));
  }
  assert.throws(() => cloudTestConfig({ ...environment(), NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
});
it("accepts the matching Supabase pooler username and rejects URL parameters overriding connection options", () => {
  const env = { ...environment(), DATABASE_URL: "postgresql://runtime.testref:synthetic-password@aws-0-region.pooler.supabase.com:6543/postgres" };
  assert.equal(cloudTestConfig(env).pooler, true);
  assert.throws(() => cloudTestConfig({ ...env, DATABASE_URL: env.DATABASE_URL + "?ssl=false" }));
});
it("runtime and preflight share project and TLS validation, with credential-free errors", () => {
  assert.equal(runtimeConfiguration(environment()).ssl, "verify-full");
  for (const overrides of [
    { DATABASE_URL: "postgresql://runtime:synthetic-password@db.other.supabase.co/postgres" },
    { DATABASE_URL: environment().DATABASE_URL + "&host=db.other.supabase.co" },
    { DATABASE_URL: environment().DATABASE_URL!.replace("verify-full", "disable") },
    { DATABASE_URL: "postgresql://runtime:synthetic-password@localhost/postgres" },
    { DATABASE_URL: "postgresql://runtime@db.testref.supabase.co/postgres" },
    { SUPABASE_URL: "https://testref.supabase.co/unsupported-path" },
    { SUPABASE_PUBLISHABLE_KEY: "sb_secret_synthetic" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  ]) {
    for (const parse of [runtimeConfiguration, cloudTestConfig]) assert.throws(() => parse({ ...environment(), ...overrides }), error =>
      error instanceof Error && !error.message.includes("synthetic-password") && !error.message.includes("sb_secret_synthetic"));
  }
});
it("runtime permits paired local development endpoints but cloud preflight does not", () => {
  const env = { ...environment(), DATABASE_URL: "postgresql://runtime@localhost/postgres", SUPABASE_URL: "http://127.0.0.1:54321" };
  assert.equal(runtimeConfiguration(env).ssl, false);
  assert.throws(() => cloudTestConfig(env));
});
it("Git ignores environment files at both the repository root and Next.js app root", () => {
  const paths = [".env", ".env.production.local", "apps/web/.env.local"];
  const ignored = execFileSync("git", ["check-ignore", "--no-index", ...paths], { cwd: new URL("../../../", import.meta.url), encoding: "utf8" });
  assert.deepEqual(ignored.trim().split("\n"), paths);
});

const diagnosticUrl = "postgresql://postgres.testref:diagnostic-password@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=verify-full";
it("operator ledger inspection never replaces the runtime login and requires the exact same database", () => {
  const env = environment();
  const audit = env.DATABASE_URL!.replace("runtime:synthetic-password", "operator:audit-password");
  const config = cloudTestConfig({ ...env, SUPABASE_MIGRATION_AUDIT_URL: audit });
  assert.equal(config.databaseUrl, env.DATABASE_URL);
  assert.equal(config.migrationAuditUrl, audit);
  assert.equal(config.allowWrites, false);
  assert.equal(runtimeConfiguration({ ...env, SUPABASE_MIGRATION_AUDIT_URL: audit }).databaseUrl, env.DATABASE_URL);
  for (const invalid of [audit.replace("/postgres?", "/other?"), audit.replace("db.testref", "db.other"),
    audit.replace("verify-full", "disable"), audit.replace(".co/", ".co:6543/"), "audit-password"]) {
    assert.throws(() => cloudTestConfig({ ...env, SUPABASE_MIGRATION_AUDIT_URL: invalid }), error =>
      error instanceof Error && !error.message.includes("audit-password"));
  }
});
it("connectivity-only preflight uses a separate diagnostic login without a runtime URL or user tokens", () => {
  const env = { ...environment(), DATABASE_URL: undefined, PREFLIGHT_DATABASE_URL: diagnosticUrl };
  const config = cloudTestConfig(env, false, true);
  assert.equal(config.databaseUrl, diagnosticUrl);
  assert.equal(config.connectivityOnly, true);
  assert.equal(config.allowWrites, false);
  assert.equal(config.ssl, "verify-full");
  assert.equal(env.DATABASE_URL, undefined);
});
it("diagnostic credentials never replace the runtime URL or implicitly enable diagnostic mode", () => {
  const env: Record<string, string | undefined> = { ...environment(), PREFLIGHT_DATABASE_URL: diagnosticUrl };
  assert.equal(cloudTestConfig(env).databaseUrl, env.DATABASE_URL);
  assert.equal(cloudTestConfig(env, false, true).databaseUrl, diagnosticUrl);
  assert.throws(() => cloudTestConfig({ ...env, DATABASE_URL: undefined }), /Missing environment: DATABASE_URL/);
  assert.throws(() => cloudTestConfig(environment(), false, true), /Missing environment: PREFLIGHT_DATABASE_URL/);
});
it("connectivity-only preflight refuses writes even when every write approval flag is present", () => {
  const env = { ...environment(), PREFLIGHT_DATABASE_URL: diagnosticUrl, SUPABASE_CLOUD_ALLOW_WRITES: "1", SUPABASE_CLOUD_CONFIRM_PROJECT: "testref" };
  assert.equal(cloudTestConfig(env, false, true).allowWrites, false);
  assert.throws(() => cloudTestConfig(env, true, true), /Connectivity-only preflight cannot write/);
});
it("diagnostic preflight validates session mode, project and TLS without exposing credentials", () => {
  for (const url of [diagnosticUrl.replace(":5432", ":6543"), diagnosticUrl.replace("postgres.testref:", "postgres.other:"),
    diagnosticUrl.replace("verify-full", "disable"), diagnosticUrl + "&sslrootcert=/unapproved/path",
    "not-a-url-diagnostic-password"]) {
    assert.throws(() => cloudTestConfig({ ...environment(), PREFLIGHT_DATABASE_URL: url }, false, true), error =>
      error instanceof Error && !error.message.includes("diagnostic-password"));
  }
  assert.throws(() => cloudTestConfig({ ...environment(), PREFLIGHT_DATABASE_URL: diagnosticUrl, NODE_TLS_REJECT_UNAUTHORIZED: "0" }, false, true));
});
it("diagnostic CLI rejects missing credentials and mixed write mode before any connection, with sanitized output", () => {
  for (const [extraArgs, diagnostic, message] of [
    [[], "", "Missing environment: PREFLIGHT_DATABASE_URL"],
    [["--write"], diagnosticUrl, "Connectivity-only preflight cannot write."],
  ] as const) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "tests/verify-supabase-cloud.ts", "--connectivity-only", ...extraArgs], {
      cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 5000,
      env: { ...process.env, ...environment(), PREFLIGHT_DATABASE_URL: diagnostic,
        SUPABASE_CLOUD_ALLOW_WRITES: "1", SUPABASE_CLOUD_CONFIRM_PROJECT: "testref" },
    });
    assert.equal(result.status, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.scope, "CONNECTIVITY_ONLY");
    assert.deepEqual(output.checks, [{ check: "cloud configuration", status: "GAP", detail: message }]);
    assert.ok(!(result.stdout + result.stderr).includes("diagnostic-password"));
    assert.ok(!(result.stdout + result.stderr).includes("synthetic-password"));
  }
});
