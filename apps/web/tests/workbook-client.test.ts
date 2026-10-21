import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiError, invalidateSessionRequests, readSession } from "../src/ui/workbook-client.ts";

test("a response from a previous session cannot reach the workspace", async t => {
  invalidateSessionRequests();
  const response = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", () => response.promise);
  const request = api("/api/workbook?analysisId=old");
  invalidateSessionRequests();
  response.resolve(Response.json({ snapshot: "must not be used" }));
  await assert.rejects(request, cause => cause instanceof ApiError && cause.code === "SESSION_CHANGED");
});

test("pending session checks share one request but never cache a completed session", async t => {
  invalidateSessionRequests();
  const response = Promise.withResolvers<Response>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; return response.promise; });
  const first = readSession(), second = readSession();
  assert.equal(first, second); assert.equal(calls, 1);
  response.resolve(Response.json({ actorId: null }));
  await first;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ actorId: null }); });
  await readSession(); assert.equal(calls, 2);
});

test("Save retry after session refresh retains the exact mutation body", async t => {
  invalidateSessionRequests();
  const body = JSON.stringify({ operation: "SAVE", request: { mutationId: "same-mutation", expectedVersion: "same-version" } });
  const requests: { url: string; body: BodyInit | null | undefined }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body });
    if (requests.length === 1) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    return Response.json(url === "/api/session" ? {} : { status: "SAVED" });
  });
  assert.deepEqual(await api("/api/workbook", { method: "POST", body }), { status: "SAVED" });
  assert.deepEqual(requests.map(request => request.url), ["/api/workbook", "/api/session", "/api/workbook"]);
  assert.equal(requests[0]!.body, body); assert.equal(requests[2]!.body, body);
});
