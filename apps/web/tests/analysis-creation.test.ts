import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisDateInput, analysisPeriod, createAnalysisWorkbook } from "../src/domain/analysis-creation.ts";
import type { AnalysisCreationInput } from "../src/domain/analysis-creation.ts";
import type { CellSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "../src/domain/contracts.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { cellCodes } from "../src/domain/cell-address.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import { initializeAnalysisDate } from "../src/domain/workflow.ts";
import { prepareLegacySheet, legacyConfiguration, connectAhsHpp, makeAhsSaleInput } from "../src/domain/legacy-sheet.ts";
import { prepareVendorColumns, prepareSelectedVendorMappings } from "../src/domain/dynamic-workflow.ts";
import { prepareNumericBlanks } from "../src/domain/procurement-template.ts";
import { prepareCalculationPolicy } from "../src/domain/calculation-policy.ts";
import { prepareAhsRollups } from "../src/domain/ahs-groups.ts";
import { ahsVolumeSource, connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";

const input: AnalysisCreationInput = {
  projectId: id<"project">(), projectName: " Gedung A ", analysisName: " Evaluasi vendor Oktober ", material: " HSD ",
  customer: " PT Customer ", location: " Samarinda ", analysisDate: "2026-10-20",
  marketing: " Budi ", payment: " 30 hari ", economicPrice: " 20.000 ",
  source: " Penawaran ", document: " SPH-001 ", discount: " 2% ", volume: " 50.000 ",
};

function cell(s: WorkbookSnapshot, stage: WorksheetSnapshot["stage"], label: string, scope: CellSnapshot["scope"]) {
  const found = s.worksheets.filter(w => w.stage === stage).flatMap(w => w.tables.flatMap(t =>
    t.cells.filter(c => c.scope === scope && t.rows.some(r => r.id === c.rowId && r.label === label))));
  assert.equal(found.length, 1, `${stage} ${scope} ${label}`);
  return found[0]!;
}

function assertText(c: CellSnapshot, value: string) {
  assert.deepEqual(c.source, { kind: "INPUT", input: { kind: "TEXT", text: value } });
}

function assertHeaders(s: WorkbookSnapshot) {
  assertText(cell(s, "EVALUASI_VENDOR", "Pekerjaan / Material", "SHARED"), "HSD");
  assertText(cell(s, "EVALUASI_VENDOR", "Customer", "SHARED"), "PT Customer");
  assertText(cell(s, "EVALUASI_VENDOR", "Lokasi", "SHARED"), "Samarinda");
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
    assertText(cell(s, "KONVERSI_JAGAD", "Periode", profile), "P2-OKT-2026");
    assert.deepEqual(ahsVolumeSource(s, profile)?.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "50000" } });
    for (const [label, value] of Object.entries({ "Tgl Analisis (Rn)": "20/10/2026", Marketing: "Budi", Pembayaran: "30 hari",
      "Harga Keekonomian": "20.000", Sumber: "Penawaran", Lokasi: "Samarinda", Dokumen: "SPH-001", Diskon: "2%" })) {
      assertText(cell(s, "AHS", label, profile), value);
    }
  }
}

test("new analysis keeps its own name and fills period and visible headers in both profiles", () => {
  const s = createAnalysisWorkbook(input);
  assert.equal(s.projectId, input.projectId);
  assert.equal(s.project.name, "Gedung A");
  assert.equal(s.analysis.analysis.name, "Evaluasi vendor Oktober");
  assert.equal(s.analysis.analysis.projectId, input.projectId);
  assertHeaders(s);
  const codes = cellCodes(s);
  for (const [label, address] of [["Pekerjaan / Material", "D5"], ["Customer", "D6"], ["Lokasi", "D7"]]) {
    assert.equal(codes.get(cell(s, "EVALUASI_VENDOR", label!, "SHARED").id), `EV!${address}`);
  }
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) assertText(cell(s, "KONVERSI_JAGAD", "Lokasi", profile), "Samarinda");
  assert.equal(s.selectedOfferId, null);
  assert(s.analysis.offers.every(offer => offer.values.length === 0));
});

test("optional AHS fields stay unset and the default date follows the Jakarta calendar", () => {
  assert.equal(analysisDateInput(new Date("2026-10-19T16:59:59Z")), "2026-10-19");
  assert.equal(analysisDateInput(new Date("2026-10-19T17:00:00Z")), "2026-10-20");
  const s = createAnalysisWorkbook({ projectName: "Proyek baru", analysisName: "Analisis pertama", material: "HSD", customer: "Customer", location: "Jakarta" });
  const expectedDate = analysisDateInput().split("-").reverse().join("/");
  assert.equal(s.analysis.analysis.name, "Analisis pertama");
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
    assertText(cell(s, "KONVERSI_JAGAD", "Periode", profile), analysisPeriod(analysisDateInput()));
    assertText(cell(s, "AHS", "Tgl Analisis (Rn)", profile), expectedDate);
    assert.deepEqual(ahsVolumeSource(s, profile)?.source, { kind: "INPUT", input: { kind: "UNSET" } });
    for (const label of ["Marketing", "Pembayaran", "Harga Keekonomian", "Sumber", "Dokumen", "Diskon"]) {
      assert.deepEqual(cell(s, "AHS", label, profile).source, { kind: "INPUT", input: { kind: "UNSET" } });
    }
  }
});

test("creation rejects blank identity fields and invalid dates before producing a workbook", () => {
  for (const key of ["projectName", "analysisName", "material", "customer", "location"] as const) {
    for (const value of ["", "   "]) assert.throws(() => createAnalysisWorkbook({ ...input, [key]: value }), /wajib diisi/);
  }
  for (const date of ["", "20/10/2026", "2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01"]) {
    assert.throws(() => createAnalysisWorkbook({ ...input, analysisDate: date }), /Tanggal analisis tidak valid/);
  }
  assertText(cell(createAnalysisWorkbook({ ...input, analysisDate: "2024-02-29" }), "AHS", "Tgl Analisis (Rn)", "INU"), "29/02/2024");
});

test("initial AHS volume accepts Indonesian numbers and rejects text", () => {
  for (const [raw, expected] of [["50.000", "50000"], ["50000", "50000"], ["50,5", "50.5"], ["1.000,5", "1000.5"]] as const) {
    const s = createAnalysisWorkbook({ ...input, volume: raw });
    for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
      assert.deepEqual(ahsVolumeSource(s, profile)?.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: expected } });
    }
  }
  for (const raw of ["lima puluh", "1,2,3"]) assert.throws(() => createAnalysisWorkbook({ ...input, volume: raw }), /Volume AHS wajib berupa angka/);
});

test("analyses in one project and each profile remain independent after creation", () => {
  const first = createAnalysisWorkbook(input), second = createAnalysisWorkbook({ ...input, analysisName: "Evaluasi ulang", analysisDate: "2026-11-01" });
  const original = canonicalJson(first);
  assert.equal(first.projectId, second.projectId);
  assert.notEqual(first.analysisId, second.analysisId);
  const ids = new Set(first.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))));
  assert(second.worksheets.every(w => w.tables.every(t => t.cells.every(c => !ids.has(c.id)))));
  let edited = updateCellInput(first, "INU", cell(first, "AHS", "Marketing", "INU").id, { kind: "TEXT", text: "Marketing baru" });
  edited = updateCellInput(edited, "INU", cell(edited, "KONVERSI_JAGAD", "Periode", "INU").id, { kind: "TEXT", text: "Periode lain" });
  edited = updateCellInput(edited, "INU", ahsVolumeSource(edited, "INU")!.id, { kind: "NUMERIC_TEXT", text: "25000" });
  assert.deepEqual(ahsVolumeSource(edited, "SOLAR_BAWAH")?.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "50000" } });
  assertText(cell(edited, "AHS", "Marketing", "SOLAR_BAWAH"), "Budi");
  assertText(cell(second, "AHS", "Marketing", "INU"), "Budi");
  assert.equal(edited.analysis.analysis.name, "Evaluasi vendor Oktober");
  assert.equal(second.analysis.analysis.name, "Evaluasi ulang");
  assertText(cell(second, "KONVERSI_JAGAD", "Periode", "INU"), "P1-NOV-2026");
  assert.equal(canonicalJson(first), original);
});

test("period follows the selected date across fortnight, month, year and leap-day boundaries", () => {
  for (const [date, period] of [
    ["2026-10-01", "P1-OKT-2026"], ["2026-10-14", "P1-OKT-2026"],
    ["2026-10-15", "P2-OKT-2026"], ["2026-10-31", "P2-OKT-2026"],
    ["2026-04-30", "P2-APR-2026"], ["2026-02-28", "P2-FEB-2026"],
    ["2024-02-29", "P2-FEB-2024"], ["2026-12-31", "P2-DES-2026"],
    ["2027-01-01", "P1-JAN-2027"],
  ] as const) {
    assert.equal(analysisPeriod(date), period);
    const s = createAnalysisWorkbook({ ...input, analysisDate: date });
    for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
      assertText(cell(s, "KONVERSI_JAGAD", "Periode", profile), period);
    }
  }
  for (const date of ["", "2026-02-29", "2026-04-31", "2026-13-01"]) assert.equal(analysisPeriod(date), "");
});

test("headers and chosen date survive editor preparation and repeated current-storage round trips", () => {
  let s = createAnalysisWorkbook(input);
  s = prepareCalculationPolicy(s, legacyConfiguration(s, null)).snapshot;
  s = prepareAhsRollups(connectAhsVolumes(prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(s)))))));
  s = prepareSelectedVendorMappings(currentSnapshot(s), id<"user">());
  assertHeaders(s);
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
    const volumeSource = ahsVolumeSource(s, profile)!;
    const follower = cell(s, "AHS", "Harga Jual · PBBKB · Volume", profile);
    assert.equal(follower.source.kind, "FORMULA");
    assert.equal(s.formulas.find(formula => formula.targetCellId === follower.id)?.expression, `@{${volumeSource.id}}`);
    const target = cell(s, "KONVERSI_JAGAD", "Lokasi", profile);
    assert.equal(target.source.kind, "MAPPING");
    const mapping = s.mappings.find(m => m.targetCellId === target.id)!;
    assert.equal(mapping.sourceCellId, cell(s, "EVALUASI_VENDOR", "Lokasi", "SHARED").id);
  }
  const config = legacyConfiguration(s, null);
  for (let i = 0; i < 2; i++) {
    const stored = encodeWorkbook(s, config);
    const loaded = decodeWorkbook(stored, { projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name });
    assert.equal(canonicalJson(loaded.snapshot), canonicalJson(s));
    s = loaded.snapshot;
    assertHeaders(s);
    assert.equal(initializeAnalysisDate(s, new Date("2026-11-01T00:00:00Z")), s);
    assertHeaders(prepareLegacySheet(s));
  }
});
