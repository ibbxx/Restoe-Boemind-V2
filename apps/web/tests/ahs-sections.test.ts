import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { emptyWorkbook } from "../src/domain/workflow.ts";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { connectAhsHpp, legacyConfiguration, makeAhsSaleInput, prepareLegacySheet } from "../src/domain/legacy-sheet.ts";
import { ahsVolumeSource, connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { ahsCell, ahsGroups, ahsRoleCell, ahsSectionOfCell, addAhsItem, prepareAhsRollups, removeAhsEntry, renameAhsEntry } from "../src/domain/ahs-groups.ts";
import { addAhsField, ahsFields, removeAhsField, renameAhsField } from "../src/domain/ahs-fields.ts";
import { clearCellSource, setCellFormula } from "../src/domain/structure.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import { changeSheetProfile } from "../src/domain/dynamic-workflow.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";

const config = (s: WorkbookSnapshot) => s.workbook?.configuration ?? legacyConfiguration(s, null);
const calculate = (s: WorkbookSnapshot) => new FormulaEngine(config(s)).evaluate(s);
function value(s: WorkbookSnapshot, cellId: string) {
  const result = calculate(s).provisional!.results.find(r => r.cellId === cellId)!;
  assert(result && "value" in result, JSON.stringify(result)); return Number(result.value);
}
function numeric(s: WorkbookSnapshot, cellId: string, text: string) {
  if (ahsCell(s, cellId)!.source.kind === "FORMULA") s = clearCellSource(s, cellId);
  return updateCellInput(s, s.activeProfile, cellId, { kind: "NUMERIC_TEXT", text });
}
function initial(layout: "template" | "legacy") {
  let s = layout === "template" ? createProcurementWorkbook("Project", "Analysis") : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
  s = changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(s))), "SOLAR_BAWAH");
  s = numeric(s, ahsVolumeSource(s, s.activeProfile)!.id, "1000");
  return numeric(s, ahsRoleCell(s, s.activeProfile, "I11", "Harga Jual · Harga Dasar")!.id, "1000");
}
const role = (s: WorkbookSnapshot, address: string, label: string) => ahsRoleCell(s, s.activeProfile, address, label)!.id;

for (const layout of ["template", "legacy"] as const) {
  test(`${layout}: income groups update prices and revenue once, preserve costs and remove cleanly`, () => {
    let s = initial(layout);
    const baseline = s, income = ahsGroups(s, s.activeProfile, "PENDAPATAN")[0]!;
    const targets = [["J8", "Harga Include", 200], ["L10", "HARGA JUAL SETELAH PAJAK", 200], ["L9", "TOTAL PENDAPATAN", 200000],
      ["L36", "LABA BERSIH", 200000]] as const;
    s = addAhsItem(s, ahsGroups(s)[0]!.id, "Biaya tambahan");
    const costs = canonicalJson(s.ahsGroups);
    s = addAhsItem(s, income.id, "Jasa", "", "PENDAPATAN");
    let group = ahsGroups(s, s.activeProfile, "PENDAPATAN")[0]!;
    const item = group.items.at(-1)!;
    s = numeric(s, item.priceCellId, "200");
    for (const [address, label, delta] of targets) assert.equal(value(s, role(s, address, label)) - value(baseline, role(baseline, address, label)), delta);
    assert.equal(canonicalJson(s.ahsGroups!.filter(g => (g.section ?? "BIAYA") === "BIAYA")), costs);
    assert.equal(ahsSectionOfCell(s, ahsCell(s, item.priceCellId)!), "PENDAPATAN");
    s = addAhsItem(s, null, "Layanan", "Pendapatan lain", "PENDAPATAN");
    group = ahsGroups(s, s.activeProfile, "PENDAPATAN").at(-1)!;
    s = numeric(s, group.items[0]!.priceCellId, "50");
    assert.equal(value(s, role(s, "L9", "TOTAL PENDAPATAN")) - value(baseline, role(baseline, "L9", "TOTAL PENDAPATAN")), 250000);
    s = renameAhsEntry(s, group.id, null, "Layanan tambahan", "PENDAPATAN");
    s = removeAhsEntry(s, group.id, null, config(s), "PENDAPATAN");
    s = removeAhsEntry(s, income.id, item.priceCellId, config(s), "PENDAPATAN");
    for (const [address, label] of targets) assert.equal(value(s, role(s, address, label)), value(baseline, role(baseline, address, label)));
  });

  test(`${layout}: additional cost updates both totals, old cost-only payload upgrades once`, () => {
    let s = initial(layout);
    assert.equal(prepareAhsRollups(s), s);
    const perLitre = role(s, "L15", "BIAYA PER LITER"), total = role(s, "L14", "TOTAL BIAYA");
    const original = s.formulas.find(f => f.targetCellId === perLitre)!.expression;
    const baseline = s;
    s = addAhsItem(s, null, "Tambahan", "Baru");
    const group = ahsGroups(s).at(-1)!, item = group.items[0]!;
    s = numeric(s, item.priceCellId, "50");
    assert.equal(value(s, perLitre) - value(baseline, perLitre), 50);
    assert.equal(value(s, total) - value(baseline, total), 50000);
    const old = setCellFormula(s, perLitre, original);
    const upgraded = prepareAhsRollups(old);
    assert.equal(value(upgraded, perLitre), value(s, perLitre));
    assert.equal(prepareAhsRollups(upgraded), upgraded);
    const circular = setCellFormula(old, item.priceCellId, `@{${perLitre}}*0.1`);
    assert.throws(() => prepareAhsRollups(circular), /siklus/);
    const custom = setCellFormula(old, perLitre, "123");
    assert.equal(prepareAhsRollups(custom), custom);
    const removed = removeAhsEntry(upgraded, group.id, null, config(upgraded));
    assert.equal(value(removed, perLitre), value(baseline, perLitre));
    const derived = setCellFormula(s, perLitre, `@{${total}}/@{${ahsVolumeSource(s, s.activeProfile)!.id}}`);
    let extra = addAhsItem(derived, group.id, "Lainnya");
    const extraItem = ahsGroups(extra).at(-1)!.items.at(-1)!;
    extra = numeric(extra, extraItem.priceCellId, "70");
    assert.equal(value(extra, perLitre) - value(derived, perLitre), 70);
  });

  test(`${layout}: information and profit fields preserve core profit, validate names and units`, () => {
    let s = initial(layout);
    const baseline = s, profit = role(s, "L36", "LABA BERSIH"), volume = ahsVolumeSource(s, s.activeProfile)!.id;
    s = addAhsField(s, "INFORMASI", "Nomor penawaran", "TEXT");
    const info = ahsFields(s, "INFORMASI")[0]!;
    s = updateCellInput(s, s.activeProfile, info.valueCellId, { kind: "TEXT", text: "ABC-01" });
    s = addAhsField(s, "INFORMASI", "Jumlah hari", "NUMBER");
    s = addAhsField(s, "LABA", "Pembagian", "IDR");
    const share = ahsFields(s, "LABA").at(-1)!;
    s = setCellFormula(s, share.valueCellId, `@{${profit}}*0.1`);
    assert.equal(value(s, share.valueCellId), value(baseline, profit) * 0.1);
    for (const type of ["PERCENT", "IDR/L", "NUMBER"] as const) {
      s = addAhsField(s, "LABA", type, type);
      const field = ahsFields(s, "LABA").at(-1)!;
      s = setCellFormula(s, field.valueCellId, type === "PERCENT" ? "0.1" : type === "IDR/L" ? `@{${profit}}/@{${volume}}` : "42");
      assert.equal(value(s, field.valueCellId), type === "PERCENT" ? 0.1 : type === "IDR/L" ? value(baseline, profit) / 1000 : 42);
    }
    assert.equal(value(s, profit), value(baseline, profit));
    assert.throws(() => addAhsField(s, "INFORMASI", " sumber ", "TEXT"), /sudah digunakan/);
    assert.throws(() => addAhsField(s, "LABA", "LABA BERSIH", "IDR"), /sudah digunakan/);
    assert.throws(() => addAhsField(s, "LABA", "pembagian", "IDR"), /sudah digunakan/);
    assert.throws(() => addAhsField(s, "INFORMASI", "Salah tipe", "IDR"), /Jenis nilai/);
    assert.throws(() => numeric(s, share.valueCellId, "abc"), /angka atau rumus/);
    s = renameAhsField(s, info.valueCellId, "Referensi penawaran");
    const ref = ahsFields(s, "INFORMASI").find(f => f.valueCellId === info.valueCellId)!;
    assert.equal(ref.name, "Referensi penawaran");
    s = setCellFormula(s, share.valueCellId, `@{${profit}}*0.1`);
    const numberField = ahsFields(s, "INFORMASI").find(f => f.valueType === "NUMBER")!;
    const referenced = setCellFormula(s, numberField.valueCellId, `@{${share.valueCellId}}/@{${profit}}`);
    assert.throws(() => removeAhsField(referenced, share.valueCellId, config(referenced)), /masih digunakan/);
    assert.throws(() => setCellFormula(referenced, share.valueCellId, `@{${numberField.valueCellId}}*@{${profit}}`), /siklus/);
    s = removeAhsField(s, info.valueCellId, config(s));
    assert(!ahsCell(s, info.valueCellId));
  });

  test(`${layout}: all sections survive storage and repeated preparation with independent profiles`, () => {
    let s = initial(layout);
    s = addAhsItem(s, null, "Biaya", "Kelompok biaya");
    s = addAhsItem(s, null, "Pendapatan", "Kelompok pendapatan", "PENDAPATAN");
    s = addAhsField(s, "INFORMASI", "PIC", "TEXT");
    s = addAhsField(s, "LABA", "Margin tambahan", "PERCENT");
    const fields = canonicalJson(s.ahsFields), groups = canonicalJson(s.ahsGroups);
    const selected = changeSheetProfile(s, "INU");
    s = addAhsField(selected, "INFORMASI", "PIC", "TEXT");
    s = addAhsItem(s, null, "Pendapatan", "Kelompok pendapatan", "PENDAPATAN");
    assert.equal(canonicalJson(s.ahsFields!.filter(f => f.profile === "SOLAR_BAWAH")), fields);
    assert.equal(canonicalJson(s.ahsGroups!.filter(g => g.profile === "SOLAR_BAWAH")), groups);
    const stored = currentSnapshot(s), configuration = config(stored);
    const loaded = decodeWorkbook(encodeWorkbook(stored, configuration), { projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name }).snapshot;
    assert.equal(canonicalJson(loaded), canonicalJson(stored));
    const prepare = (s: WorkbookSnapshot) => prepareAhsRollups(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(s)))));
    assert.equal(canonicalJson(prepare(prepare(loaded))), canonicalJson(prepare(loaded)));
    const engine = new FormulaEngine(config(loaded)), previous = engine.evaluate(loaded);
    const field = ahsFields(loaded, "INFORMASI")[0]!;
    const next = updateCellInput(loaded, "INU", field.valueCellId, { kind: "TEXT", text: "Ibnu" });
    assert.deepEqual(new FormulaEngine(config(next)).recalculate(next, previous).results, new FormulaEngine(config(next)).evaluate(next).results);
  });
}
