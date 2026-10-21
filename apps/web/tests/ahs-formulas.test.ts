import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { changeWorkbook, emptyWorkbook } from "../src/domain/workflow.ts";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { connectAhsHpp, legacyConfiguration, makeAhsSaleInput, prepareLegacySheet } from "../src/domain/legacy-sheet.ts";
import { ahsVolumeSource, connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { ahsCell, ahsGroups, ahsLabel, ahsRoleCell, addAhsItem, removeAhsEntry, renameAhsEntry } from "../src/domain/ahs-groups.ts";
import { addAhsField, ahsFields, renameAhsField } from "../src/domain/ahs-fields.ts";
import { clearCellSource, setCellFormula, setCellInput } from "../src/domain/structure.ts";
import { cellCodes, displayFormula, resolveFormula } from "../src/domain/cell-address.ts";
import { changeSheetProfile } from "../src/domain/dynamic-workflow.ts";
import { addVendorComponent, vendorComponents } from "../src/domain/vendor-components.ts";
import { createAnalysisWorkbook } from "../src/domain/analysis-creation.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import { parseStableId } from "../src/domain/ids.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";

const config = (s: WorkbookSnapshot) => s.workbook?.configuration ?? legacyConfiguration(s, null);
const results = (s: WorkbookSnapshot) => new FormulaEngine(config(s)).evaluate(s).provisional!.results;

for (const layout of ["template", "legacy"] as const) for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
  function initial() {
    const base = layout === "template" ? createProcurementWorkbook("Project", "Analysis") : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
    return changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(base))), profile);
  }

  test(`${layout}/${profile}: label formulas, atomic replacements, references and reload`, () => {
    let s = addAhsItem(initial(), null, "Pengiriman", "Distribusi");
    const group = ahsGroups(s).at(-1)!, item = group.items[0]!;
    s = addAhsField(s, "INFORMASI", "PIC tambahan", "TEXT");
    const field = ahsFields(s, "INFORMASI")[0]!;
    s = setCellFormula(s, field.labelCellId, '"Penanggung jawab"');
    s = setCellFormula(s, field.valueCellId, '"Tim lapangan"');
    s = setCellFormula(s, group.labelCellId!, `@{${field.valueCellId}}`);
    s = setCellFormula(s, item.labelCellId!, `@{${field.labelCellId}}`);
    const builtin = ahsGroups(s)[0]!;
    s = setCellFormula(s, builtin.labelCellId!, '"Biaya pokok"');
    s = setCellFormula(s, builtin.items[0]!.labelCellId!, '"Dasar HPP"');
    assert.equal(ahsLabel(s, group, results(s)), "Tim lapangan");
    assert.equal(ahsLabel(s, item, results(s)), "Penanggung jawab");
    assert.equal(ahsLabel(s, builtin, results(s)), "Biaya pokok");
    assert.equal(ahsLabel(s, builtin.items[0]!, results(s)), "Dasar HPP");
    const expression = s.formulas.find(f => f.targetCellId === item.labelCellId)!.expression;
    assert.equal(resolveFormula(displayFormula(expression, s, item.labelCellId!), s, item.labelCellId!), expression);
    const original = canonicalJson(s);
    assert.throws(() => setCellFormula(s, field.labelCellId, `@{${item.labelCellId}}`), /siklus/);
    assert.throws(() => setCellInput(s, item.labelCellId!, { kind: "TEXT", text: " " }), /tidak boleh kosong/);
    assert.equal(canonicalJson(s), original);
    s = renameAhsField(s, field.valueCellId, "Koordinator");
    s = renameAhsEntry(s, group.id, item.priceCellId, "Armada");
    s = setCellInput(s, group.labelCellId!, { kind: "TEXT", text: "Angkutan" });
    assert(!s.formulas.some(f => [field.labelCellId, item.labelCellId, group.labelCellId].includes(f.targetCellId)));
    assert.equal(ahsLabel(s, ahsGroups(s).at(-1)!, results(s)), "Angkutan");
    s = setCellFormula(s, item.labelCellId!, `@{${field.labelCellId}}`);
    s = currentSnapshot(s);
    const loaded = decodeWorkbook(encodeWorkbook(s, config(s)), {
      projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name,
    });
    assert.equal(canonicalJson(loaded.snapshot), canonicalJson(s));
    assert.equal(ahsLabel(loaded.snapshot, item, results(loaded.snapshot)), "Koordinator");
    assert.equal(canonicalJson(prepareLegacySheet(loaded.snapshot)), canonicalJson(s));
    const other = changeSheetProfile(s, profile === "INU" ? "SOLAR_BAWAH" : "INU");
    assert.throws(() => setCellFormula(other, ahsGroups(other)[0]!.labelCellId!, `@{${field.labelCellId}}`), /scope profil/);
  });

  test(`${layout}/${profile}: deleting first item preserves group label identity and its formula consumers`, () => {
    let s = addAhsItem(initial(), null, "Pertama", "Kelompok tambahan");
    const group = ahsGroups(s).at(-1)!, first = group.items[0]!;
    s = addAhsItem(s, group.id, "Kedua");
    s = addAhsField(s, "INFORMASI", "Referensi kelompok", "TEXT");
    const field = ahsFields(s, "INFORMASI")[0]!;
    s = setCellFormula(s, group.labelCellId!, '"Kelompok formula"');
    const writer = ahsCell(s, group.labelCellId)!.source;
    s = setCellFormula(s, field.valueCellId, `@{${group.labelCellId}}`);
    s = removeAhsEntry(s, group.id, first.priceCellId, config(s));
    const retained = ahsGroups(s).find(g => g.id === group.id)!;
    assert.equal(retained.labelCellId, group.labelCellId);
    assert.deepEqual(ahsCell(s, retained.labelCellId)!.source, writer);
    assert.equal(ahsLabel(s, retained, results(s)), "Kelompok formula");
    assert.equal(ahsCell(s, retained.labelCellId)!.rowId, ahsCell(s, retained.items[0]!.priceCellId)!.rowId);
    assert.throws(() => removeAhsEntry(s, group.id, null, config(s)), /rumus lain/);
    s = setCellInput(s, field.valueCellId, { kind: "TEXT", text: "Selesai" });
    s = removeAhsEntry(s, group.id, null, config(s));
    assert(!ahsCell(s, group.labelCellId));
    assert(!s.formulas.some(f => f.targetCellId === group.labelCellId));
  });

  test(`${layout}/${profile}: range calculations, empty totals, errors and protected sources`, () => {
    let s = initial();
    const volume = ahsVolumeSource(s, profile)!.id;
    s = setCellInput(s, volume, { kind: "NUMERIC_TEXT", text: "1000" });
    s = addAhsItem(s, null, "Satu", "Rentang");
    const group = ahsGroups(s).at(-1)!;
    s = addAhsItem(s, group.id, "Dua");
    s = addAhsItem(s, group.id, "Tiga");
    const [one, two, three] = ahsGroups(s).at(-1)!.items;
    s = setCellInput(s, one!.priceCellId, { kind: "NUMERIC_TEXT", text: "10" });
    s = setCellInput(s, two!.priceCellId, { kind: "NUMERIC_TEXT", text: "20" });
    const codes = cellCodes(s);
    s = setCellFormula(s, three!.priceCellId, resolveFormula(`SUM(${codes.get(one!.priceCellId)}:${codes.get(two!.priceCellId)})*10%`, s, three!.priceCellId));
    const amount = results(s).find(r => r.cellId === three!.totalCellId)!;
    assert("value" in amount); assert.equal(amount.value, "3000");
    assert.throws(() => setCellFormula(s, volume, `@{${one!.volumeCellId}}`), /siklus/);
    assert.throws(() => setCellInput(s, one!.volumeCellId, { kind: "NUMERIC_TEXT", text: "1" }), /mengikuti/);
    assert.throws(() => clearCellSource(s, s.profiles[profile].hppBase.cellId), /HPP/);
    assert.throws(() => setCellFormula(s, s.profiles[profile].hppBase.cellId, "1"), /HPP/);
    assert.throws(() => setCellFormula(s, three!.priceCellId, "IF(1,2,3)"), /Invalid token/);
    assert.throws(() => resolveFormula("Z99999", s, three!.priceCellId), /tidak ditemukan/);
    const include = ahsRoleCell(s, profile, "J8", "Harga Include")!;
    const sale = ahsRoleCell(s, profile, "I11", "Harga Jual · Harga Dasar")!;
    s = setCellInput(s, include.id, { kind: "NUMERIC_TEXT", text: "1110" });
    assert.equal(makeAhsSaleInput(s), s, "preparation must preserve a manually overridden total");
    s = setCellFormula(s, sale.id, `@{${include.id}}/1.11`);
    assert.equal(makeAhsSaleInput(s), s, "a user formula matching the old template must not be converted to an input");
    s = setCellFormula(s, group.labelCellId!, "1/0");
    assert.match(ahsLabel(s, group, results(s)), /ERROR/);
    const total = ahsRoleCell(s, profile, "L14", "TOTAL BIAYA")!;
    s = clearCellSource(s, total.id);
    assert.deepEqual(ahsCell(prepareLegacySheet(s), total.id)!.source, { kind: "INPUT", input: { kind: "UNSET" } });
    assert.throws(() => addAhsItem(s, group.id, "Empat"), /Perbaiki rumus total/);
  });

  test(`${layout}/${profile}: added vendor description joins ALL IN formula`, () => {
    const base = layout === "template" ? createAnalysisWorkbook({ projectName: "Project", analysisName: "Analysis", material: "Material", customer: "Customer", location: "Location" }) : initial();
    const offer = base.analysis.offers[0]!;
    const added = addVendorComponent(base, "Biaya tambahan").snapshot;
    const total = vendorComponents(added, offer.id).find(component => component.role === "TOTAL")?.source;
    const extra = vendorComponents(added, offer.id).find(component => component.labelCell?.source.kind === "INPUT" &&
      component.labelCell.source.input.kind === "TEXT" && component.labelCell.source.input.text === "Biaya tambahan")?.source;
    assert(total && extra);
    const formula = added.formulas.find(item => item.targetCellId === total.id);
    assert(formula);
    assert(formula.referenceCellIds.includes(extra.id));
    assert.match(formula.expression, new RegExp(extra.id));
  });
}

test("legacy upgrade supplies missing label cells without changing existing IDs, formulas or addresses", () => {
  let s = prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
  s = addAhsItem(connectAhsVolumes(s), ahsGroups(s)[0]!.id, "Tambahan lama");
  const worksheets = s.worksheets.map(w => ({ ...w, tables: w.tables.filter(t => !t.rows.some(row => /^@AHS-.*\|template:text$/.test(row.label))) }));
  const cells = worksheets.flatMap(w => w.tables.flatMap(t => t.cells));
  const legacy = changeWorkbook(s, { worksheets,
    profiles: { INU: { ...s.profiles.INU, cellIds: cells.filter(c => c.scope === "INU").map(c => c.id) },
      SOLAR_BAWAH: { ...s.profiles.SOLAR_BAWAH, cellIds: cells.filter(c => c.scope === "SOLAR_BAWAH").map(c => c.id) } },
    ahsGroups: s.ahsGroups!.map(g => ({ ...g, ...(g.builtin ? { id: parseStableId<"ahs-group">(g.items[0]!.priceCellId), labelCellId: null } : {}),
      items: g.items.map(item => item.builtin ? { ...item, labelCellId: null } : item) })),
  });
  const before = cellCodes(legacy), formulas = canonicalJson(legacy.formulas), groupIds = legacy.ahsGroups!.map(g => g.id);
  const prepared = prepareLegacySheet(legacy), after = cellCodes(prepared);
  for (const [id, code] of before) assert.equal(after.get(id), code);
  assert.equal(canonicalJson(prepared.formulas), formulas);
  assert.deepEqual(prepared.ahsGroups!.map(g => g.id), groupIds);
  assert(prepared.ahsGroups!.every(g => g.labelCellId && g.items.every(item => item.labelCellId)));
  assert.equal(prepareLegacySheet(prepared), prepared);
});
