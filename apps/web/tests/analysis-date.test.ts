import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyWorkbook, initializeAnalysisDate } from "../src/domain/workflow.ts";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { prepareLegacySheet } from "../src/domain/legacy-sheet.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { setCellFormula } from "../src/domain/structure.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";

function dates(s: WorkbookSnapshot) {
  return s.worksheets.filter(w => w.stage === "AHS").flatMap(w => w.tables.flatMap(t => t.cells.filter(c =>
    s.workbook ? s.workbook.cells.some(p => p.cellId === c.id && p.address === (c.scope === "INU" ? "H4" : "H3"))
      : t.rows.some(r => r.id === c.rowId && r.label === "Tgl Analisis (Rn)"))));
}

for (const layout of ["template", "legacy"] as const) test(`${layout}: creation date uses Jakarta and stays fixed in both profiles`, () => {
  const initial = layout === "template" ? createProcurementWorkbook("Project", "Analysis") : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
  const created = initializeAnalysisDate(initial, new Date("2026-10-19T18:30:00Z"));
  const cells = dates(created);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map(c => c.source), [
    { kind: "INPUT", input: { kind: "TEXT", text: "20/10/2026" } },
    { kind: "INPUT", input: { kind: "TEXT", text: "20/10/2026" } },
  ]);
  assert.equal(initializeAnalysisDate(created, new Date("2026-10-23T00:00:00Z")), created);
  const custom = setCellFormula(created, cells[0]!.id, '"Tanggal manual"');
  assert.equal(initializeAnalysisDate(custom, new Date("2026-10-24T00:00:00Z")), custom);
});

test("creation date survives normalized storage round trip", () => {
  const created = initializeAnalysisDate(createProcurementWorkbook("Project", "Analysis"), new Date("2026-10-19T08:00:00Z"));
  const saved = encodeWorkbook(created, created.workbook!.configuration);
  const loaded = decodeWorkbook(saved, { analysisId: created.analysisId, projectId: created.projectId, analysisName: "Analysis", projectName: "Project" });
  assert.deepEqual(dates(loaded.snapshot), dates(created));
});
