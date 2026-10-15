import { it } from "node:test";
import assert from "node:assert/strict";
import { createSessionHandler, withBrowserSession, sameOrigin } from "../src/server/browser-session.ts";
import { createStableId } from "../src/domain/ids.ts";

const env = { SUPABASE_URL: "http://127.0.0.1:9999", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture" };
function request(body: unknown, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
it("rejects cross-origin login and cookie mutations before contacting Auth", async () => {
  let calls = 0;
  const handler = createSessionHandler(env, async () => { calls++; return new Response(); });
  assert.equal((await handler(request({ operation: "LOGIN", email: "test@local.test", password: "synthetic" }, "http://evil.test"))).status, 403);
  assert.equal(calls, 0);
  const result = withBrowserSession(new Request("http://localhost:3000/api/workbook", { method: "POST", headers: { cookie: "procurement_access=synthetic" } }));
  assert.ok(result instanceof Response); assert.equal(result.status, 403);
  const bearer = new Request("http://localhost:3000/api/workbook", { method: "POST", headers: { authorization: "Bearer explicit-api-token" } });
  assert.equal(withBrowserSession(bearer), bearer);
});
it("uses the HTTP Host for Next loopback routing while rejecting other origins", () => {
  const req = (origin: string) => new Request("http://localhost:3105/api/session", { headers: { host: "127.0.0.1:3105", origin } });
  assert.equal(sameOrigin(req("http://127.0.0.1:3105")), true);
  assert.equal(sameOrigin(req("http://localhost:3105")), false);
  assert.equal(sameOrigin(req("https://127.0.0.1:3105")), false);
  assert.equal(sameOrigin(req("null")), false);
  assert.equal(sameOrigin(req("http://127.0.0.1:3105/")), false);
});
it("reports Auth network failure as unavailable rather than invalid input", async () => {
  const handler = createSessionHandler(env, async () => { throw new TypeError("fetch failed; secret details"); });
  const response = await handler(request({ operation: "LOGIN", email: "test@local.test", password: "synthetic" }));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: "AUTH_UNAVAILABLE" });
});
it("validates the returned user, sets HttpOnly cookies and never sends tokens in JSON", async () => {
  const actorId = createStableId<"user">();
  const handler = createSessionHandler(env, async input => String(input).includes("/token")
    ? Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" })
    : Response.json({ id: actorId, role: "authenticated" }));
  const response = await handler(request({ operation: "LOGIN", email: "test@local.test", password: "synthetic" }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { actorId });
  const cookies = response.headers.getSetCookie(); assert.equal(cookies.length, 2);
  for (const cookie of cookies) { assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//); }
});
it("refreshes using the server cookie and removes rejected refresh cookies", async () => {
  let posted = "";
  const handler = createSessionHandler(env, async (_input, init) => { posted = String(init?.body); return Response.json({}, { status: 400 }); });
  const req = request({ operation: "REFRESH" }); req.headers.set("cookie", "procurement_refresh=synthetic-refresh");
  const response = await handler(req);
  assert.equal(response.status, 401); assert.match(posted, /synthetic-refresh/);
  assert.ok(response.headers.getSetCookie().every(c => c.includes("Max-Age=0")));
});
it("returns safe errors for invalid credentials and rejects oversized login payloads", async () => {
  const handler = createSessionHandler(env, async () => Response.json({ message: "do not expose upstream details" }, { status: 400 }));
  const invalid = await handler(request({ operation: "LOGIN", email: "test@local.test", password: "synthetic" }));
  assert.equal(invalid.status, 401); assert.deepEqual(await invalid.json(), { code: "INVALID_CREDENTIALS" });
  assert.equal((await handler(request({ operation: "LOGIN", email: "test@local.test", password: "x".repeat(17000) }))).status, 413);
});
it("revokes the local Auth session through refresh even after access cookie expiry", async () => {
  const calls: string[] = [];
  const handler = createSessionHandler(env, async (input, init) => {
    calls.push(new URL(String(input)).pathname);
    if (String(input).includes("/token")) return Response.json({ access_token: "renewed-synthetic" });
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer renewed-synthetic");
    return new Response(null, { status: 204 });
  });
  const req = new Request("http://localhost:3000/api/session", { method: "DELETE", headers: { origin: "http://localhost:3000", cookie: "procurement_refresh=synthetic-refresh" } });
  const response = await handler(req);
  assert.equal(response.status, 200); assert.deepEqual(calls, ["/auth/v1/token", "/auth/v1/logout"]);
  assert.ok(response.headers.getSetCookie().every(c => c.includes("Max-Age=0")));
});
it("distinguishes rejected API key or malformed Auth responses from a wrong password", async () => {
  for (const upstream of [Response.json({ message: "Invalid API key" }, { status: 401 }), new Response("malformed", { status: 200 })]) {
    const handler = createSessionHandler(env, async () => upstream);
    const response = await handler(request({ operation: "LOGIN", email: "test@local.test", password: "synthetic" }));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: "AUTH_UNAVAILABLE" });
  }
});
