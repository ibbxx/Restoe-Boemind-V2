import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { startTestCluster } from "./postgres-test-cluster.ts";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function ready(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("Test service exited before readiness; inspect private test logs.");
    try { if ((await fetch(url)).ok) return; } catch { /* Service is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Test service readiness timed out: " + new URL(url).pathname);
}
async function terminate(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

// All endpoints and credentials are generated locally. Never reads .env or accepts a remote database URL.
export async function startUIEnvironment() {
  const authBinary = process.env.UI_AUTH_BINARY ?? "/private/tmp/procurement-auth-v2.197.0/auth";
  assert.ok(existsSync(authBinary), "Install the checksum-verified Supabase Auth v2.197.0 binary; see docs/agent-context/PHASE5_VERIFICATION.md.");
  const directory = mkdtempSync(join(tmpdir(), "procurement-phase5-"));
  const authLog = openSync(join(directory, "auth.log"), "a", 0o600), appLog = openSync(join(directory, "app.log"), "a", 0o600);
  const cluster = await startTestCluster();
  const authPort = await freePort(), proxyPort = await freePort(), appPort = await freePort();
  const baseURL = `http://127.0.0.1:${appPort}`, authURL = `http://127.0.0.1:${proxyPort}`;
  let auth: ChildProcess | undefined, app: ChildProcess | undefined;
  const proxy = createServer((incoming, outgoing) => {
    const forwarded = httpRequest({ hostname: "127.0.0.1", port: authPort, path: incoming.url?.replace(/^\/auth\/v1/, "") || "/",
      method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    forwarded.on("error", () => { outgoing.writeHead(503); outgoing.end(); }); incoming.pipe(forwarded);
  });
  const stop = async () => {
    await terminate(app); await terminate(auth);
    if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    await cluster.stop(); closeSync(authLog); closeSync(appLog); rmSync(directory, { recursive: true, force: true });
  };
  try {
    const runtimePassword = randomBytes(32).toString("base64url");
    await cluster.sql.unsafe("alter role procurement_test_connection password '" + runtimePassword + "'");
    const authEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test", PATH: process.env.PATH, GOTRUE_API_HOST: "127.0.0.1", PORT: String(authPort), API_EXTERNAL_URL: authURL + "/auth/v1",
      GOTRUE_SITE_URL: baseURL, GOTRUE_DB_DRIVER: "postgres", GOTRUE_DB_NAMESPACE: "auth",
      GOTRUE_DB_DATABASE_URL: `postgres://postgres:${cluster.password}@127.0.0.1:${cluster.port}/postgres?sslmode=disable&search_path=auth`,
      GOTRUE_JWT_SECRET: randomBytes(48).toString("base64url"), GOTRUE_JWT_EXP: "3600", GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated", GOTRUE_JWT_ADMIN_ROLES: "service_role",
      GOTRUE_DISABLE_SIGNUP: "false", GOTRUE_EXTERNAL_EMAIL_ENABLED: "true", GOTRUE_MAILER_AUTOCONFIRM: "true",
      GOTRUE_LOG_LEVEL: "error", GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "true",
    };
    execFileSync(authBinary, ["migrate"], { cwd: dirname(authBinary), stdio: ["ignore", authLog, authLog], env: authEnv, timeout: 30000 });
    auth = spawn(authBinary, ["serve"], { cwd: dirname(authBinary), stdio: ["ignore", authLog, authLog], env: authEnv });
    assert.ok(auth); await ready(`http://127.0.0.1:${authPort}/health`, auth);
    await new Promise<void>(resolve => proxy.listen(proxyPort, "127.0.0.1", resolve));
    const password = randomBytes(24).toString("base64url") + "aA1!";
    const users = ["buyer-a@procurement.test", "buyer-b@procurement.test"];
    for (const email of users) {
      const response = await fetch(authURL + "/auth/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200, "Real local GoTrue signup must succeed.");
      const session = await response.json();
      const verified = await fetch(authURL + "/auth/v1/user", { headers: { authorization: "Bearer " + session.access_token } });
      assert.equal(verified.status, 200, "Real local GoTrue must validate its issued token.");
      const identity = await verified.json();
      assert.equal(identity.role, "authenticated", "Local Auth users must have the authenticated role.");
    }
    const appEnv = { ...process.env, DATABASE_URL: `postgres://procurement_test_connection:${runtimePassword}@127.0.0.1:${cluster.port}/postgres`,
      SUPABASE_URL: authURL, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_ui_fixture", NEXT_TELEMETRY_DISABLED: "1" };
    async function startApp() {
      app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(appPort)],
        { stdio: ["ignore", appLog, appLog], env: appEnv });
      await ready(baseURL, app);
    }
    await startApp();
    return { baseURL, authURL, users, password, directory, sql: cluster.sql, stop,
      restartApp: async () => { await terminate(app); await startApp(); } };
  } catch (error) {
    // Print paths only; logs may contain temporary credentials and must not be copied into reports.
    console.error("Local UI environment failed; private logs:", directory);
    await terminate(app); await terminate(auth);
    if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    await cluster.stop(); closeSync(authLog); closeSync(appLog);
    throw error;
  }
}
