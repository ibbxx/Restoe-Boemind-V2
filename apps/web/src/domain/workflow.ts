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
    analysis: { analysis: { id: analysisId, projectId, name: analysisName.trim() }, vendors: [], offers: [] },
    activeProfile: "INU", selectedOfferId: null, mappings: [], formulas: [], policy: { status: "UNCONFIGURED" },
    profiles: Object.fromEntries(hpp.map(p => [p.profile, { hppBase: { origin: "MANUAL", cellId: p.cellId },
      cellIds: [p.cellId], formulaIds: [] }])),
    worksheets: [
      { id: id<"worksheet">(), stage: "EVALUASI_VENDOR", label: "Evaluasi Vendor", tables: [] },
      { id: id<"worksheet">(), stage: "KONVERSI_JAGAD", label: "Konversi Jagad", tables: [] },
      { id: id<"worksheet">(), stage: "AHS", label: "AHS", tables: hpp.map(p => p.table) },
    ] });
}

// Initialize only at creation; reopening and saving must not advance the date.
export function initializeAnalysisDate(snapshot: WorkbookSnapshot, createdAt = new Date()): WorkbookSnapshot {
  const date = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(createdAt);
  const addresses = new Map(snapshot.workbook?.cells.map(c => [c.cellId, c.address]));
  let changed = false;
  const worksheets = snapshot.worksheets.map(w => w.stage !== "AHS" ? w : { ...w, tables: w.tables.map(t => ({ ...t,
    cells: t.cells.map(c => {
      const isDate = snapshot.workbook ? addresses.get(c.id) === (c.scope === "INU" ? "H4" : "H3")
        : t.rows.some(r => r.id === c.rowId && r.label === "Tgl Analisis (Rn)");
      if (!isDate || c.source.kind !== "INPUT" || (c.source.input.kind !== "UNSET" && c.source.input.text.trim())) return c;
      changed = true;
      return { ...c, source: { kind: "INPUT" as const, input: { kind: "TEXT" as const, text: date } } };
    }),
  })) });
  return changed ? changeWorkbook(snapshot, { worksheets }) : snapshot;
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
  const formula = expression ? [{ id: formulaId, targetCellId: cellId, expression,
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
