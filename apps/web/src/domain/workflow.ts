import type { CellInput, CellSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "./contracts.ts";
import { createStableId as id } from "./ids.ts";
import type { StableId } from "./ids.ts";
import type { Profile } from "./profiles.ts";
import { PROFILES } from "./profiles.ts";
import { captureSnapshot } from "./snapshots.ts";
import { invalidateReviewContexts } from "./freshness.ts";
import { requireCondition } from "./validation.ts";
import { parseFormula, references } from "../engine/parser.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { FormulaEngine } from "../engine/formula-engine.ts";
import { compileGraph, relevantNodes } from "../engine/graph.ts";
import { recordReviewContext } from "./commands.ts";

export function changeWorkbook(before: WorkbookSnapshot, changes: Partial<WorkbookSnapshot>) {
  return captureSnapshot(invalidateReviewContexts(before, { ...before, ...changes, id: id<"snapshot">() }));
}

export function nextOfferRevisionNumber(offerId: StableId<"offer">, snapshots: readonly WorkbookSnapshot[]) {
  let maximum = 0;
  for (const snapshot of snapshots) for (const revision of snapshot.analysis.offerRevisions) {
    if (revision.offerId === offerId) maximum = Math.max(maximum, revision.revisionNumber);
  }
  requireCondition(Number.isSafeInteger(maximum + 1), "Nomor revisi sudah mencapai batas yang didukung.");
  return maximum + 1;
}

export function emptyWorkbook(projectName: string, analysisName: string, projectId = id<"project">()): WorkbookSnapshot {
  requireCondition(projectName.trim().length > 0 && analysisName.trim().length > 0, "Nama proyek dan analysis wajib diisi.");
  const analysisId = id<"analysis">();
  const hpp = PROFILES.map(profile => {
    const tableId = id<"table">(), rowId = id<"row">(), columnId = id<"column">(), cellId = id<"cell">();
    return { profile, cellId, table: { id: tableId, rows: [{ id: rowId, label: "HPP manual " + profile }],
      columns: [{ id: columnId, label: "Nilai" }], rowOrder: [rowId], columnOrder: [columnId],
      cells: [{ id: cellId, tableId, rowId, columnId, scope: profile, source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } }] } };
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
      rowOrder: [rowId], columnOrder: [columnId], cells: [cell] }] } : w),
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

export function reviewHppContext(snapshot: WorkbookSnapshot, run: EngineRun, configuration: EngineConfiguration) {
  const engine = new FormulaEngine(configuration), profile = snapshot.activeProfile;
  requireCondition(run.status !== "ERROR" && run.manifest.revisionId !== null && run.manifest.snapshot.activeProfile === profile &&
    run.manifest.snapshot.selectedOfferRevisionId === snapshot.selectedOfferRevisionId && engine.assessFreshness(run, snapshot).freshness === "CURRENT",
  "Simpan dan hitung preview tanpa error sebelum mencatat konteks HPP.");
  const graph = compileGraph(snapshot, configuration), relevant = relevantNodes(snapshot, graph);
  const withReference = changeWorkbook(snapshot, { calculationRunRefs: [...snapshot.calculationRunRefs.filter(r => r.id !== run.id), {
    id: run.id, snapshotId: run.snapshotId, profile, selectedOfferRevisionId: run.manifest.snapshot.selectedOfferRevisionId,
    engineVersion: run.engineVersion, policyVersionId: run.policyVersionId, status: run.status,
  }], profiles: { ...snapshot.profiles, [profile]: { ...snapshot.profiles[profile], hppBase: {
    ...snapshot.profiles[profile].hppBase, contextRunId: run.id } } } });
  return recordReviewContext(withReference, profile, { snapshotId: withReference.id, profile,
    selectedOfferRevisionId: snapshot.selectedOfferRevisionId, runId: run.id, freshness: "CURRENT", decisionStatus: "DRAFT",
    inputCellIds: [...graph.nodes.values()].filter(n => relevant.has(n.cell.id) && n.cell.source.kind === "INPUT").map(n => n.cell.id),
    mappingVersionIds: snapshot.mappings.filter(m => relevant.has(m.targetCellId)).map(m => m.versionId),
  });
}

// Explicit pinning only; appending a newer offer never changes this mapping or manual HPP.
export function pinOfferComponent(snapshot: WorkbookSnapshot, valueId: StableId<"offer-value">, targetId: StableId<"cell">,
  unit: string, actorId: StableId<"user">, reason: string) {
  const revision = snapshot.analysis.offerRevisions.find(r => r.id === snapshot.selectedOfferRevisionId);
  const value = revision?.values.find(v => v.id === valueId);
  const target = snapshot.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).find(c => c.id === targetId);
  requireCondition(value && revision && target && target.scope !== "SHARED", "Pilih komponen revisi dan target profil yang valid.");
  requireCondition(unit.trim().length > 0 && reason.trim().length > 0, "Satuan dan alasan mapping wajib diisi.");
  requireCondition(!Object.values(snapshot.profiles).some(p => p.hppBase.cellId === targetId), "HPP tetap input manual.");
  requireCondition(target.source.kind !== "FORMULA", "Target formula tidak boleh ditimpa mapping.");
  const source = appendField(snapshot, "EVALUASI_VENDOR", "SHARED", `O · ${revision.id} · ${value.label}`, value.input);
  const prior = snapshot.mappings.find(m => m.targetCellId === targetId);
  const mapping = { id: prior?.id ?? id<"mapping">(), versionId: id<"mapping-version">(), analysisId: snapshot.analysisId,
    scope: target.scope, sourceCellId: source.cellId, targetCellId: targetId, sourceComponent: `offer-value:${value.id}`,
    transformExpression: null, sourceUnit: unit, targetUnit: unit, status: "ACTIVE" as const,
    provenance: { actorId, changeEventId: id<"change-event">(), sourceRef: revision.id, reason: reason.trim() } };
  return { sourceCellId: source.cellId, snapshot: changeWorkbook(source.snapshot, {
    mappings: [...source.snapshot.mappings.filter(m => m.id !== mapping.id), mapping],
    worksheets: source.snapshot.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
      cells: t.cells.map(c => c.id === targetId ? { ...c, source: { kind: "MAPPING" as const, mappingId: mapping.id } } : c) })) })),
  }) };
}
