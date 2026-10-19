import type { CellInput, CellSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "./contracts.ts";
import { createStableId as id } from "./ids.ts";
import type { StableId } from "./ids.ts";
import type { Profile } from "./profiles.ts";
import { PROFILES } from "./profiles.ts";
import { captureSnapshot } from "./snapshots.ts";
import { requireCondition } from "./validation.ts";
import { parseFormula, references } from "../engine/parser.ts";
import { reconcilePresentation } from "./dynamic-workflow.ts";

export function changeWorkbook(before: WorkbookSnapshot, changes: Partial<WorkbookSnapshot>) {
  return captureSnapshot(reconcilePresentation({ ...before, ...changes, id: id<"snapshot">() }));
}

export function emptyWorkbook(projectName: string, analysisName: string, projectId = id<"project">()): WorkbookSnapshot {
  requireCondition(projectName.trim().length > 0 && analysisName.trim().length > 0, "Nama proyek dan analysis wajib diisi.");
  const analysisId = id<"analysis">();
  const hpp = PROFILES.map(profile => {
    const tableId = id<"table">(), rowId = id<"row">(), columnId = id<"column">(), cellId = id<"cell">();
    return { profile, cellId, table: { id: tableId, rows: [{ id: rowId, label: "HPP manual " + profile }],
      columns: [{ id: columnId, label: "Nilai" }], rowOrder: [rowId], columnOrder: [columnId],
      cells: [{ id: cellId, tableId, rowId, columnId, scope: profile, source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } }], merges: [] } };
  });
  return captureSnapshot({ schemaVersion: 2, id: id<"snapshot">(), projectId, project: { id: projectId, name: projectName.trim() }, analysisId,
    analysis: { analysis: { id: analysisId, projectId, name: analysisName.trim() }, vendors: [], offers: [], offerRevisions: [] },
    activeProfile: "INU", selectedOfferRevisionId: null, mappings: [], formulas: [], policy: { status: "UNCONFIGURED" }, calculationRunRefs: [],
    profiles: Object.fromEntries(hpp.map(p => [p.profile, { hppBase: { origin: "MANUAL", cellId: p.cellId, contextRunId: null },
      cellIds: [p.cellId], formulaIds: [], reviewContext: null }])),
    worksheets: [
      { id: id<"worksheet">(), stage: "EVALUASI_VENDOR", label: "Evaluasi Vendor", tables: [] },
      { id: id<"worksheet">(), stage: "KONVERSI_JAGAD", label: "Konversi Jagad", tables: [] },
      { id: id<"worksheet">(), stage: "AHS", label: "AHS", tables: hpp.map(p => p.table) },
    ] });
}

export function appendField(snapshot: WorkbookSnapshot, stage: WorksheetSnapshot["stage"], scope: Profile | "SHARED", label: string,
  input: CellInput, expression = "") {
  requireCondition(label.trim().length > 0, "Nama field wajib diisi.");
  const worksheet = snapshot.worksheets.find(w => w.stage === stage);
  requireCondition(worksheet, "Worksheet tidak ditemukan.");
  const tableId = id<"table">(), rowId = id<"row">(), columnId = id<"column">(), cellId = id<"cell">();
  const formulaId = id<"formula">();
  const cell: CellSnapshot = { id: cellId, tableId, rowId, columnId, scope, source: expression
    ? { kind: "FORMULA", formulaId } : { kind: "INPUT", input } };
  const formula = expression ? [{ id: formulaId, versionId: id<"formula-version">(), targetCellId: cellId, expression,
    referenceCellIds: [...new Set(references(parseFormula(expression), () => { throw new TypeError("Gunakan referensi cell langsung."); }))] as StableId<"cell">[],
    sourceKind: "OPERATIONAL_OVERRIDE" as const, activation: "ACTIVE" as const, provenance: null }] : [];
  return { cellId, snapshot: changeWorkbook(snapshot, {
    worksheets: snapshot.worksheets.map(w => w.id === worksheet.id ? { ...w, tables: [...w.tables, {
      id: tableId, rows: [{ id: rowId, label: label.trim() }], columns: [{ id: columnId, label: "Nilai" }],
      rowOrder: [rowId], columnOrder: [columnId], cells: [cell], merges: [] }] } : w),
    formulas: [...snapshot.formulas, ...formula],
    profiles: scope === "SHARED" ? snapshot.profiles : { ...snapshot.profiles, [scope]: { ...snapshot.profiles[scope],
      cellIds: [...snapshot.profiles[scope].cellIds, cellId], formulaIds: [...snapshot.profiles[scope].formulaIds, ...formula.map(f => f.id)] } },
  }) };
}

export function reviseFormula(snapshot: WorkbookSnapshot, formulaId: StableId<"formula">, expression: string) {
  requireCondition(snapshot.formulas.some(f => f.id === formulaId), "Formula tidak ditemukan.");
  const referenceCellIds = [...new Set(references(parseFormula(expression), () => { throw new TypeError("Gunakan referensi cell langsung."); }))] as StableId<"cell">[];
  return changeWorkbook(snapshot, { formulas: snapshot.formulas.map(f => f.id === formulaId ? { ...f, expression,
    referenceCellIds, versionId: id<"formula-version">(), sourceKind: "OPERATIONAL_OVERRIDE", activation: "ACTIVE" } : f) });
}
