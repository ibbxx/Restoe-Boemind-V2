import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisPage } from "../src/application/contracts.ts";
import { api, ApiError, cachedWorkbookList, invalidateSessionRequests, invalidateWorkbookLists, prefetchWorkbookList, readWorkbookList } from "../src/ui/workbook-client.ts";
import type { ProjectListItem } from "../src/ui/workbook-client.ts";

const projectsUrl = "/api/workbook?view=projects";
const pageUrl = (projectId = "project-1", filters = "") => `/api/workbook?view=analyses&projectId=${projectId}${filters}`;
const projects = [{ id: "project-1", name: "Project" }];
const page: AnalysisPage = { items: [], total: 0, periods: [], nextCursor: null, previousCursor: null };

test("prefetch and click share a request, and only one speculative request runs at a time", async t => {
  invalidateSessionRequests();
  const response = Promise.withResolvers<Response>();
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", (url: string) => { requests.push(url); return response.promise; });
  const prefetch = prefetchWorkbookList("actor-1", pageUrl()); assert(prefetch);
  assert.equal(prefetchWorkbookList("actor-1", pageUrl("project-2")), null);
  const click = readWorkbookList<AnalysisPage>("actor-1", pageUrl());
  assert.equal(click.pending, prefetch);
  assert.deepEqual(requests, [pageUrl()]);
  response.resolve(Response.json(page)); await click.pending;
  assert.equal(prefetchWorkbookList("actor-1", pageUrl()), null);
  assert.equal(readWorkbookList("actor-1", pageUrl()).pending, null);
  assert.equal(requests.length, 1);
});

test("failed prefetch allows foreground retry, and logout releases the speculative slot", async t => {
  invalidateSessionRequests();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const failure = prefetchWorkbookList("actor-1", pageUrl()); assert(failure);
  await assert.rejects(failure, /Koneksi terputus/);
  t.mock.method(globalThis, "fetch", async () => Response.json(page));
  assert.deepEqual(await readWorkbookList("actor-1", pageUrl()).pending, page);
  const old = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", () => old.promise);
  const pending = prefetchWorkbookList("actor-1", pageUrl("project-2")); assert(pending);
  invalidateSessionRequests();
  t.mock.method(globalThis, "fetch", async () => Response.json(page));
  const next = prefetchWorkbookList("actor-2", pageUrl()); assert(next);
  old.resolve(Response.json(page));
  await assert.rejects(pending, cause => cause instanceof ApiError && cause.code === "SESSION_CHANGED");
  assert.deepEqual(await next, page);
  assert.equal(cachedWorkbookList("actor-1", pageUrl("project-2")), undefined);
});

test("fresh lists make zero extra requests; stale lists retain their value while one refresh runs", async t => {
  invalidateSessionRequests();
  let now = 1000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const response = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.cache, "no-store"); calls++;
    return calls === 1 ? Response.json(projects) : response.promise;
  });
  const initial = readWorkbookList<ProjectListItem[]>("actor-1", projectsUrl);
  assert.equal(initial.cached, undefined); assert(initial.pending);
  await initial.pending;
  for (let i = 0; i < 5; i++) {
    const read = readWorkbookList<ProjectListItem[]>("actor-1", projectsUrl);
    assert.deepEqual(read.cached, projects); assert.equal(read.pending, null);
  }
  assert.equal(calls, 1);
  now += 29999;
  assert.equal(readWorkbookList("actor-1", projectsUrl).pending, null);
  now++;
  const stale = readWorkbookList<ProjectListItem[]>("actor-1", projectsUrl);
  const simultaneous = readWorkbookList<ProjectListItem[]>("actor-1", projectsUrl);
  assert.deepEqual(stale.cached, projects); assert.equal(stale.pending, simultaneous.pending);
  assert.equal(calls, 2);
  response.resolve(Response.json([...projects, { id: "project-2", name: "New project" }]));
  assert.equal((await stale.pending)!.length, 2);
  assert.equal(cachedWorkbookList<ProjectListItem[]>("actor-1", projectsUrl)!.length, 2);
});

test("cold duplicate reads share one pending request", async t => {
  invalidateSessionRequests();
  const response = Promise.withResolvers<Response>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; return response.promise; });
  const first = readWorkbookList("actor-1", pageUrl());
  const second = readWorkbookList("actor-1", pageUrl());
  assert.equal(first.pending, second.pending); assert.equal(calls, 1);
  response.resolve(Response.json(page)); await first.pending;
});

test("cache isolates actors, projects, query, status, period and pagination", async t => {
  invalidateSessionRequests();
  const urls = [pageUrl(), pageUrl("project-2"), pageUrl("project-1", "&query=other"),
    pageUrl("project-1", "&status=HOLD"), pageUrl("project-1", "&period=NONE"),
    pageUrl("project-1", "&after=next"), pageUrl("project-1", "&before=previous"), pageUrl("project-1", "&limit=5")];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...page, total: ++calls }));
  for (const url of urls) await readWorkbookList("actor-1", url).pending;
  await readWorkbookList("actor-2", urls[0]!).pending;
  assert.equal(calls, urls.length + 1);
  assert.equal(cachedWorkbookList<AnalysisPage>("actor-1", urls[0]!)!.total, 1);
  assert.equal(cachedWorkbookList<AnalysisPage>("actor-2", urls[0]!)!.total, urls.length + 1);
  assert.equal(cachedWorkbookList("actor-3", urls[0]!), undefined);
});

test("project invalidation preserves other projects and optionally clears the project list", async t => {
  invalidateSessionRequests();
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url === projectsUrl ? projects : page));
  for (const url of [projectsUrl, pageUrl(), pageUrl("project-1", "&status=HOLD"), pageUrl("project-2")]) {
    await readWorkbookList("actor-1", url).pending;
  }
  invalidateWorkbookLists("project-1");
  assert.equal(cachedWorkbookList("actor-1", pageUrl()), undefined);
  assert.equal(cachedWorkbookList("actor-1", pageUrl("project-1", "&status=HOLD")), undefined);
  assert.deepEqual(cachedWorkbookList("actor-1", pageUrl("project-2")), page);
  assert.deepEqual(cachedWorkbookList("actor-1", projectsUrl), projects);
  invalidateWorkbookLists("project-2", true);
  assert.equal(cachedWorkbookList("actor-1", projectsUrl), undefined);
});

test("a read started before a successful mutation cannot overwrite the replacement", async t => {
  invalidateSessionRequests();
  const old = Promise.withResolvers<Response>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? old.promise : Response.json({ ...page, total: 2 }));
  const first = readWorkbookList("actor-1", pageUrl());
  invalidateWorkbookLists("project-1");
  const replacement = readWorkbookList("actor-1", pageUrl());
  await replacement.pending;
  old.resolve(Response.json({ ...page, total: 1 }));
  assert.equal(await first.pending, undefined);
  assert.equal(cachedWorkbookList<AnalysisPage>("actor-1", pageUrl())!.total, 2);
});

test("failed background refresh preserves the last list and permits retry", async t => {
  invalidateSessionRequests();
  let now = 0, calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 2) throw new Error("offline");
    return Response.json(projects);
  });
  await readWorkbookList("actor-1", projectsUrl).pending;
  now = 30000;
  const stale = readWorkbookList("actor-1", projectsUrl);
  await assert.rejects(stale.pending!, /Koneksi terputus/);
  assert.deepEqual(cachedWorkbookList("actor-1", projectsUrl), projects);
  await readWorkbookList("actor-1", projectsUrl).pending;
  assert.equal(calls, 3);
});

test("session invalidation clears lists and discards responses even for the same actor", async t => {
  invalidateSessionRequests();
  const old = Promise.withResolvers<Response>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 2 ? old.promise : Response.json(page));
  await readWorkbookList("actor-1", pageUrl()).pending;
  const pending = readWorkbookList("actor-1", pageUrl("project-2")).pending;
  invalidateSessionRequests();
  assert.equal(cachedWorkbookList("actor-1", pageUrl()), undefined);
  old.resolve(Response.json(page));
  await assert.rejects(pending!, cause => cause instanceof ApiError && cause.code === "SESSION_CHANGED");
  assert.equal(cachedWorkbookList("actor-1", pageUrl("project-2")), undefined);
});

test("rejected authentication clears cached lists instead of retaining an authorized result", async t => {
  invalidateSessionRequests();
  t.mock.method(globalThis, "fetch", async () => Response.json(projects));
  await readWorkbookList("actor-1", projectsUrl).pending;
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
  await assert.rejects(readWorkbookList("actor-1", pageUrl()).pending!,
    cause => cause instanceof ApiError && cause.code === "UNAUTHENTICATED");
  assert.equal(cachedWorkbookList("actor-1", projectsUrl), undefined);
});

test("twenty analysis pages use LRU eviction without evicting the project list", async t => {
  invalidateSessionRequests();
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url === projectsUrl ? projects : page));
  await readWorkbookList("actor-1", projectsUrl).pending;
  for (let i = 0; i < 20; i++) await readWorkbookList("actor-1", pageUrl("project-1", `&after=${i}`)).pending;
  readWorkbookList("actor-1", pageUrl("project-1", "&after=0"));
  await readWorkbookList("actor-1", pageUrl("project-1", "&after=20")).pending;
  assert.deepEqual(cachedWorkbookList("actor-1", projectsUrl), projects);
  assert(cachedWorkbookList("actor-1", pageUrl("project-1", "&after=0")));
  assert.equal(cachedWorkbookList("actor-1", pageUrl("project-1", "&after=1")), undefined);
});

test("workbooks and session results are never stored in the list cache", async t => {
  invalidateSessionRequests();
  assert.throws(() => readWorkbookList("actor-1", "/api/workbook?analysisId=analysis-1"), TypeError);
  assert.throws(() => readWorkbookList("actor-1", "/api/session"), TypeError);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ snapshot: "current" }); });
  await api("/api/workbook?analysisId=analysis-1");
  await api("/api/workbook?analysisId=analysis-1");
  assert.equal(calls, 2);
  assert.equal(cachedWorkbookList("actor-1", "/api/workbook?analysisId=analysis-1"), undefined);
});
