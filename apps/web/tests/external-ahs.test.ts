import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { prepareLegacySheet, legacyConfiguration, connectAhsHpp, makeAhsSaleInput } from "../src/domain/legacy-sheet.ts";
import { emptyWorkbook } from "../src/domain/workflow.ts";
import { connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { prepareVendorColumns, changeSheetProfile } from "../src/domain/dynamic-workflow.ts";
import { createExternalAhs, internalAhsFingerprint, refreshExternalAhs, externalAddresses, externalCellIds, addExternalAhsItem, addExternalAhsField } from "../src/domain/external-ahs.ts";
import { FormulaEngine, worksheetRunView } from "../src/engine/formula-engine.ts";
import { setCellInput, setCellFormula, removeRow } from "../src/domain/structure.ts";
import { canvasCellAddresses } from "../src/domain/canvas-address.ts";
import { displayFormula, resolveFormula } from "../src/domain/cell-address.ts";
import { addAhsItem, ahsRoleCell } from "../src/domain/ahs-groups.ts";
import { addAhsField } from "../src/domain/ahs-fields.ts";
import { canonicalJson, captureSnapshot } from "../src/domain/snapshots.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { buildSheetGrid, visibleSheetTable } from "../src/ui/sheet-grid.ts";

const config = (s: WorkbookSnapshot) => s.workbook?.configuration ?? legacyConfiguration(s, null);
for (const layout of ["legacy", "dynamic"] as const) {
  function initial() {
    return changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(layout === "legacy" ? prepareLegacySheet(emptyWorkbook("Project", "Analysis")) : prepareVendorColumns(createProcurementWorkbook("Project", "Analysis"))))), "SOLAR_BAWAH");
  }
  test(`${layout}: fingerprints ignore external edits and refreshing replaces only the active profile`, async () => {
    let s = initial();
    let run = new FormulaEngine(config(s)).evaluate(s);
    const fingerprint = await internalAhsFingerprint(s, config(s), run, s.activeProfile);
    const first = createExternalAhs(s, config(s), run, { SOLAR_BAWAH: fingerprint, INU: "a".repeat(64) });
    s = first.snapshot;
    const other = s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.find(t => t.cells[0]!.scope === "INU")!;
    const otherBefore = canonicalJson(other);
    const added = addExternalAhsItem(s, first.configuration, "Tambahan eksternal", "BIAYA", null, "Eksternal saja");
    s = added.snapshot;
    run = new FormulaEngine(added.configuration).evaluate(s);
    assert.equal(await internalAhsFingerprint(s, added.configuration, run, s.activeProfile), fingerprint);
    const price = ahsRoleCell(s, s.activeProfile, "I10", "Harga Jual · Harga Dasar")!;
    s = setCellInput(s, price.id, { kind: "NUMERIC_TEXT", text: "23999" });
    run = new FormulaEngine(added.configuration).evaluate(s);
    const latest = await internalAhsFingerprint(s, added.configuration, run, s.activeProfile);
    assert.notEqual(latest, fingerprint);
    const internal = canonicalJson(s.worksheets.filter(w => w.stage !== "AHS_EXTERNAL"));
    const oldIds = new Set(s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.filter(t => t.cells[0]!.scope === s.activeProfile).flatMap(t => t.cells.map(c => c.id)));
    assert.throws(() => refreshExternalAhs(s, { ...added.configuration, aggregates: [...added.configuration.aggregates, {
      id: id<"aggregate">(), versionId: id<"aggregate-version">(), memberCellIds: [oldIds.values().next().value!, other.cells[0]!.id],
    }] }, run, latest), /Agregat Eksternal/);
    const refreshed = refreshExternalAhs(s, added.configuration, run, latest);
    s = refreshed.snapshot;
    assert.equal(canonicalJson(s.worksheets.filter(w => w.stage !== "AHS_EXTERNAL")), internal);
    assert.equal(canonicalJson(s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.find(t => t.id === other.id)), otherBefore);
    assert(!s.externalAhs!.groups.some(g => g.name === "Eksternal saja"));
    assert(s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).every(c => !oldIds.has(c.id)));
    assert(refreshed.configuration.units.every(u => !oldIds.has(u.cellId)));
    assert.equal(s.externalAhs!.sourceFingerprints!.SOLAR_BAWAH, latest);
    assert.equal(s.externalAhs!.sourceFingerprints!.INU, "a".repeat(64));
    assert.equal(await internalAhsFingerprint(s, refreshed.configuration, new FormulaEngine(refreshed.configuration).evaluate(s), s.activeProfile), latest);
    const stored = encodeWorkbook(s, refreshed.configuration);
    const loaded = decodeWorkbook(stored, { projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name });
    assert.equal(canonicalJson(loaded.snapshot), canonicalJson(s));
    assert.throws(() => captureSnapshot({ ...s, externalAhs: { ...s.externalAhs!, sourceFingerprints: { SOLAR_BAWAH: "invalid" } } }), /fingerprint/);
  });
  test(`${layout}: initial external copy uses the latest unsaved draft and rejects stale calculation results`, () => {
    let s = initial();
    const oldRun = new FormulaEngine(config(s)).evaluate(s);
    const price = ahsRoleCell(s, s.activeProfile, "I10", "Harga Jual · Harga Dasar")!;
    s = setCellInput(s, price.id, { kind: "NUMERIC_TEXT", text: "23777" });
    assert.throws(() => createExternalAhs(s, config(s), oldRun), /perhitungan Internal terbaru/);
    const copied = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s));
    const externalPrice = copied.snapshot.externalAhs!.groups.find(g => g.profile === s.activeProfile && g.section === "PENDAPATAN")!.items[0]!.priceCellId;
    const external = copied.snapshot.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.flatMap(t => t.cells).find(c => c.id === externalPrice)!;
    assert.deepEqual(external.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "23777" } });
    const changed = setCellInput(copied.snapshot, price.id, { kind: "NUMERIC_TEXT", text: "25000" });
    assert.equal(canonicalJson(changed.worksheets.find(w => w.stage === "AHS_EXTERNAL")), canonicalJson(copied.snapshot.worksheets.find(w => w.stage === "AHS_EXTERNAL")));
    assert.throws(() => createExternalAhs(changed, copied.configuration, new FormulaEngine(copied.configuration).evaluate(changed)), /sudah dibuat/);
  });
  test(`${layout}: external copy is independent, formula references remap, HPP and volume are editable`, () => {
    let s = initial();
    const originalWorksheets = canonicalJson(s.worksheets);
    const originalAddresses = [...canvasCellAddresses(s)];
    const originalIds = new Set(s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))));
    const originalRun = new FormulaEngine(config(s)).evaluate(s);
    const copied = createExternalAhs(s, config(s), originalRun);
    s = copied.snapshot;
    assert(copied.incomplete > 0);
    assert.equal(canonicalJson(s.worksheets.filter(w => w.stage !== "AHS_EXTERNAL")), originalWorksheets);
    assert.deepEqual([...canvasCellAddresses(s)], originalAddresses);
    const external = externalCellIds(s);
    assert([...external].every(id => !originalIds.has(id as never)));
    assert(s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.every(t => { assert.doesNotThrow(() => buildSheetGrid(t)); return true; }));
    for (const formula of s.formulas.filter(f => external.has(f.targetCellId))) assert(formula.referenceCellIds.every(ref => external.has(ref)));
    const cost = s.externalAhs!.groups.find(g => g.profile === s.activeProfile && g.name === "HPP")!.items[0]!;
    s = setCellInput(s, cost.priceCellId, { kind: "NUMERIC_TEXT", text: "12000" });
    s = setCellInput(s, cost.volumeCellId, { kind: "NUMERIC_TEXT", text: "1000" });
    s = setCellFormula(s, cost.volumeCellId, "500*2");
    s = setCellFormula(s, cost.totalCellId, `@{${cost.priceCellId}}*@{${cost.volumeCellId}}`);
    const run = new FormulaEngine(config(s)).evaluate(s, "EXTERNAL");
    const total = run.provisional!.results.find(r => r.cellId === cost.totalCellId)!;
    assert("value" in total);
    assert.equal(total.value, "12000000");
    assert.equal(canonicalJson(s.worksheets.filter(w => w.stage !== "AHS_EXTERNAL")), originalWorksheets);
    assert.throws(() => createExternalAhs(s, config(s), run), /sudah dibuat/);
  });
  test(`${layout}: hiding discount keeps Operasional in its six columns without changing saved data`, () => {
    let s = initial();
    s = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s)).snapshot;
    const original = canonicalJson(s);
    for (const table of s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables) {
      const hidden = new Set(table.rows.filter(row => row.label.split("|")[2] === "external-hidden").map(row => row.id));
      const visible = visibleSheetTable(table, hidden), grid = buildSheetGrid(visible);
      const profile = table.cells[0]!.scope;
      const costOfFund = s.externalAhs!.groups.find(group => group.profile === profile && group.name === "COST OF FUND")!;
      assert.equal(visible.merges.find(merge => merge.anchorCellId === costOfFund.labelCellId)!.rowSpan, 2);
      const operational = s.externalAhs!.groups.find(group => group.profile === profile && group.name === "OPERASIONAL")!;
      for (const [index, item] of operational.items.entries()) {
        const price = table.cells.find(cell => cell.id === item.priceCellId)!;
        const row = grid[visible.rowOrder.indexOf(price.rowId)]!;
        assert.equal(index === 0 ? row[0]?.cell?.id : row[0], index === 0 ? operational.labelCellId : null);
        assert.equal(row[1]?.cell?.id, item.labelCellId);
        assert.equal(row[2]?.cell?.id, item.priceCellId);
        assert.equal(row[3]?.cell?.id, item.volumeCellId);
        assert.equal(row[4]?.cell?.id, item.totalCellId);
        assert.equal(row[4]?.colSpan, 2);
        assert.equal(row[5], null);
      }
      assert(visible.rowOrder.every(rowId => !hidden.has(rowId)));
    }
    assert.equal(canonicalJson(s), original);
  });
  test(`${layout}: external Informasi and Laba fields stay editable and persist on each profile`, () => {
    let s = initial();
    s = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s)).snapshot;
    const internal = canonicalJson(s.worksheets.filter(w => w.stage !== "AHS_EXTERNAL"));
    for (const profile of ["SOLAR_BAWAH", "INU"] as const) {
      s = changeSheetProfile(s, profile);
      const other = s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.find(t => t.cells[0]!.scope !== profile)!;
      const otherBefore = canonicalJson(other);
      const formulasBefore = canonicalJson(s.formulas);
      for (const section of ["INFORMASI", "LABA"] as const) {
        const added = addExternalAhsField(s, config(s), section, section === "INFORMASI" ? "Kontak" : "Margin Tambahan");
        s = added.snapshot;
        const field = s.externalAhs!.fields.at(-1)!;
        const table = s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.find(t => t.cells[0]!.scope === profile)!;
        const value = table.cells.find(c => c.id === field.valueCellId)!;
        const row = buildSheetGrid(table)[table.rowOrder.indexOf(value.rowId)]!;
        assert.equal(field.profile, profile);
        assert.equal(added.firstCellId, field.labelCellId);
        assert.equal(field.valueType, section === "INFORMASI" ? "TEXT" : "NUMBER");
        assert.equal(s.externalAhs!.cells.find(c => c.cellId === value.id)!.unit, section === "INFORMASI" ? "text" : "1");
        if (section === "INFORMASI") {
          assert.equal(row[1]!.colSpan, 2); assert.equal(row[4]!.colSpan, 2);
          const include = table.rows.find(r => r.label.endsWith("|HARGA INCLUDE"))!;
          assert(table.rowOrder.indexOf(value.rowId) < table.rowOrder.indexOf(include.id));
          s = setCellInput(s, value.id, { kind: "TEXT", text: "Tim Penjualan" });
        } else {
          assert.equal(row[0]!.colSpan, 5); assert.equal(row[5]!.cell!.id, value.id);
          const notes = table.rowOrder.find(id => table.rows.find(r => r.id === id)!.label.split("|")[2] === "ahs-notes")!;
          assert(table.rowOrder.indexOf(value.rowId) < table.rowOrder.indexOf(notes));
          assert.deepEqual(value.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "0" } });
        }
      }
      assert.equal(canonicalJson(s.formulas), formulasBefore, "informational fields must not alter totals");
      const laba = s.externalAhs!.fields.find(f => f.profile === profile && f.name === "Margin Tambahan")!;
      s = setCellFormula(s, laba.valueCellId, "1+2");
      const run = new FormulaEngine(config(s)).evaluate(s, "EXTERNAL");
      const result = run.results.find(r => r.cellId === laba.valueCellId)!;
      assert("value" in result); assert.equal(result.value, "3");
      const labaValue = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(c => c.id === laba.valueCellId)!;
      const labaRow = new Set(s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).filter(c => c.rowId === labaValue.rowId).map(c => c.id));
      assert(run.results.filter(r => labaRow.has(r.cellId)).every(r => ["TEXT", "VALUE", "ZERO"].includes(r.status)), "covered text cells must not create waiting/error results");
      assert.equal(canonicalJson(s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.find(t => t.id === other.id)), otherBefore);
    }
    assert.equal(canonicalJson(s.worksheets.filter(w => w.stage !== "AHS_EXTERNAL")), internal);
    const stored = currentSnapshot(s);
    const loaded = decodeWorkbook(encodeWorkbook(stored, config(stored)), { projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name });
    assert.deepEqual(loaded.snapshot.externalAhs!.fields, stored.externalAhs!.fields);
    assert.throws(() => addExternalAhsField(s, config(s), "INFORMASI", " "), /Nama uraian/);
  });
  test(`${layout}: external add actions reject duplicate names and groups from another profile`, () => {
    let s = initial();
    s = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s)).snapshot;
    s = addExternalAhsItem(s, config(s), "Pengiriman", "BIAYA", null, "Distribusi").snapshot;
    const group = s.externalAhs!.groups.find(g => g.profile === s.activeProfile && g.name === "Distribusi")!;
    assert.throws(() => addExternalAhsItem(s, config(s), "Handling", "BIAYA", null, " distribusi "), /Nama kelompok sudah/);
    assert.throws(() => addExternalAhsItem(s, config(s), " pengiriman ", "BIAYA", group.id, ""), /Nama uraian sudah/);
    const inactive = s.externalAhs!.groups.find(g => g.profile !== s.activeProfile)!;
    assert.throws(() => addExternalAhsItem(s, config(s), "Handling", "BIAYA", inactive.id, ""), /Pilih kelompok/);
    assert.throws(() => addExternalAhsItem(s, config(s), "Handling", "PENDAPATAN", group.id, ""), /Pilih kelompok/);
  });
  test(`${layout}: explicit Internal formulas update, reverse references and cycles are rejected`, () => {
    let s = initial();
    s = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s)).snapshot;
    const external = s.externalAhs!.groups.find(g => g.profile === s.activeProfile && g.name === "HPP")!.items[0]!.priceCellId;
    const internal = ahsRoleCell(s, s.activeProfile, "I11", "Harga Jual · Harga Dasar")!;
    s = setCellInput(s, internal.id, { kind: "NUMERIC_TEXT", text: "10000" });
    const sourceAddress = canvasCellAddresses(s).get(internal.id)!;
    const expression = resolveFormula(`INTERNAL!${sourceAddress}*1.2`, s, external);
    s = setCellFormula(s, external, expression);
    assert.equal(displayFormula(expression, s, external), `INTERNAL!${sourceAddress}*1.2`);
    s = setCellInput(s, internal.id, { kind: "NUMERIC_TEXT", text: "11000" });
    const result = new FormulaEngine(config(s)).evaluate(s, "EXTERNAL").results.find(r => r.cellId === external)!;
    assert("value" in result); assert.equal(result.value, "13200");
    assert.throws(() => setCellFormula(s, internal.id, `@{${external}}`), /Internal tidak boleh/);
    assert.throws(() => setCellFormula(s, external, `@{${external}}`), /siklus/);
    assert.throws(() => removeRow(s, internal.tableId, internal.rowId), /referensi|reference|Sumber|inti/);
    const otherProfile = s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.find(t => t.cells[0]?.scope === "INU")!.cells[0]!;
    assert.throws(() => setCellFormula(s, external, `@{${otherProfile.id}}`), /scope|profil/);
    assert.equal(resolveFormula(externalAddresses(s).get(external)!, s, external), `@{${external}}`);
  });
  test(`${layout}: extra groups, reload, normalizers and calculation statuses stay isolated`, () => {
    let s = initial();
    s = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s)).snapshot;
    const beforeInternal = new FormulaEngine(config(s)).evaluate(s).provisional!.status;
    const added = addExternalAhsItem(s, config(s), "Pengiriman", "BIAYA", null, "Distribusi Eksternal");
    s = added.snapshot;
    const item = s.externalAhs!.groups.find(g => g.name === "Distribusi Eksternal")!.items[0]!;
    s = setCellInput(s, item.priceCellId, { kind: "NUMERIC_TEXT", text: "150" });
    s = setCellInput(s, item.volumeCellId, { kind: "NUMERIC_TEXT", text: "10" });
    const full = new FormulaEngine(config(s)).evaluate(s, "EXTERNAL");
    const total = full.provisional!.results.find(r => r.cellId === item.totalCellId)!;
    assert("value" in total); assert.equal(total.value, "1500");
    s = setCellFormula(s, item.priceCellId, "1/0");
    assert.equal(new FormulaEngine(config(s)).evaluate(s).provisional!.status, beforeInternal);
    s = connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(s)))));
    assert.equal(s.formulas.find(f => f.targetCellId === item.priceCellId)?.expression, "1/0");
    s = currentSnapshot(s);
    const stored = encodeWorkbook(s, config(s));
    const loaded = decodeWorkbook(stored, { projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name });
    assert.equal(canonicalJson(loaded.snapshot), canonicalJson(s));
    assert.equal(loaded.snapshot.externalAhs!.groups.find(g => g.name === "Distribusi Eksternal")!.items[0]!.priceCellId, item.priceCellId);
  });
  test(`${layout}: switching pages reuses results with the same diagnostics as a fresh calculation`, () => {
    let s = initial();
    s = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s)).snapshot;
    const external = s.externalAhs!.groups.find(g => g.profile === s.activeProfile && g.name === "HPP")!.items[0]!.priceCellId;
    s = setCellFormula(s, external, "1/0");
    const internal = ahsRoleCell(s, s.activeProfile, "I11", "Harga Jual · Harga Dasar")!;
    for (const linked of [false, true]) {
      if (linked) {
        s = setCellFormula(s, internal.id, "1/0");
        s = setCellFormula(s, external, `@{${internal.id}}`);
      }
      const engine = new FormulaEngine(config(s)), cached = engine.evaluate(s);
      const original = canonicalJson(cached);
      let projected = cached;
      for (const view of ["EXTERNAL", "INTERNAL", "EXTERNAL"] as const) {
        projected = worksheetRunView(projected, view);
        const fresh = engine.evaluate(s, view);
        assert.equal(projected.status, fresh.status);
        assert.equal(projected.provisional!.status, fresh.provisional!.status);
        assert.deepEqual(projected.diagnostics, fresh.diagnostics);
        assert.strictEqual(projected.results, cached.results);
        assert.strictEqual(projected.provisional!.results, cached.provisional!.results);
        assert.strictEqual(projected.manifest, cached.manifest);
      }
      assert.equal(canonicalJson(cached), original);
    }
  });
}

for (const layout of ["legacy", "dynamic"] as const) {
  test(`${layout}: custom fields and groups clone with labels editable and incremental view results match full calculation`, () => {
    let s = changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(layout === "legacy" ? prepareLegacySheet(emptyWorkbook("P", "A")) : prepareVendorColumns(createProcurementWorkbook("P", "A"))))), "SOLAR_BAWAH");
    s = addAhsItem(s, null, "Pengangkutan", "Logistik");
    s = addAhsField(s, "INFORMASI", "Kontak", "TEXT");
    const copied = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s));
    s = copied.snapshot;
    const group = s.externalAhs!.groups.find(g => g.name === "Logistik")!;
    assert(group && group.items.length === 1);
    const field = s.externalAhs!.fields.find(f => f.name === "Kontak")!;
    assert.equal(s.externalAhs!.cells.find(c => c.cellId === field.valueCellId)!.unit, "text");
    s = setCellInput(s, field.valueCellId, { kind: "TEXT", text: "Tim Penjualan" });
    const next = addExternalAhsItem(s, config(s), "Distribusi", "BIAYA", group.id, "");
    s = next.snapshot;
    assert.equal(s.externalAhs!.groups.find(g => g.id === group.id)!.items.length, 2);
    for (const table of s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables) assert.doesNotThrow(() => buildSheetGrid(table));
    const engine = new FormulaEngine(config(s));
    const internal = engine.evaluate(s);
    assert.deepEqual(engine.recalculate(s, internal, "EXTERNAL").provisional, engine.evaluate(s, "EXTERNAL").provisional);
    const changed = setCellFormula(s, field.valueCellId, "1/0");
    const before = new FormulaEngine(config(s)).evaluate(s).results.filter(r => !externalCellIds(s).has(r.cellId));
    const after = new FormulaEngine(config(changed)).evaluate(changed).results.filter(r => !externalCellIds(changed).has(r.cellId));
    assert.deepEqual(after, before);
  });
}

for (const layout of ["legacy", "dynamic"] as const) {
  test(`${layout}: external income updates totals and after-tax price without double counting`, () => {
    let s = changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(layout === "legacy" ? prepareLegacySheet(emptyWorkbook("P", "A")) : prepareVendorColumns(createProcurementWorkbook("P", "A"))))), "SOLAR_BAWAH");
    s = createExternalAhs(s, config(s), new FormulaEngine(config(s)).evaluate(s)).snapshot;
    const added = addExternalAhsItem(s, config(s), "Layanan", "PENDAPATAN", null, "Pendapatan Tambahan");
    s = added.snapshot;
    const item = s.externalAhs!.groups.find(g => g.name === "Pendapatan Tambahan")!.items[0]!;
    s = setCellInput(s, item.priceCellId, { kind: "NUMERIC_TEXT", text: "150" });
    s = setCellInput(s, item.volumeCellId, { kind: "NUMERIC_TEXT", text: "10" });
    const table = s.worksheets.find(w => w.stage === "AHS_EXTERNAL")!.tables.find(t => t.cells[0]!.scope === s.activeProfile)!;
    const run = new FormulaEngine(config(s)).evaluate(s, "EXTERNAL");
    for (const [name, columnIndex, expected] of [["HARGA INCLUDE", 3, "150"], ["HARGA JUAL SETELAH PAJAK", 5, "150"], ["TOTAL PENDAPATAN", 5, "1500"]] as const) {
      const row = table.rows.find(r => r.label.endsWith(`|${name}`))!;
      const cell = table.cells.find(c => c.rowId === row.id && c.columnId === table.columnOrder[columnIndex])!;
      const result = run.provisional!.results.find(r => r.cellId === cell.id)!;
      assert("value" in result, name); assert.equal(result.value, expected, name);
    }
  });
}
