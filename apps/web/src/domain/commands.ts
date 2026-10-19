import type { CellInput, Offer, AnalysisVendor, WorkbookSnapshot } from "./contracts.ts";
import { createStableId, parseStableId } from "./ids.ts";
import type { Profile } from "./profiles.ts";
import { captureSnapshot } from "./snapshots.ts";
import { validateAhsVolumeInput } from "./ahs-volume.ts";
import { parseCellInput, parseSnapshot, requireCondition } from "./validation.ts";

function nextSnapshot(snapshot: WorkbookSnapshot, changes: Partial<WorkbookSnapshot>) {
  return captureSnapshot({ ...snapshot, ...changes, id: createStableId<"snapshot">() });
}

export function addVendor(value: unknown, vendor: AnalysisVendor) {
  const s = parseSnapshot(value);
  return nextSnapshot(s, { analysis: { ...s.analysis, vendors: [...s.analysis.vendors, vendor] } });
}

export function addOffer(value: unknown, offer: Offer) {
  const s = parseSnapshot(value);
  return nextSnapshot(s, { analysis: { ...s.analysis, offers: [...s.analysis.offers, offer] } });
}

export function updateCellInput(value: unknown, scope: Profile | "SHARED", cellId: unknown, input: CellInput) {
  const s = parseSnapshot(value);
  const id = parseStableId<"cell">(cellId);
  const cell = s.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).find(c => c.id === id);
  requireCondition(cell?.scope === scope && cell.source.kind === "INPUT", "Cell is missing, calculated, or outside the requested scope.");
  const validatedInput = parseCellInput(input);
  validateAhsVolumeInput(s, cell, validatedInput);
  return nextSnapshot(s, { worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
    cells: t.cells.map(c => c.id === id ? { ...c, source: { kind: "INPUT", input: validatedInput } } : c),
  })) })) });
}
