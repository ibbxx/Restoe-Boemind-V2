import type { ChangeEvent, WorkbookSnapshot } from "./contracts.ts";
import { canonicalJson } from "./snapshots.ts";

// One event per successful Save/Restore; full before/after holds the changed values.
export function describeChanges(before: WorkbookSnapshot | null, after: WorkbookSnapshot): ChangeEvent["changes"] {
  const changes: ChangeEvent["changes"][number][] = [];
  function add(action: ChangeEvent["changes"][number]["action"], targetIds: readonly string[]) {
    if (targetIds.length) changes.push({ action, targetIds });
  }
  function changedIds(a: readonly { readonly id: string }[], b: readonly { readonly id: string }[]) {
    const old = new Map(a.map(x => [x.id, x]));
    const next = new Map(b.map(x => [x.id, x]));
    return [...new Set([...old.keys(), ...next.keys()])].filter(id => canonicalJson(old.get(id) ?? null) !== canonicalJson(next.get(id) ?? null));
  }
  const cells = (s: WorkbookSnapshot | null) => s?.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).filter(c => c.source.kind === "INPUT") ?? [];
  add("INPUT_CHANGED", changedIds(cells(before), cells(after)));
  if (!before || before.selectedOfferRevisionId !== after.selectedOfferRevisionId) add("SELECTION_CHANGED", [after.analysisId]);
  if (!before || before.activeProfile !== after.activeProfile) add("PROFILE_CHANGED", [after.analysisId]);
  add("MAPPING_CHANGED", changedIds(before?.mappings ?? [], after.mappings));
  add("FORMULA_CHANGED", changedIds(before?.formulas ?? [], after.formulas));
  add("OFFER_CHANGED", changedIds(before ? [...before.analysis.vendors, ...before.analysis.offers, ...before.analysis.offerRevisions] : [],
    [...after.analysis.vendors, ...after.analysis.offers, ...after.analysis.offerRevisions]));
  const structure = (s: WorkbookSnapshot | null) => s?.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t, cells: [] })) })) ?? [];
  add("STRUCTURE_CHANGED", changedIds(structure(before), structure(after)));
  if (canonicalJson(before?.workbook?.tables ?? null) !== canonicalJson(after.workbook?.tables ?? null)) add("STRUCTURE_CHANGED", after.workbook?.tables.map(t => t.tableId) ?? []);
  if (!before || canonicalJson([before.project, before.analysis.analysis, before.profiles, before.policy, before.calculationRunRefs]) !==
    canonicalJson([after.project, after.analysis.analysis, after.profiles, after.policy, after.calculationRunRefs]) || canonicalJson(before?.workbook ?? null) !== canonicalJson(after.workbook ?? null)) add("CONTEXT_CHANGED", [after.analysisId]);
  return changes;
}
