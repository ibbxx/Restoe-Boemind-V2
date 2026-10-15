import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

// Never accepts DATABASE_URL: database tests can only migrate their own newly initialized temporary cluster.
export async function startTestCluster() {
  assert.match(execFileSync("initdb", ["--version"], { encoding: "utf8" }), /PostgreSQL\) 17\./,
    "PostgreSQL 17 binaries must be on PATH for database verification.");
  const directory = mkdtempSync(join(tmpdir(), "procurement-phase4-pg-"));
  const data = join(directory, "data");
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const password = randomBytes(32).toString("base64url");
  const passwordFile = join(directory, "password");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const certificate = join(directory, "server.crt");
  const key = join(directory, "server.key");
  let running = false;
  const options = { host: directory, port, database: "postgres", username: "postgres", prepare: false, max: 5,
    onnotice: () => {} } as const;
  const sql = postgres(options);
  let runtimeSql: postgres.Sql | undefined;
  async function stop() {
    await runtimeSql?.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
    if (running) execFileSync("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "pipe", timeout: 30000 });
    running = false;
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    execFileSync("initdb", ["-D", data, "--auth-local=trust", "--auth-host=scram-sha-256", "--pwfile", passwordFile,
      "-U", "postgres", "--no-locale", "-E", "UTF8"], { stdio: "pipe", timeout: 30000 });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe", timeout: 30000 });
    // Private socket for repository tests; password-protected loopback for CLI URL compatibility.
    execFileSync("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o",
      `-F -h 127.0.0.1 -k ${directory} -p ${port} -c ssl=on -c ssl_cert_file=${certificate} -c ssl_key_file=${key}`, "-w", "start"],
      { stdio: "pipe", timeout: 30000 });
    running = true;
    // Supabase Auth compatibility fixture only; this is not a real GoTrue service.
    await sql.unsafe(`create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
      $$;
      create role authenticated nologin;
      create role anon nologin;
      -- Match modern PostgreSQL's public-schema CREATE default; never fix this globally on cloud.
      revoke create on schema public from public;
      -- Exercise migration hardening against broad operator defaults, not only a clean cluster.
      alter default privileges grant all on tables to public, anon, authenticated;
      alter default privileges grant usage on schemas to public, anon, authenticated;`);
    const migrator = postgres({ ...options, max: 1 });
    try {
      await migrator.begin(tx => tx.unsafe(readFileSync(new URL("../supabase/migrations/202610140001_procurement_storage.sql", import.meta.url), "utf8")));
      await migrator.begin(tx => tx.unsafe(readFileSync(new URL("../supabase/migrations/20261015023734_procurement_actor_claims.sql", import.meta.url), "utf8")));
    }
    finally { await migrator.end(); }
    await sql.unsafe(`revoke usage on schema auth from procurement_runtime;
      create role procurement_test_connection login noinherit nosuperuser nobypassrls nocreaterole nocreatedb noreplication;
      grant procurement_runtime to procurement_test_connection with inherit false, set true, admin false;`);
    runtimeSql = postgres({ ...options, username: "procurement_test_connection" });
    return { sql, runtimeSql, port, password, certificate,
      connect: (username = "procurement_test_connection") => postgres({ ...options, username, max: 1 }), stop };
  } catch (error) { await stop(); throw error; }
}
