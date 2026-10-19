import type { CellInput, Offer, AnalysisVendor, WorkbookSnapshot, MappingVersion } from "./contracts.ts";
import type { StableId } from "./ids.ts";
import { createStableId, parseStableId } from "./ids.ts";
import { parseProfile } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { captureSnapshot } from "./snapshots.ts";
import { validateAhsVolumeInput } from "./ahs-volume.ts";
import { parseCellInput, parseMappingVersion, parseSnapshot, requireCondition } from "./validation.ts";

function nextSnapshot(snapshot: WorkbookSnapshot, changes: Partial<WorkbookSnapshot>) {
  return captureSnapshot({ ...snapshot, ...changes, id: createStableId<"snapshot">() });
}

export function replaceMappingVersion(value: unknown, mapping: MappingVersion) {
  const s = parseSnapshot(value);
  const m = parseMappingVersion(mapping);
  const prior = s.mappings.find(existing => existing.id === m.id);
  requireCondition(!prior || prior.versionId !== m.versionId, "Mapping changes require a new version ID.");
  return nextSnapshot(s, { mappings: [...s.mappings.filter(existing => existing.id !== m.id), m] });
}

export function addVendor(value: unknown, vendor: AnalysisVendor) {
  const s = parseSnapshot(value);
  return nextSnapshot(s, { analysis: { ...s.analysis, vendors: [...s.analysis.vendors, vendor] } });
}

export function addOffer(value: unknown, offer: Offer) {
  const s = parseSnapshot(value);
  return nextSnapshot(s, { analysis: { ...s.analysis, offers: [...s.analysis.offers, offer] } });
}

export function activateProfile(value: unknown, profile: unknown) {
  const s = parseSnapshot(value);
  return nextSnapshot(s, { activeProfile: parseProfile(profile) });
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

export function reorderTable(value: unknown, tableId: unknown, order: {
  readonly rows: readonly StableId<"row">[];
  readonly columns: readonly StableId<"column">[];
}) {
  const s = parseSnapshot(value);
  const id = parseStableId<"table">(tableId);
  requireCondition(s.worksheets.some(w => w.tables.some(t => t.id === id)), "Table does not exist.");
  return nextSnapshot(s, { worksheets: s.worksheets.map(w => ({ ...w,
    tables: w.tables.map(t => t.id === id ? { ...t, rowOrder: order.rows, columnOrder: order.columns } : t),
  })) });
}
