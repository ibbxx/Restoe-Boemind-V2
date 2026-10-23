import assert from "node:assert/strict";
import { test } from "node:test";
import type { CellSnapshot, WorkbookSnapshot } from "../src/domain/contracts.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { changeWorkbook, emptyWorkbook } from "../src/domain/workflow.ts";
import { connectAhsHpp, legacyConfiguration, prepareLegacySheet } from "../src/domain/legacy-sheet.ts";
import { changeSheetProfile, prepareSelectedVendorMappings, prepareVendorColumns, selectSheetOffer } from "../src/domain/dynamic-workflow.ts";
import { addVendorComponent, removeVendorComponent, vendorComponents } from "../src/domain/vendor-components.ts";
import { clearCellSource, setCellFormula, setCellInput } from "../src/domain/structure.ts";
import { isSolarCostCell, prepareSolarCosts } from "../src/domain/solar-cost.ts";
import { canvasCellAddresses } from "../src/domain/canvas-address.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import { ahsRoleCell } from "../src/domain/ahs-groups.ts";
import { ahsVolumeSource, connectAhsVolumes } from "../src/domain/ahs-volume.ts";

const actor = id<"user">();
const cells = (s: WorkbookSnapshot) => s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells));
const config = (s: WorkbookSnapshot) => s.workbook?.configuration ?? legacyConfiguration(s, null);
const costs = (s: WorkbookSnapshot) => cells(s).filter(cell => isSolarCostCell(s, cell));
function sourceOf(s: WorkbookSnapshot, target: CellSnapshot) {
  const formula = s.formulas.find(f => f.targetCellId === target.id)!;
  assert.equal(formula.referenceCellIds.length, 1);
  return cells(s).find(cell => cell.id === formula.referenceCellIds[0])!;
}
function values(s: WorkbookSnapshot) {
  return new Map(new FormulaEngine(config(s)).evaluate(s).results.map(result => [result.cellId, result]));
}
function assertEqualCosts(s: WorkbookSnapshot) {
  const results = values(s);
  for (const target of costs(s)) {
    const source = sourceOf(s, target);
    const expected = results.get(source.id)!, actual = results.get(target.id)!;
    assert("value" in expected && "value" in actual, JSON.stringify({ expected, actual }));
    assert.equal(actual.value, expected.value);
  }
}

for (const layout of ["template", "legacy"] as const) {
  function initial() {
    const s = layout === "template" ? prepareVendorColumns(createProcurementWorkbook("Project", "Analysis"))
      : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
    return changeSheetProfile(connectAhsHpp(s), "SOLAR_BAWAH");
  }

  test(`${layout}: SKP AHS tax sums conversion PPN and PPN OAT once, follows volume and persists`, () => {
    let s = connectAhsVolumes(initial());
    const ppn = ahsRoleCell(s, "SOLAR_BAWAH", "I21", "PAJAK · PPN 11%")!;
    const ppnTotal = ahsRoleCell(s, "SOLAR_BAWAH", "K21", "PAJAK · PPN 11% · Total")!;
    const costTotal = ahsRoleCell(s, "SOLAR_BAWAH", "L14", "TOTAL BIAYA")!;
    const ppnDifference = ahsRoleCell(s, "SOLAR_BAWAH", "L35", "SELISIH PPN")!;
    const salePpn = ahsRoleCell(s, "SOLAR_BAWAH", "I13", "Harga Jual · PPN 11%")!;
    const inuPpn = ahsRoleCell(s, "INU", "I21", "PAJAK · PPN 11%")!;
    const original = canonicalJson(s.formulas.filter(f => [salePpn.id, inuPpn.id].includes(f.targetCellId)));
    const offer = s.analysis.offers[0]!;
    for (const component of vendorComponents(s, offer.id)) {
      const text = component.role === "Harga Dasar" ? "10000" : component.role === "PPN" ? "2000" : component.role === "PPN OAT" ? "55" : "0";
      s = setCellInput(s, component.source.id, { kind: "NUMERIC_TEXT", text });
    }
    s = setCellInput(s, ahsVolumeSource(s, "SOLAR_BAWAH")!.id, { kind: "NUMERIC_TEXT", text: "1000" });
    s = selectSheetOffer(s, offer.id, actor);
    const value = (snapshot: WorkbookSnapshot, cellId: string) => {
      const result = new FormulaEngine(config(snapshot)).evaluate(snapshot).provisional!.results.find(r => r.cellId === cellId)!;
      assert("value" in result, JSON.stringify(result)); return result.value;
    };
    assert.equal(value(s, ppn.id), "2055");
    assert.equal(value(s, ppnTotal.id), "2055000");
    const totalBefore = value(s, costTotal.id), differenceBefore = value(s, ppnDifference.id);
    const oatTax = vendorComponents(s, offer.id).find(component => component.role === "PPN OAT")!.source;
    s = setCellInput(s, oatTax.id, { kind: "NUMERIC_TEXT", text: "70" });
    assert.equal(value(s, ppn.id), "2070");
    assert.equal(value(s, ppnTotal.id), "2070000");
    assert.equal(Number(value(s, costTotal.id)) - Number(totalBefore), 15000);
    assert.equal(Number(value(s, ppnDifference.id)) - Number(differenceBefore), -15000);
    assert.equal(prepareSolarCosts(s), s);
    assert.equal(canonicalJson(s.formulas.filter(f => [salePpn.id, inuPpn.id].includes(f.targetCellId))), original);
    assert.throws(() => setCellInput(s, ppn.id, { kind: "NUMERIC_TEXT", text: "1" }), /PPN biaya SKP mengikuti/);
    assert.throws(() => setCellFormula(s, ppn.id, "1"), /PPN biaya SKP mengikuti/);
    assert.throws(() => clearCellSource(s, ppn.id), /PPN biaya SKP mengikuti/);

    const priorFormula = s.formulas.find(f => f.targetCellId === ppn.id)!;
    s = changeWorkbook(s, { formulas: s.formulas.map(f => f.id === priorFormula.id ? { ...f, expression: "999", referenceCellIds: [] } : f) });
    s = prepareSelectedVendorMappings(prepareLegacySheet(s), actor);
    assert.equal(value(s, ppn.id), "2070");
    assert.equal(s.formulas.find(f => f.targetCellId === ppn.id)!.id, priorFormula.id);
    const vendorPpn = vendorComponents(s, offer.id).find(component => component.role === "PPN")!.source;
    s = setCellInput(s, vendorPpn.id, { kind: "NUMERIC_TEXT", text: "2000.123456789" });
    s = setCellInput(s, oatTax.id, { kind: "NUMERIC_TEXT", text: "55.000000001" });
    s = setCellInput(s, ahsVolumeSource(s, "SOLAR_BAWAH")!.id, { kind: "NUMERIC_TEXT", text: "5000000" });
    assert.equal(value(s, ppn.id), "2055.12345679");
    assert.equal(value(s, ppnTotal.id), "10275617283.95");
    s = currentSnapshot(s);
    const loaded = decodeWorkbook(encodeWorkbook(s, config(s)), { projectId: s.projectId, analysisId: s.analysisId,
      projectName: s.project.name, analysisName: s.analysis.analysis.name });
    assert.equal(canonicalJson(loaded.snapshot), canonicalJson(s));
    assert.equal(prepareSolarCosts(loaded.snapshot), loaded.snapshot);
    assert.equal(value(loaded.snapshot, ppnTotal.id), "10275617283.95");
    const second = s.analysis.offers[1]!;
    for (const component of vendorComponents(s, second.id)) s = setCellInput(s, component.source.id, { kind: "NUMERIC_TEXT", text: "10" });
    s = selectSheetOffer(s, second.id, actor);
    assert.equal(value(s, ppn.id), "20");
    assert.equal(value(s, ppnTotal.id), "100000000");
  });

  test(`${layout}: SKP AHS tax preserves zero, empty/error diagnostics and rejects circular source links`, () => {
    let s = initial();
    const offer = s.analysis.offers[0]!;
    const vendorPpn = vendorComponents(s, offer.id).find(component => component.role === "PPN")!.source;
    const vendorOatTax = vendorComponents(s, offer.id).find(component => component.role === "PPN OAT")!.source;
    const ppn = ahsRoleCell(s, "SOLAR_BAWAH", "I21", "PAJAK · PPN 11%")!;
    s = setCellInput(s, vendorPpn.id, { kind: "NUMERIC_TEXT", text: "0" });
    s = setCellInput(s, vendorOatTax.id, { kind: "NUMERIC_TEXT", text: "0" });
    s = selectSheetOffer(s, offer.id, actor);
    let result = values(s).get(ppn.id)!;
    assert("value" in result); assert.equal(result.value, "0");
    s = clearCellSource(s, vendorOatTax.id);
    result = values(s).get(ppn.id)!;
    assert(!("value" in result));
    s = setCellFormula(s, vendorOatTax.id, "1/0");
    assert.equal(values(s).get(ppn.id)!.status, "ERROR");
    const source = sourceOf(s, costs(s)[1]!);
    const mappingIds = new Set(s.mappings.filter(m => m.targetCellId === source.id).map(m => m.id));
    const formulaId = id<"formula">();
    const cyclic = changeWorkbook(s, {
      mappings: s.mappings.filter(m => !mappingIds.has(m.id)),
      formulas: [...s.formulas.filter(f => f.targetCellId !== source.id), { id: formulaId, targetCellId: source.id,
        expression: `@{${ppn.id}}`, referenceCellIds: [ppn.id], activation: "ACTIVE", sourceKind: "OPERATIONAL_OVERRIDE", provenance: null }],
      worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t, cells: t.cells.map(cell => cell.id === source.id
        ? { ...cell, source: { kind: "FORMULA" as const, formulaId } } : cell) })) })),
      profiles: { ...s.profiles, SOLAR_BAWAH: { ...s.profiles.SOLAR_BAWAH, formulaIds: [...s.profiles.SOLAR_BAWAH.formulaIds, formulaId] } },
    });
    assert.throws(() => prepareSolarCosts(cyclic), /siklus/);
  });

  test(`${layout}: Solar costs mirror every vendor component, extra rows and ALL IN through reload`, () => {
    let s = initial();
    const inuIds = new Set(cells(s).filter(cell => cell.scope === "INU").map(cell => cell.id));
    const inuCosts = canonicalJson(cells(s).filter(cell => inuIds.has(cell.id)));
    const inuFormulas = canonicalJson(s.formulas.filter(f => inuIds.has(f.targetCellId)));
    const [first, second] = s.analysis.offers;
    const amounts = ["20000.123456789", "2222.5", "333.3", "44.4", "555.5", "66.6", "77.7", "29000.987654321"];
    for (const [index, component] of vendorComponents(s, first!.id).entries()) {
      s = setCellInput(s, component.source.id, { kind: "NUMERIC_TEXT", text: amounts[index]! });
    }
    for (const component of vendorComponents(s, second!.id)) s = setCellInput(s, component.source.id, { kind: "NUMERIC_TEXT", text: "123.45" });
    s = selectSheetOffer(s, first!.id, actor);
    assert.equal(costs(s).length, 8);
    assertEqualCosts(s);
    let results = values(s);
    const hpp = results.get(s.profiles.SOLAR_BAWAH.hppBase.cellId)!;
    assert("value" in hpp); assert.equal(hpp.value, amounts[0]);
    assert.equal(prepareSolarCosts(s), s);
    assert.equal(canonicalJson(cells(s).filter(cell => inuIds.has(cell.id))), inuCosts);
    assert.equal(canonicalJson(s.formulas.filter(f => inuIds.has(f.targetCellId))), inuFormulas);

    const base = vendorComponents(s, first!.id)[0]!.source;
    s = setCellInput(s, base.id, { kind: "NUMERIC_TEXT", text: "21000" });
    assertEqualCosts(s);
    s = addVendorComponent(s, "Pengiriman tambahan").snapshot;
    const extra = vendorComponents(s, first!.id).find(component => component.labelCell?.source.kind === "INPUT" &&
      component.labelCell.source.input.kind === "TEXT" && component.labelCell.source.input.text === "Pengiriman tambahan")!;
    s = setCellInput(s, extra.source.id, { kind: "NUMERIC_TEXT", text: "17" });
    s = prepareSelectedVendorMappings(s, actor);
    assert.equal(costs(s).length, 9);
    assertEqualCosts(s);
    const totalSource = vendorComponents(s, first!.id).find(component => component.role === "TOTAL")!.source;
    const solarTotal = s.mappings.find(mapping => mapping.scope === "SOLAR_BAWAH" && mapping.sourceCellId === totalSource.id)!.targetCellId;
    const totalCost = costs(s).find(cell => sourceOf(s, cell).id === solarTotal)!;
    const totalResult = values(s).get(totalCost.id)!;
    assert("value" in totalResult); assert.equal(totalResult.value, "29017.987654321");
    const addresses = canvasCellAddresses(s);
    assert(costs(s).every(cell => addresses.has(cell.id)));
    const ids = costs(s).map(cell => cell.id);
    const formulaIds = s.formulas.filter(f => ids.includes(f.targetCellId)).map(f => f.id);
    s = selectSheetOffer(s, second!.id, actor);
    assert.deepEqual(costs(s).map(cell => cell.id), ids);
    assert.deepEqual(s.formulas.filter(f => ids.includes(f.targetCellId)).map(f => f.id), formulaIds);
    results = values(s);
    const updatedHpp = results.get(s.profiles.SOLAR_BAWAH.hppBase.cellId)!;
    assert("value" in updatedHpp); assert.equal(updatedHpp.value, "123.45");
    s = selectSheetOffer(s, first!.id, actor);
    assertEqualCosts(s);
    s = currentSnapshot(s);
    const loaded = decodeWorkbook(encodeWorkbook(s, config(s)), { projectId: s.projectId, analysisId: s.analysisId,
      projectName: s.project.name, analysisName: s.analysis.analysis.name });
    assert.equal(canonicalJson(loaded.snapshot), canonicalJson(s));
    assert.equal(prepareSolarCosts(loaded.snapshot), loaded.snapshot);
    assertEqualCosts(loaded.snapshot);
    s = removeVendorComponent(s, extra.labelCell!.id, config(s));
    s = prepareSelectedVendorMappings(prepareLegacySheet(s), actor);
    assert.equal(costs(s).length, 8);
    assertEqualCosts(s);
  });

  test(`${layout}: existing Solar overrides upgrade once; derived costs reject edits and propagate empty/error`, () => {
    let s = initial();
    const target = costs(s)[1]!, source = sourceOf(s, target);
    const before = canonicalJson(s);
    assert.throws(() => setCellInput(s, target.id, { kind: "NUMERIC_TEXT", text: "1" }), /mengikuti Harga Solar/);
    assert.throws(() => setCellFormula(s, target.id, "1"), /mengikuti Harga Solar/);
    assert.throws(() => clearCellSource(s, target.id), /mengikuti Harga Solar/);
    assert.equal(canonicalJson(s), before);
    const priorFormula = s.formulas.find(f => f.targetCellId === target.id)!;
    s = changeWorkbook(s, { formulas: s.formulas.filter(f => f.targetCellId !== target.id),
      profiles: { ...s.profiles, SOLAR_BAWAH: { ...s.profiles.SOLAR_BAWAH,
        formulaIds: s.profiles.SOLAR_BAWAH.formulaIds.filter(formulaId => formulaId !== priorFormula.id) } },
      worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t, cells: t.cells.map(cell =>
        cell.id === target.id ? { ...cell, source: { kind: "INPUT" as const, input: { kind: "NUMERIC_TEXT" as const, text: "999" } } } : cell) })) })) });
    s = prepareSolarCosts(s);
    assert.equal(prepareSolarCosts(s), s);
    assert.equal(sourceOf(s, costs(s).find(cell => cell.id === target.id)!).id, source.id);
    s = clearCellSource(s, source.id);
    let result = values(s).get(target.id)!;
    assert(!("value" in result), "Empty source must not become a numeric zero");
    s = setCellFormula(s, source.id, "1/0");
    result = values(s).get(target.id)!;
    assert.equal(result.status, "ERROR");
    assert.throws(() => setCellFormula(s, source.id, `@{${target.id}}`), /siklus/);
    const cyclic = changeWorkbook(s, { formulas: s.formulas.map(f => f.targetCellId === source.id
      ? { ...f, expression: `@{${target.id}}`, referenceCellIds: [target.id] } : f) });
    assert.throws(() => prepareSolarCosts(cyclic), /siklus/);
  });
}
