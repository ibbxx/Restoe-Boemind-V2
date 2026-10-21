import assert from "node:assert/strict";
import test from "node:test";
import { analysisListUrl, matchesAnalysis, matchesName, projectLocationUrl, readProjectLocation } from "../src/ui/project-navigation.ts";

test("project, worksheet and filters survive a URL round trip", () => {
  const location = { ...readProjectLocation(""), projectId: "project-1", analysisId: "analysis-1", projectQuery: "Tonasa & co", analysisQuery: "Oktober + baru", status: "HOLD" as const, period: "P2-OKT-2026" };
  const url = projectLocationUrl(location);
  assert.deepEqual(readProjectLocation(new URL(url, "http://localhost").search), location);
  assert.equal(projectLocationUrl(readProjectLocation("")), "/");
});

test("old worksheet links remain readable and unsupported statuses use All", () => {
  assert.equal(readProjectLocation("?analysisId=old-analysis").analysisId, "old-analysis");
  assert.equal(readProjectLocation("?status=unknown").status, "");
  assert.equal(readProjectLocation("?projectId=").projectId, null);
});

test("analysis pagination and filters reach the API and survive navigation", () => {
  const location = { ...readProjectLocation(""), projectId: "project-1", after: "cursor", analysisQuery: "100% & co", status: "HOLD" as const, period: "NONE" };
  const params = new URL(analysisListUrl(location), "http://localhost").searchParams;
  assert.equal(params.get("after"), "cursor"); assert.equal(params.get("query"), "100% & co");
  assert.equal(params.get("period"), "NONE"); assert.equal(params.get("status"), "HOLD");
  assert.deepEqual(readProjectLocation(new URL(projectLocationUrl(location), "http://localhost").search), location);
  const focus = new URL(analysisListUrl(location, "active-id"), "http://localhost").searchParams;
  assert.equal(focus.get("analysisId"), "active-id"); assert.equal(focus.has("after"), false);
});

test("name search trims the query and ignores case", () => {
  assert.equal(matchesName("TONASA", " tonasa "), true);
  assert.equal(matchesName("TONASA", " "), true);
  assert.equal(matchesName("TONASA", "lain"), false);
});

test("analysis name, status and period filters combine without changing source data", () => {
  const analysis = Object.freeze({ name: "Evaluasi Oktober", status: "HOLD" as const, period: "P2-OKT-2026" });
  const filters = { ...readProjectLocation(""), analysisQuery: " oktober ", status: "HOLD" as const, period: analysis.period };
  assert.equal(matchesAnalysis(analysis, filters), true);
  assert.equal(matchesAnalysis(analysis, { ...filters, analysisQuery: "November" }), false);
  assert.equal(matchesAnalysis(analysis, { ...filters, status: "ACTIVE" }), false);
  assert.equal(matchesAnalysis(analysis, { ...filters, period: "P1-OKT-2026" }), false);
  assert.equal(matchesAnalysis(analysis, readProjectLocation("")), true);
});

test("missing periods remain visible under All and have a separate filter", () => {
  const analysis = { name: "Analisis lama", status: "DRAFT" as const, period: null };
  assert.equal(matchesAnalysis(analysis, readProjectLocation("")), true);
  assert.equal(matchesAnalysis(analysis, { ...readProjectLocation(""), period: "NONE" }), true);
  assert.equal(matchesAnalysis(analysis, { ...readProjectLocation(""), period: "P2-OKT-2026" }), false);
  assert.equal(matchesAnalysis({ ...analysis, period: "P2-OKT-2026" }, { ...readProjectLocation(""), period: "NONE" }), false);
});
