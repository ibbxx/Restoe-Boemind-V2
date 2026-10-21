import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { emptyWorkbook, changeWorkbook } from "../src/domain/workflow.ts";
import { prepareLegacySheet, connectAhsHpp, makeAhsSaleInput, legacyConfiguration } from "../src/domain/legacy-sheet.ts";
import { addSheetVendor, changeSheetProfile, prepareVendorColumns, removeSheetVendor } from "../src/domain/dynamic-workflow.ts";
import { addVendor, addOffer } from "../src/domain/commands.ts";
import { addAhsItem, ahsGroups, ahsRoleCell, removeAhsEntry } from "../src/domain/ahs-groups.ts";
import { addAhsField, ahsFields } from "../src/domain/ahs-fields.ts";
import { connectAhsVolumes, ahsVolumeSource } from "../src/domain/ahs-volume.ts";
import { canvasCellAddresses } from "../src/domain/canvas-address.ts";
import { cellCodes, describeCell, describeFormula, displayCellId, displayFormula, resolveFormula } from "../src/domain/cell-address.ts";
import { setCellInput, setCellFormula } from "../src/domain/structure.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";

function initial(layout: "template" | "legacy") {
  const s = layout === "template" ? prepareVendorColumns(createProcurementWorkbook("Project", "Analysis")) : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
  return connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(s)));
}
const config = (s: WorkbookSnapshot) => s.workbook?.configuration ?? legacyConfiguration(s, null);
function anotherVendor(s: WorkbookSnapshot) {
  if (s.workbook) return addSheetVendor(s, "Vendor tambahan", "C");
  const vendorId = id<"vendor">();
  return prepareLegacySheet(addOffer(addVendor(s, { id: vendorId, analysisId: s.analysisId, name: "Vendor tambahan" }), {
    id: id<"offer">(), vendorId, analysisId: s.analysisId, label: "Penawaran tambahan", values: [],
  }));
}

for (const layout of ["template", "legacy"] as const) for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
  test(`${layout}/${profile}: one short unique address per active cell, including additional and merged cells`, () => {
    let s = changeSheetProfile(initial(layout), profile);
    s = addAhsItem(s, null, "Uraian", "Kelompok");
    s = addAhsField(s, "INFORMASI", "PIC", "TEXT");
    s = addAhsField(s, "LABA", "Indikator", "IDR");
    const addresses = canvasCellAddresses(s);
    const active = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).filter(c => c.scope === "SHARED" || c.scope === profile);
    assert.equal(addresses.size, active.length);
    assert.equal(new Set(addresses.values()).size, addresses.size);
    for (const c of active) {
      assert.match(addresses.get(c.id)!, /^[A-Z]+[1-9]\d*$/);
      assert(!/[0-9a-f]{8}-[0-9a-f-]{27}/i.test(describeCell(c.id, s)), "cell descriptions must not expose generated IDs");
    }
    assert(!addresses.has(s.profiles[profile === "INU" ? "SOLAR_BAWAH" : "INU"].hppBase.cellId));
    const title = layout === "template" ? s.workbook!.cells.find(p => p.address === "B3")!.cellId
      : [...cellCodes(s)].find(([, code]) => code === "EV!B3")![0];
    assert.equal(addresses.get(title), "A1");
    assert.equal(describeCell(s.profiles[profile].hppBase.cellId, s), "AHS › HPP › Harga Dasar");
    const label = ahsFields(s, "INFORMASI")[0]!.labelCellId;
    assert.match(describeCell(label, s), /AHS › Informasi › PIC/);
    const before = canonicalJson(s);
    assert.equal(canvasCellAddresses(s), addresses, "immutable snapshots reuse their derived map");
    assert.equal(canonicalJson(s), before, "address generation is presentation-only");
  });

  test(`${layout}/${profile}: short formulas span tables and profiles retain independent coordinates`, () => {
    const s = changeSheetProfile(initial(layout), profile);
    const source = ahsRoleCell(s, profile, "I11", "Harga Jual · Harga Dasar")!.id;
    const target = ahsRoleCell(s, profile, "L36", "LABA BERSIH")!.id;
    const vendor = s.workbook?.offers[0]!.baseCellId ?? [...cellCodes(s)].find(([, code]) => code === "EV!C10")![0];
    const expression = `@{${source}}+@{${vendor}}*11%`;
    const shown = displayFormula(expression, s, target);
    assert(!shown.includes("!") && !shown.includes("@{"));
    assert.equal(resolveFormula(shown, s, target), expression);
    assert.equal(resolveFormula(shown.toLowerCase(), s, target), expression);
    assert.equal(resolveFormula(`$${canvasCellAddresses(s).get(source)!.replace(/(\d+)$/, "$$$1")}`, s, target), `@{${source}}`);
    const old = cellCodes(s).get(source)!;
    assert.equal(resolveFormula(old, s, target), `@{${source}}`);
    assert.equal(resolveFormula(old.replace(/-T(\d+)!/, "$1!"), s, target), `@{${source}}`);
    assert.equal(resolveFormula("EV!C10", s, target), `@{${vendor}}`, "identical legacy aliases must not be counted twice");
    const quoted = '"A1 AHS-SOLAR103!A1"';
    assert.equal(displayFormula(quoted, s, target), quoted);
    assert.equal(resolveFormula(quoted, s, target), quoted);
    assert(!describeFormula(expression, s).includes("@{"));
    assert.throws(() => resolveFormula("ZZ99999", s, target), /tidak ditemukan/);
    assert.throws(() => resolveFormula("SUM(A1:ZZ99999)", s, target), /batas worksheet/);
    const otherProfile = profile === "INU" ? "SOLAR_BAWAH" : "INU";
    const otherTarget = s.profiles[otherProfile].hppBase.cellId;
    const otherExpression = `@{${otherTarget}}`;
    assert.equal(resolveFormula(displayFormula(otherExpression, s, otherTarget), s, otherTarget), otherExpression);
    assert.throws(() => setCellFormula(s, target, otherExpression), /scope profil/);
  });

  test(`${layout}/${profile}: added rows and vendors move addresses without changing stored formula targets or values`, () => {
    let s = changeSheetProfile(initial(layout), profile);
    s = setCellInput(s, ahsVolumeSource(s, profile)!.id, { kind: "NUMERIC_TEXT", text: "1000" });
    s = addAhsItem(s, null, "Satu", "Tambahan");
    const groupId = ahsGroups(s).at(-1)!.id;
    s = addAhsItem(s, groupId, "Dua"); s = addAhsItem(s, groupId, "Jumlah");
    const [one, two, total] = ahsGroups(s).at(-1)!.items;
    s = setCellInput(s, one!.priceCellId, { kind: "NUMERIC_TEXT", text: "10" });
    s = setCellInput(s, two!.priceCellId, { kind: "NUMERIC_TEXT", text: "20" });
    const before = canvasCellAddresses(s), target = total!.priceCellId;
    s = setCellFormula(s, target, resolveFormula(`SUM(${before.get(one!.priceCellId)}:${before.get(two!.priceCellId)})`, s, target));
    const expression = s.formulas.find(f => f.targetCellId === target)!.expression;
    const previousAddress = displayCellId(target, s);
    s = anotherVendor(s);
    assert.notEqual(displayCellId(target, s), previousAddress);
    s = addAhsField(s, "INFORMASI", "Informasi sebelum total", "TEXT");
    assert.equal(s.formulas.find(f => f.targetCellId === target)!.expression, expression);
    assert.equal(resolveFormula(displayFormula(expression, s, target), s, target), expression);
    const run = new FormulaEngine(config(s)).evaluate(s);
    const result = run.provisional!.results.find(r => r.cellId === target)!;
    assert("value" in result); assert.equal(result.value, "30");
    s = currentSnapshot(s);
    const loaded = decodeWorkbook(encodeWorkbook(s, config(s)), {
      projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name,
    }).snapshot;
    assert.deepEqual(canvasCellAddresses(loaded), canvasCellAddresses(s));
    assert.equal(resolveFormula(displayFormula(expression, loaded, target), loaded, target), expression);
    const removed = removeAhsEntry(loaded, groupId, total!.priceCellId, config(loaded));
    assert(!canvasCellAddresses(removed).has(target));
    const vendor = removed.analysis.offers.at(-1)!;
    const afterVendorDelete = removeSheetVendor(removed, vendor.id);
    assert.equal(new Set(canvasCellAddresses(afterVendorDelete).values()).size, canvasCellAddresses(afterVendorDelete).size);
  });
}

test("one hundred legacy vendors do not overlap AHS or conversion and column names continue after Z", () => {
  let s = emptyWorkbook("Project", "Analysis");
  const vendors = Array.from({ length: 100 }, (_, index) => ({ id: id<"vendor">(), analysisId: s.analysisId, name: `Vendor ${index + 1}` }));
  s = changeWorkbook(s, { analysis: { ...s.analysis, vendors, offers: vendors.map(vendor => ({
    id: id<"offer">(), analysisId: s.analysisId, vendorId: vendor.id, label: vendor.name, values: [],
  })) } });
  s = prepareLegacySheet(s);
  const addresses = canvasCellAddresses(s);
  assert.equal(new Set(addresses.values()).size, addresses.size);
  assert([...addresses.values()].some(address => /^[A-Z]{2}/.test(address)));
  const base = [...cellCodes(s)].find(([, code]) => code === "EV!C10")![0];
  assert.equal(addresses.get(base), "B8");
  assert.match(addresses.get(s.profiles[s.activeProfile].hppBase.cellId)!, /^[A-Z]{2}\d+$/);
});
