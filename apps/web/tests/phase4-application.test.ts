import assert from "node:assert/strict";
import { it } from "node:test";
import { id } from "./phase2-fixture.ts";
import { AuthenticationError, ServiceUnavailableError, SupabaseAuthenticator } from "../src/server/supabase-auth.ts";
import { createWorkbookHandler } from "../src/server/workbook-handler.ts";
import { AccessDeniedError } from "../src/persistence/postgres-revision-repository.ts";
import { RuntimeDatabaseRoleError } from "../src/persistence/runtime-role.ts";

const key = "sb_publishable_structural_test_only";
const request = (token?: string) => new Request("http://localhost/api/workbook", { headers: token ? { authorization: "Bearer " + token } : {} });
function repository(failure: () => Promise<never>) {
  return { save: failure, restore: failure, head: failure, get: failure, history: failure, replay: failure,
    listProjects: failure, listAnalyses: failure, calculate: failure, runs: failure, latestRun: failure };
}

it("authenticates through Supabase /auth/v1/user, with no-store and a publishable key, rather than trusting token claims", async () => {
  const actor = id<"user">();
  const auth = new SupabaseAuthenticator("https://example.supabase.co", key, async (url, options) => {
    assert.equal(String(url), "https://example.supabase.co/auth/v1/user");
    assert.equal(options?.cache, "no-store");
    assert.equal(new Headers(options?.headers).get("apikey"), key);
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer opaque-test-token");
    assert.equal(options?.redirect, "error");
    return Response.json({ id: actor, role: "authenticated" });
  });
  assert.equal(await auth.authenticate(request("opaque-test-token")), actor);
});
it("rejects missing, malformed, expired or fabricated sessions before database access", async () => {
  let called = false;
  const auth = new SupabaseAuthenticator("https://example.supabase.co", key, async () => new Response(null, { status: 401 }));
  const handler = createWorkbookHandler(auth, () => { called = true; throw new Error("must not connect"); });
  for (const r of [request(), request("fabricated"), new Request("http://localhost/api/workbook", { headers: { authorization: "Basic xyz" } })]) {
    const response = await handler(r); assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(called, false);
});
it("binds repository identity to verified Auth, ignoring caller-supplied identity headers and query parameters", async () => {
  const verified = id<"user">(), forged = id<"user">();
  const auth = new SupabaseAuthenticator("https://example.supabase.co", key, async () => Response.json({ id: verified, role: "authenticated" }));
  let actor;
  const handler = createWorkbookHandler(auth, value => {
    actor = value;
    return { ...repository(async () => { throw new Error("Unexpected storage call"); }), async listProjects() { return []; } };
  });
  const response = await handler(new Request("http://localhost/api/workbook?view=projects&actorId=" + forged,
    { headers: { authorization: "Bearer verified-remotely", "x-user-id": forged } }));
  assert.equal(response.status, 200);
  assert.equal(actor, verified);
});
it("does not accept anonymous/service-role user responses, invalid IDs or unavailable Auth as authenticated users", async () => {
  for (const user of [{ id: id<"user">(), role: "anon" }, { id: id<"user">(), role: "service_role" },
    { id: "not-uuid", role: "authenticated" }, {}]) {
    const auth = new SupabaseAuthenticator("https://example.supabase.co", key, async () => Response.json(user));
    await assert.rejects(auth.authenticate(request("token")), AuthenticationError);
  }
  for (const status of [429, 500, 503]) {
    const auth = new SupabaseAuthenticator("https://example.supabase.co", key, async () => new Response(null, { status }));
    await assert.rejects(auth.authenticate(request("token")), ServiceUnavailableError);
  }
  const offline = new SupabaseAuthenticator("https://example.supabase.co", key, async () => { throw new Error("offline"); });
  await assert.rejects(offline.authenticate(request("token")), ServiceUnavailableError);
});
it("refuses privileged keys and insecure remote Auth configuration", () => {
  const serviceRole = "header." + Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url") + ".signature";
  assert.throws(() => new SupabaseAuthenticator("https://example.supabase.co", serviceRole), ServiceUnavailableError);
  assert.throws(() => new SupabaseAuthenticator("https://example.supabase.co", "sb_secret_not-a-real-secret"), ServiceUnavailableError);
  assert.throws(() => new SupabaseAuthenticator("http://remote.example", key), ServiceUnavailableError);
  const anon = "header." + Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url") + ".signature";
  assert.ok(new SupabaseAuthenticator("http://localhost:54321", anon));
});
it("rejects wrong-project legacy keys and reports API key rejection as server configuration failure, not bad user credentials", async () => {
  const wrongProject = "header." + Buffer.from(JSON.stringify({ role: "anon", ref: "other" })).toString("base64url") + ".signature";
  assert.throws(() => new SupabaseAuthenticator("https://example.supabase.co", wrongProject), ServiceUnavailableError);
  assert.throws(() => new SupabaseAuthenticator("not-a-url", key), ServiceUnavailableError);
  const auth = new SupabaseAuthenticator("https://example.supabase.co", key, async () =>
    Response.json({ message: "Invalid API key" }, { status: 401 }));
  let connected = false;
  const handler = createWorkbookHandler(auth, () => { connected = true; throw new Error("must not connect"); });
  const response = await handler(request("opaque-token"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "SERVICE_UNAVAILABLE" });
  assert.equal(connected, false);
});
it("application rejects malformed/oversized payloads and unknown commands before storage writes", async () => {
  let writes = 0;
  const handler = createWorkbookHandler({ async authenticate() { return id<"user">(); } }, () => repository(async () => { writes++; throw new Error(); }));
  const post = (text: string) => new Request("http://localhost/api/workbook", { method: "POST", headers: { "content-type": "application/json" }, body: text });
  for (const payload of ["{", "null", "[]", JSON.stringify({ operation: "DELETE", request: {} }), JSON.stringify({ operation: "SAVE", request: {}, actorId: "fake" })]) {
    assert.equal((await handler(post(payload))).status, 400);
  }
  assert.equal((await handler(post(" ".repeat(5 * 1024 * 1024 + 1)))).status, 413);
  assert.equal((await handler(new Request("http://localhost/api/workbook", { method: "DELETE" }))).status, 405);
  assert.equal(writes, 0);
});
it("application error responses do not disclose database credentials or SQL", async () => {
  const factory = () => repository(async () => { throw new Error("postgres://private-user:password@secret-host insert secret SQL"); });
  const handler = createWorkbookHandler({ async authenticate() { return id<"user">(); } }, factory);
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "STORAGE_UNAVAILABLE" });
  const denied = createWorkbookHandler({ async authenticate() { return id<"user">(); } }, () => repository(async () => { throw new AccessDeniedError(); }));
  assert.equal((await denied(request())).status, 403);
  const unsafe = createWorkbookHandler({ async authenticate() { return id<"user">(); } }, () => repository(async () => { throw new RuntimeDatabaseRoleError(); }));
  const blocked = await unsafe(request());
  assert.equal(blocked.status, 503);
  assert.deepEqual(await blocked.json(), { code: "SERVICE_UNAVAILABLE" });
});
