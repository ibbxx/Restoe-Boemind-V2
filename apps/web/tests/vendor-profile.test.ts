import assert from "node:assert/strict";
import { test } from "node:test";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { prepareVendorColumns, addSheetVendor } from "../src/domain/dynamic-workflow.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import { addRow, setCellInput } from "../src/domain/structure.ts";
import { parseSnapshot } from "../src/domain/validation.ts";
import { addVendorAspect, ensureVendorProfileTable, isVendorAspectHeading, isVendorProfileTable, vendorProfileRows } from "../src/domain/vendor-profile.ts";
import { prepareLegacySheet } from "../src/domain/legacy-sheet.ts";
import { emptyWorkbook } from "../src/domain/workflow.ts";

test("informasi vendor tersimpan sebagai sel teks dan mengikuti kolom vendor", () => {
  let snapshot = prepareVendorColumns(createProcurementWorkbook("Project", "Analysis"));
  snapshot = addSheetVendor(snapshot, "Vendor 4", "C");
  const tables = snapshot.worksheets.find(sheet => sheet.stage === "EVALUASI_VENDOR")?.tables.filter(isVendorProfileTable) ?? [];
  assert.equal(tables.length, 1);
  const table = tables[0]!;
  assert.equal(tables.reduce((count, item) => count + item.rows.length, 0), vendorProfileRows.length);
  assert.equal(table.columns.length, 5);
  assert.equal(table.rows.filter(row => row.label.endsWith("|conclusion")).length, 3);
  const cell = table.cells.find(item => item.rowId === table.rowOrder[1] && item.columnId === table.columnOrder[4])!;
  snapshot = setCellInput(snapshot, cell.id, { kind: "TEXT", text: "PKP" });
  const saved = snapshot.worksheets.flatMap(sheet => sheet.tables).flatMap(item => item.cells).find(item => item.id === cell.id)!;
  assert.deepEqual(saved.source, { kind: "INPUT", input: { kind: "TEXT", text: "PKP" } });
});

for (const layout of ["template", "legacy"] as const) {
  test(`${layout}: kelompok baru dan uraian masuk ke kelompok yang dipilih, tetap utuh setelah reload`, () => {
    let snapshot = layout === "template" ? prepareVendorColumns(createProcurementWorkbook("Project", "Analysis")) : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
    const profile = () => snapshot.worksheets.find(sheet => sheet.stage === "EVALUASI_VENDOR")!.tables.find(isVendorProfileTable)!;
    const before = profile();
    const groups = before.rowOrder.filter(rowId => isVendorAspectHeading(before.rows.find(row => row.id === rowId)!.label));
    assert.equal(groups.length, 5);
    const group = addVendorAspect(snapshot, "Layanan Purnajual", null);
    snapshot = group.snapshot;
    const groupRow = profile().cells.find(cell => cell.id === group.firstCellId)!.rowId;
    assert(isVendorAspectHeading(profile().rows.find(row => row.id === groupRow)!.label));
    const item = addVendorAspect(snapshot, "Waktu respons", groupRow);
    snapshot = item.snapshot;
    const itemRow = profile().cells.find(cell => cell.id === item.firstCellId)!.rowId;
    assert.equal(profile().rowOrder.indexOf(itemRow), profile().rowOrder.indexOf(groupRow) + 1);
    const first = addVendorAspect(snapshot, "Kelengkapan dokumen", groups[0]!);
    snapshot = first.snapshot;
    const second = addVendorAspect(snapshot, "Masa berlaku izin", groups[0]!);
    snapshot = second.snapshot;
    const firstRow = profile().cells.find(cell => cell.id === first.firstCellId)!.rowId;
    const secondRow = profile().cells.find(cell => cell.id === second.firstCellId)!.rowId;
    assert.equal(profile().rowOrder.indexOf(secondRow), profile().rowOrder.indexOf(firstRow) + 1);
    assert.equal(profile().rowOrder.indexOf(groups[1]!), profile().rowOrder.indexOf(secondRow) + 1);
    assert.equal(profile().cells.filter(cell => cell.rowId === secondRow).length, before.columns.length);
    assert.throws(() => addVendorAspect(snapshot, "Uraian", "missing-group"), /Pilih kelompok/);
    assert.throws(() => addVendorAspect(snapshot, " ", null), /Nama aspek/);
    snapshot = updateCellInput(snapshot, "SHARED", group.firstCellId, { kind: "TEXT", text: "Layanan Vendor" });
    snapshot = ensureVendorProfileTable(parseSnapshot(JSON.parse(JSON.stringify(snapshot))));
    assert.equal(profile().rows.filter(row => isVendorAspectHeading(row.label)).length, 6);
    assert.equal(profile().cells.find(cell => cell.id === group.firstCellId)?.source.kind, "INPUT");
    for (const cell of before.cells) assert.deepEqual(profile().cells.find(saved => saved.id === cell.id), cell);
  });
}

test("seluruh uraian aspek, kategori, dan uraian tambahan tetap dapat diedit tanpa mengubah vendor lain", () => {
  let snapshot = prepareVendorColumns(createProcurementWorkbook("Project", "Analysis"));
  let table = snapshot.worksheets.find(sheet => sheet.stage === "EVALUASI_VENDOR")!.tables.find(isVendorProfileTable)!;
  const vendorCell = table.cells.find(cell => cell.rowId === table.rowOrder[1] && cell.columnId === table.columnOrder[1])!;
  const originalVendorSource = vendorCell.source;
  const labelIds = table.rowOrder.map(rowId => table.cells.find(cell => cell.rowId === rowId && cell.columnId === table.columnOrder[0])!.id);
  for (const [index, cellId] of labelIds.entries()) {
    snapshot = updateCellInput(snapshot, "SHARED", cellId, { kind: "TEXT", text: `Uraian ${index + 1}` });
  }
  table = snapshot.worksheets.find(sheet => sheet.stage === "EVALUASI_VENDOR")!.tables.find(isVendorProfileTable)!;
  const firstConclusion = table.rows.find(row => row.label.endsWith("|conclusion"))!;
  const beforeConclusion = table.rowOrder[table.rowOrder.indexOf(firstConclusion.id) - 1]!;
  snapshot = addRow(snapshot, table.id, { label: "vendor-profile-extra|test", scope: "SHARED", afterRowId: beforeConclusion });
  table = snapshot.worksheets.find(sheet => sheet.stage === "EVALUASI_VENDOR")!.tables.find(isVendorProfileTable)!;
  const extraRow = table.rowOrder[table.rowOrder.indexOf(firstConclusion.id) - 1]!;
  const extraLabel = table.cells.find(cell => cell.rowId === extraRow && cell.columnId === table.columnOrder[0])!;
  snapshot = setCellInput(snapshot, extraLabel.id, { kind: "TEXT", text: "Kesiapan dokumen" });
  snapshot = updateCellInput(snapshot, "SHARED", extraLabel.id, { kind: "TEXT", text: "Kelengkapan dokumen" });

  const reloaded = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  const saved = reloaded.worksheets.find(sheet => sheet.stage === "EVALUASI_VENDOR")!.tables.find(isVendorProfileTable)!;
  for (const [index, cellId] of labelIds.entries()) {
    assert.deepEqual(saved.cells.find(cell => cell.id === cellId)?.source, { kind: "INPUT", input: { kind: "TEXT", text: `Uraian ${index + 1}` } });
  }
  assert.deepEqual(saved.cells.find(cell => cell.id === extraLabel.id)?.source, { kind: "INPUT", input: { kind: "TEXT", text: "Kelengkapan dokumen" } });
  assert.deepEqual(saved.cells.find(cell => cell.id === vendorCell.id)?.source, originalVendorSource);
});
