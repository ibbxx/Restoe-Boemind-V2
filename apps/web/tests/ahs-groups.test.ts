import { test } from "node:test";
import assert from "node:assert/strict";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { prepareLegacySheet, legacyConfiguration } from "../src/domain/legacy-sheet.ts";
import { emptyWorkbook, changeWorkbook } from "../src/domain/workflow.ts";
import { addAhsItem, ahsGroups, ahsCell, ahsLabel, ahsRoleCell, renameAhsEntry, removeAhsEntry } from "../src/domain/ahs-groups.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import { ahsVolumeSource, connectAhsVolumes, isAhsVolumeFollower } from "../src/domain/ahs-volume.ts";
import { clearCellSource, setCellFormula } from "../src/domain/structure.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { canonicalJson, captureSnapshot } from "../src/domain/snapshots.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import type { EngineRun } from "../src/engine/contracts.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { changeSheetProfile } from "../src/domain/dynamic-workflow.ts";

const config = (s: WorkbookSnapshot) => s.workbook?.configuration ?? legacyConfiguration(s, null);
const inuCells = (s: WorkbookSnapshot) => s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.filter(c => c.scope === "INU")));
function number(s: WorkbookSnapshot, cellId: string, text: string) {
  const cell = ahsCell(s, cellId)!;
  return updateCellInput(s, cell.scope, cellId, { kind: "NUMERIC_TEXT", text });
}
function result(run: EngineRun, cellId: string) {
  const value = run.provisional!.results.find(r => r.cellId === cellId)!;
  assert(value && "value" in value, JSON.stringify(value)); return Number(value.value);
}
function initial(layout: "template" | "legacy") {
  let s = layout === "template" ? createProcurementWorkbook("Project", "Analysis") : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
  s = changeWorkbook(s, { activeProfile: "SOLAR_BAWAH" });
  s = connectAhsVolumes(s);
  s = number(s, ahsVolumeSource(s, s.activeProfile)!.id, "1000");
  return s;
}

for (const layout of ["template", "legacy"] as const) {
  test(`${layout}: groups, totals, incremental calculation and deletion`, () => {
    let s = initial(layout);
    const before = canonicalJson(s), otherProfile = canonicalJson(inuCells(s));
    const group = ahsGroups(s).find(g => g.name === "OPERASIONAL")!;
    const total = ahsRoleCell(s, s.activeProfile, "L14", "TOTAL BIAYA")!;
    const gross = ahsRoleCell(s, s.activeProfile, "L34", "LABA KOTOR")!;
    const engine = new FormulaEngine(config(s));
    const baseline = engine.evaluate(s);
    const frozen = s;
    s = addAhsItem(s, group.id, "Transportasi");
    const transport = ahsGroups(s).find(g => g.id === group.id)!.items.at(-1)!;
    assert(isAhsVolumeFollower(s, ahsCell(s, transport.volumeCellId)!));
    assert.throws(() => setCellFormula(s, transport.volumeCellId, "2"), /mengikuti/);
    s = number(s, transport.priceCellId, "100");
    s = addAhsItem(s, group.id, "Konsumsi");
    const food = ahsGroups(s).find(g => g.id === group.id)!.items.at(-1)!;
    s = setCellFormula(s, food.priceCellId, `@{${transport.priceCellId}}/2`);
    const updatedEngine = new FormulaEngine(config(s));
    const full = updatedEngine.evaluate(s), incremental = updatedEngine.recalculate(s, baseline);
    assert.deepEqual(incremental.results, full.results);
    assert.deepEqual(incremental.provisional!.results, full.provisional!.results);
    assert.equal(result(full, total.id) - result(baseline, total.id), 150000);
    assert.equal(result(baseline, gross.id) - result(full, gross.id), 150000);
    assert.equal(canonicalJson(frozen), before);
    assert.equal(canonicalJson(inuCells(s)), otherProfile);
    if (s.workbook) {
      const table = s.worksheets.flatMap(w => w.tables).find(t => t.cells.some(c => c.id === transport.priceCellId))!;
      const groupLabel = ahsGroups(s).find(g => g.id === group.id)!.labelCellId!;
      assert.equal(table.merges.find(m => m.anchorCellId === groupLabel)!.rowSpan, group.items.length + 2);
      assert.equal(new Set(s.workbook.cells.map(c => c.cellId)).size, s.workbook.cells.length);
    }
    assert.throws(() => removeAhsEntry(s, group.id, transport.priceCellId, config(s)), /rumus lain/);
    s = removeAhsEntry(s, group.id, food.priceCellId, config(s));
    s = removeAhsEntry(s, group.id, transport.priceCellId, config(s));
    assert.equal(result(new FormulaEngine(config(s)).evaluate(s), total.id), result(baseline, total.id));
    assert.equal(ahsGroups(s).find(g => g.id === group.id)!.items.length, group.items.length);
  });

  test(`${layout}: custom group rename, round trip, first-item deletion and group removal`, () => {
    let s = addAhsItem(initial(layout), null, "Tol", "Distribusi");
    let group = ahsGroups(s).at(-1)!;
    const first = group.items[0]!;
    s = addAhsItem(s, group.id, "Parkir");
    assert.throws(() => renameAhsEntry(s, group.id, null, "HPP"), /sudah digunakan/);
    assert.throws(() => renameAhsEntry(s, group.id, first.priceCellId, "Parkir"), /sudah digunakan/);
    s = renameAhsEntry(s, group.id, null, "Logistik");
    s = renameAhsEntry(s, group.id, first.priceCellId, "Jalan tol");
    group = ahsGroups(s).at(-1)!;
    assert.equal(ahsLabel(s, group), "Logistik");
    assert.equal(ahsLabel(s, group.items[0]!), "Jalan tol");
    assert.equal(group.items[0]!.priceCellId, first.priceCellId);
    s = currentSnapshot(s);
    const encoded = encodeWorkbook(s, config(s));
    const loaded = decodeWorkbook(encoded, { projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name });
    assert.equal(canonicalJson(loaded.snapshot), canonicalJson(s));
    assert.equal(canonicalJson(encodeWorkbook(loaded.snapshot, loaded.configuration)), canonicalJson(encoded));
    const removedTogether = removeAhsEntry(loaded.snapshot, group.id, null, config(loaded.snapshot));
    assert(!ahsGroups(removedTogether).some(g => g.id === group.id));
    assert(group.items.every(item => !ahsCell(removedTogether, item.priceCellId)));
    s = removeAhsEntry(loaded.snapshot, group.id, first.priceCellId, config(loaded.snapshot));
    group = ahsGroups(s).at(-1)!;
    assert.equal(group.items.length, 1);
    assert.equal(ahsLabel(s, group), "Logistik");
    assert.equal(ahsLabel(s, group.items[0]!), "Parkir");
    s = removeAhsEntry(s, group.id, null, config(s));
    assert(!ahsGroups(s).some(g => g.id === group.id));
    assert(!ahsCell(s, first.priceCellId));
  });

  test(`${layout}: names, core cells, aggregate references and metadata are guarded`, () => {
    const s = initial(layout), group = ahsGroups(s)[0]!;
    assert.throws(() => addAhsItem(s, group.id, " "), /wajib/);
    assert.throws(() => addAhsItem(s, null, "X", " hpp "), /sudah digunakan/);
    assert.throws(() => addAhsItem(s, group.id, " harga dasar "), /sudah digunakan/);
    const renamedGroup = renameAhsEntry(s, group.id, null, "X");
    assert.equal(ahsLabel(renamedGroup, ahsGroups(renamedGroup)[0]!), "X");
    const renamedItem = renameAhsEntry(s, group.id, group.items[0]!.priceCellId, "X");
    assert.equal(ahsLabel(renamedItem, ahsGroups(renamedItem)[0]!.items[0]!), "X");
    assert.throws(() => removeAhsEntry(s, group.id, group.items[0]!.priceCellId, config(s)), /bawaan/);
    assert.throws(() => removeAhsEntry(s, group.id, null, config(s)), /bawaan/);
    const added = addAhsItem(s, null, "X", "Tambahan"), custom = ahsGroups(added).at(-1)!;
    const aggregated = { ...config(added), aggregates: [{ id: id<"aggregate">(), versionId: id<"aggregate-version">(), memberCellIds: [custom.items[0]!.priceCellId] }] };
    assert.throws(() => removeAhsEntry(added, custom.id, null, aggregated), /agregat/);
    assert.throws(() => captureSnapshot({ ...added, ahsGroups: added.ahsGroups!.map(g => g.id === custom.id ? { ...g, items: [{ ...g.items[0], volumeCellId: id<"cell">() }] } : g) }), /Referensi/);
    assert.throws(() => addAhsItem(added, null, "Y", " tambahan "), /sudah digunakan/);
    assert.throws(() => addAhsItem(added, custom.id, " x "), /sudah digunakan/);
    assert.throws(() => updateCellInput(added, added.activeProfile, custom.items[0]!.labelCellId!, { kind: "TEXT", text: " " }), /tidak boleh kosong/);
    assert.throws(() => updateCellInput(added, added.activeProfile, custom.items[0]!.priceCellId, { kind: "TEXT", text: "abc" }), /angka atau rumus/);
    const total = ahsRoleCell(s, s.activeProfile, "L14", "TOTAL BIAYA")!;
    const invalid = clearCellSource(s, total.id);
    assert.throws(() => addAhsItem(invalid, group.id, "X"), /Perbaiki rumus/);
  });

  test(`${layout}: both profiles retain independent groups and persisted inputs`, () => {
    let s = addAhsItem(initial(layout), null, "Uraian SKP", "Kelompok SKP");
    const skp = ahsGroups(s).at(-1)!;
    s = number(s, skp.items[0]!.priceCellId, "75");
    s = changeSheetProfile(s, "INU");
    s = addAhsItem(s, null, "Uraian INU", "Kelompok INU");
    const inu = ahsGroups(s).at(-1)!;
    s = number(s, inu.items[0]!.priceCellId, "125");
    const snapshot = currentSnapshot(s);
    const loaded = decodeWorkbook(encodeWorkbook(snapshot, config(snapshot)), {
      projectId: s.projectId, analysisId: s.analysisId, projectName: s.project.name, analysisName: s.analysis.analysis.name,
    }).snapshot;
    assert(ahsGroups(loaded, "INU").some(g => g.id === inu.id));
    assert(!ahsGroups(loaded, "INU").some(g => g.id === skp.id));
    assert(ahsGroups(loaded, "SOLAR_BAWAH").some(g => g.id === skp.id));
    assert.deepEqual(ahsCell(loaded, skp.items[0]!.priceCellId)!.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "75" } });
    assert.deepEqual(ahsCell(loaded, inu.items[0]!.priceCellId)!.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "125" } });
    assert.throws(() => addAhsItem(loaded, skp.id, "Lintas profil"), /profil aktif/);
    assert.throws(() => renameAhsEntry(loaded, skp.id, null, "Lintas profil"), /wajib/);
  });
}
