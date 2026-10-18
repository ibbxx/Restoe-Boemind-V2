import type { CellSnapshot, FormulaDefinition, ProfileSnapshot, TableMerge, TableSnapshot, WorkbookSnapshot } from "./contracts.ts";
import type { StableId } from "./ids.ts";
import { createStableId as id, parseStableId } from "./ids.ts";
import type { Profile } from "./profiles.ts";
import { PROFILES, parseProfile } from "./profiles.ts";
import { requireCondition, parseSnapshot } from "./validation.ts";
import { changeWorkbook } from "./workflow.ts";
import { parseFormula, references } from "../engine/parser.ts";

// Structural commands stay pure domain transitions: every call returns a new,
// validated snapshot via `changeWorkbook`, never a mutated one.
type Scope = Profile | "SHARED";

function findTable(s: WorkbookSnapshot, tableId: StableId<"table">) {
  return s.worksheets.flatMap(w => w.tables).find(t => t.id === tableId);
}

function findCell(s: WorkbookSnapshot, cellId: StableId<"cell">) {
  return s.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).find(c => c.id === cellId);
}

function insertAfterId<T>(items: readonly T[], idOf: (item: T) => string, afterId: string | null, item: T): T[] {
  const list = [...items];
  if (afterId === null) return [...list, item];
  const index = list.findIndex(existing => idOf(existing) === afterId);
  requireCondition(index >= 0, "Anchor tidak ditemukan pada tabel ini.");
  list.splice(index + 1, 0, item);
  return list;
}

function replaceTable(s: WorkbookSnapshot, tableId: StableId<"table">, table: TableSnapshot): WorkbookSnapshot["worksheets"] {
  return s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => t.id === tableId ? table : t) }));
}

// Keep profile cell/formula indexes exactly in sync with the structure, as required by validation.
function withIndexes(s: WorkbookSnapshot, changes: Partial<WorkbookSnapshot>): WorkbookSnapshot {
  const merged = { ...s, ...changes };
  const cells = merged.worksheets.flatMap(w => w.tables).flatMap(t => t.cells);
  const byCell = new Map(cells.map(c => [c.id, c] as const));
  const profiles = Object.fromEntries(PROFILES.map(profile => [profile, {
    ...s.profiles[profile],
    cellIds: cells.filter(c => c.scope === profile).map(c => c.id),
    formulaIds: merged.formulas.filter(f => byCell.get(f.targetCellId)?.scope === profile).map(f => f.id),
  }])) as unknown as Readonly<Record<Profile, ProfileSnapshot>>;
  return changeWorkbook(s, { ...changes, profiles });
}

function mergePositions(table: TableSnapshot, merge: TableMerge): string[] {
  const anchor = table.cells.find(c => c.id === merge.anchorCellId);
  if (!anchor) return [];
  const atRow = table.rowOrder.indexOf(anchor.rowId), atColumn = table.columnOrder.indexOf(anchor.columnId);
  if (atRow < 0 || atColumn < 0) return [];
  const positions: string[] = [];
  for (let row = atRow; row < atRow + merge.rowSpan; row++) {
    for (let column = atColumn; column < atColumn + merge.colSpan; column++) {
      positions.push(table.rowOrder[row] + ":" + table.columnOrder[column]);
    }
  }
  return positions;
}

function mergeCoveredCellIds(table: TableSnapshot, merge: TableMerge): string[] {
  const anchor = table.cells.find(c => c.id === merge.anchorCellId);
  if (!anchor) return [];
  const atRow = table.rowOrder.indexOf(anchor.rowId), atColumn = table.columnOrder.indexOf(anchor.columnId);
  if (atRow < 0 || atColumn < 0) return [];
  const ids: string[] = [];
  for (let row = atRow; row < atRow + merge.rowSpan; row++) {
    for (let column = atColumn; column < atColumn + merge.colSpan; column++) {
      const cell = table.cells.find(c => c.rowId === table.rowOrder[row] && c.columnId === table.columnOrder[column]);
      if (cell) ids.push(cell.id);
    }
  }
  return ids;
}

function cellInUse(s: WorkbookSnapshot, cellId: StableId<"cell">): boolean {
  if (s.workbook?.bindings.some(b => b.cellId === cellId) || s.workbook?.offers.some(o => o.baseCellId === cellId || o.nameCellId === cellId)) return true;
  if (s.workbook?.configuration?.aggregates.some(a => a.memberCellIds.includes(cellId)) || s.workbook?.configuration?.selectionDependentCellIds.includes(cellId)) return true;
  if (s.formulas.some(f => f.referenceCellIds.includes(cellId))) return true;
  if (s.mappings.some(m => m.sourceCellId === cellId || m.targetCellId === cellId)) return true;
  return PROFILES.some(profile => s.profiles[profile].hppBase.cellId === cellId);
}

function scopeOf(value: unknown): Scope {
  return value === "SHARED" ? "SHARED" : parseProfile(value);
}

export function addTable(snapshot: unknown, worksheetId: unknown, options: { readonly label: string; readonly afterTableId?: string | null }) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"worksheet">(worksheetId);
  const worksheet = s.worksheets.find(w => w.id === target);
  requireCondition(worksheet, "Worksheet tidak ditemukan.");
  requireCondition(options.label.trim().length > 0, "Label tabel wajib diisi.");
  const table: TableSnapshot = { id: id<"table">(), rows: [], columns: [], rowOrder: [], columnOrder: [], cells: [], merges: [] };
  const tables = insertAfterId(worksheet.tables, t => t.id, options.afterTableId ?? null, table);
  return changeWorkbook(s, { worksheets: s.worksheets.map(w => w.id === target ? { ...w, tables } : w) });
}

export function addRow(snapshot: unknown, tableId: unknown, options: { readonly label: string; readonly scope: Scope; readonly afterRowId?: string | null }) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  requireCondition(options.label.trim().length > 0, "Label baris wajib diisi.");
  const scope = scopeOf(options.scope);
  const rowId = id<"row">();
  const cells: CellSnapshot[] = table.columns.map(column => ({ id: id<"cell">(), tableId: target, rowId,
    columnId: column.id, scope, source: { kind: "INPUT", input: { kind: "UNSET" } } }));
  const updated: TableSnapshot = { ...table,
    rows: insertAfterId(table.rows, r => r.id, options.afterRowId ?? null, { id: rowId, label: options.label.trim() }),
    rowOrder: insertAfterId(table.rowOrder, r => r, options.afterRowId ?? null, rowId),
    cells: [...table.cells, ...cells] };
  return withIndexes(s, { worksheets: replaceTable(s, target, updated) });
}

export function addColumn(snapshot: unknown, tableId: unknown, options: { readonly label: string; readonly scope: Scope; readonly afterColumnId?: string | null }) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  requireCondition(options.label.trim().length > 0, "Label kolom wajib diisi.");
  const scope = scopeOf(options.scope);
  const columnId = id<"column">();
  const cells: CellSnapshot[] = table.rows.map(row => ({ id: id<"cell">(), tableId: target, rowId: row.id,
    columnId, scope, source: { kind: "INPUT", input: { kind: "UNSET" } } }));
  const updated: TableSnapshot = { ...table,
    columns: insertAfterId(table.columns, c => c.id, options.afterColumnId ?? null, { id: columnId, label: options.label.trim() }),
    columnOrder: insertAfterId(table.columnOrder, c => c, options.afterColumnId ?? null, columnId),
    cells: [...table.cells, ...cells] };
  return withIndexes(s, { worksheets: replaceTable(s, target, updated) });
}

export function removeRow(snapshot: unknown, tableId: unknown, rowId: unknown) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId), removing = parseStableId<"row">(rowId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  requireCondition(table.rowOrder.includes(removing), "Baris tidak ada pada tabel ini.");
  const removed = table.cells.filter(c => c.rowId === removing).map(c => c.id as string);
  requireCondition(removed.every(cellId => !cellInUse(s, cellId as StableId<"cell">)),
    "Baris masih menjadi referensi formula/mapping/HPP; lepaskan referensinya dulu.");
  const removedSet = new Set(removed);
  const updated: TableSnapshot = { ...table, rows: table.rows.filter(r => r.id !== removing),
    rowOrder: table.rowOrder.filter(r => r !== removing), cells: table.cells.filter(c => c.rowId !== removing),
    merges: table.merges.filter(m => !mergeCoveredCellIds(table, m).some(cellId => removedSet.has(cellId))) };
  return withIndexes(s, { worksheets: replaceTable(s, target, updated) });
}

export function removeColumn(snapshot: unknown, tableId: unknown, columnId: unknown) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId), removing = parseStableId<"column">(columnId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  requireCondition(table.columnOrder.includes(removing), "Kolom tidak ada pada tabel ini.");
  const removed = table.cells.filter(c => c.columnId === removing).map(c => c.id as string);
  requireCondition(removed.every(cellId => !cellInUse(s, cellId as StableId<"cell">)),
    "Kolom masih menjadi referensi formula/mapping/HPP; lepaskan referensinya dulu.");
  const removedSet = new Set(removed);
  const updated: TableSnapshot = { ...table, columns: table.columns.filter(c => c.id !== removing),
    columnOrder: table.columnOrder.filter(c => c !== removing), cells: table.cells.filter(c => c.columnId !== removing),
    merges: table.merges.filter(m => !mergeCoveredCellIds(table, m).some(cellId => removedSet.has(cellId))) };
  return withIndexes(s, { worksheets: replaceTable(s, target, updated) });
}

export function setRowLabel(snapshot: unknown, tableId: unknown, rowId: unknown, label: string) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId), row = parseStableId<"row">(rowId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  requireCondition(label.trim().length > 0, "Label baris wajib diisi.");
  const updated: TableSnapshot = { ...table, rows: table.rows.map(r => r.id === row ? { ...r, label: label.trim() } : r) };
  requireCondition(table.rows.some(r => r.id === row), "Baris tidak ditemukan pada tabel ini.");
  return changeWorkbook(s, { worksheets: replaceTable(s, target, updated) });
}

export function setColumnLabel(snapshot: unknown, tableId: unknown, columnId: unknown, label: string) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId), column = parseStableId<"column">(columnId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  requireCondition(label.trim().length > 0, "Label kolom wajib diisi.");
  const updated: TableSnapshot = { ...table, columns: table.columns.map(c => c.id === column ? { ...c, label: label.trim() } : c) };
  requireCondition(table.columns.some(c => c.id === column), "Kolom tidak ditemukan pada tabel ini.");
  return changeWorkbook(s, { worksheets: replaceTable(s, target, updated) });
}

export function mergeCells(snapshot: unknown, tableId: unknown, anchorCellId: unknown, span: { readonly rowSpan: number; readonly colSpan: number }) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId), anchorId = parseStableId<"cell">(anchorCellId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  const anchor = table.cells.find(c => c.id === anchorId);
  requireCondition(anchor, "Sel anchor tidak ada pada tabel ini.");
  const { rowSpan, colSpan } = span;
  requireCondition(Number.isSafeInteger(rowSpan) && rowSpan > 0 && Number.isSafeInteger(colSpan) && colSpan > 0,
    "Span merge harus bilangan bulat positif.");
  requireCondition(rowSpan > 1 || colSpan > 1, "Merge memerlukan minimal satu span lebih dari 1.");
  const atRow = table.rowOrder.indexOf(anchor.rowId), atColumn = table.columnOrder.indexOf(anchor.columnId);
  requireCondition(atRow + rowSpan <= table.rowOrder.length && atColumn + colSpan <= table.columnOrder.length,
    "Merge keluar dari batas tabel.");
  const merge: TableMerge = { id: id<"merge">(), anchorCellId: anchorId, rowSpan, colSpan };
  const positions = new Set(mergePositions(table, merge));
  requireCondition(!table.merges.some(existing => mergePositions(table, existing).some(position => positions.has(position))),
    "Merge bertumpuk dengan merge lain pada tabel ini.");
  return changeWorkbook(s, { worksheets: replaceTable(s, target, { ...table, merges: [...table.merges, merge] }) });
}

export function unmergeCells(snapshot: unknown, tableId: unknown, mergeId: unknown) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"table">(tableId), merge = parseStableId<"merge">(mergeId);
  const table = findTable(s, target);
  requireCondition(table, "Tabel tidak ditemukan.");
  requireCondition(table.merges.some(m => m.id === merge), "Merge tidak ditemukan pada tabel ini.");
  return changeWorkbook(s, { worksheets: replaceTable(s, target, { ...table, merges: table.merges.filter(m => m.id !== merge) }) });
}

// One active writer per target: the HPP conversion link cannot be rewritten as a formula.
export function setCellFormula(snapshot: unknown, cellId: unknown, expression: string) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"cell">(cellId);
  const cell = findCell(s, target);
  requireCondition(cell, "Sel tidak ditemukan.");
  const vendorCell = s.worksheets.some(w => w.stage === "EVALUASI_VENDOR" && w.tables.some(t => t.id === cell.tableId));
  requireCondition(vendorCell || !s.workbook?.cells.some(p => p.cellId === target && (p.kind === "LABEL" || (p.kind === "RESULT" && cell.source.kind !== "FORMULA"))),
    "Sel label atau hasil tidak boleh ditimpa formula.");
  requireCondition(!s.workbook?.bindings.some(b => b.cellId === target && ["cost", "supplier", "supplierName"].includes(b.key)), "Sel ini dikelola pilihan vendor atau solver.");
  requireCondition(!PROFILES.some(profile => s.profiles[profile].hppBase.cellId === target), "HPP mengikuti Biaya Konversi.");
  requireCondition(!s.mappings.some(m => m.targetCellId === target), "Target mapping tidak boleh ditimpa formula.");
  requireCondition(!s.mappings.some(m => m.sourceCellId === target && !(vendorCell && m.sourceComponent.startsWith("offer-revision:"))), "Sel sumber mapping tidak boleh diubah menjadi formula.");
  const referenceCellIds = [...new Set(references(parseFormula(expression), () => {
    throw new TypeError("Gunakan referensi sel langsung.");
  }))] as StableId<"cell">[];
  for (const reference of referenceCellIds) {
    const resolved = findCell(s, reference);
    requireCondition(resolved && (resolved.scope === "SHARED" || resolved.scope === cell.scope),
      "Referensi formula harus ada dan berada pada scope profil yang sama atau SHARED.");
  }
  const currentFormulaId = cell.source.kind === "FORMULA" ? cell.source.formulaId : null;
  const existing = currentFormulaId ? s.formulas.find(f => f.id === currentFormulaId) : undefined;
  const formulaId = existing?.id ?? id<"formula">();
  const formula: FormulaDefinition = { id: formulaId, versionId: id<"formula-version">(), targetCellId: target,
    expression, referenceCellIds, sourceKind: "OPERATIONAL_OVERRIDE", activation: "ACTIVE", provenance: existing?.provenance ?? null };
  const formulas = existing ? s.formulas.map(f => f.id === formulaId ? formula : f) : [...s.formulas, formula];
  const dependencies = new Map(formulas.filter(f => f.activation === "ACTIVE").map(f => [f.targetCellId, f.referenceCellIds]));
  for (const mapping of s.mappings.filter(m => m.status === "ACTIVE")) dependencies.set(mapping.targetCellId, [mapping.sourceCellId]);
  const seen = new Set<string>();
  const pending = [...referenceCellIds];
  while (pending.length) {
    const reference = pending.pop()!;
    requireCondition(reference !== target, "Formula membentuk siklus dependensi.");
    if (seen.has(reference)) continue;
    seen.add(reference); pending.push(...dependencies.get(reference) ?? []);
  }
  const worksheets = s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
    cells: t.cells.map(c => c.id === target ? { ...c, source: { kind: "FORMULA" as const, formulaId } } : c) })) }));
  const workbook = s.workbook ? { ...s.workbook, cells: s.workbook.cells.map(p => p.cellId === target ? { ...p, kind: "RESULT" as const } : p) } : undefined;
  return withIndexes(s, { worksheets, formulas, ...(workbook ? { workbook } : {}) });
}

export function clearCellSource(snapshot: unknown, cellId: unknown) {
  const s = parseSnapshot(snapshot);
  const target = parseStableId<"cell">(cellId);
  const cell = findCell(s, target);
  requireCondition(cell, "Sel tidak ditemukan.");
  const vendorCell = s.worksheets.some(w => w.stage === "EVALUASI_VENDOR" && w.tables.some(t => t.id === cell.tableId));
  requireCondition(vendorCell || !s.workbook?.cells.some(p => p.cellId === target && p.kind === "LABEL"), "Sel label tidak boleh dikosongkan.");
  requireCondition(!s.workbook?.bindings.some(b => b.cellId === target && ["cost", "supplier", "supplierName"].includes(b.key)), "Sel ini dikelola pilihan vendor atau solver.");
  requireCondition(!PROFILES.some(profile => s.profiles[profile].hppBase.cellId === target), "HPP mengikuti Biaya Konversi.");
  requireCondition(!s.mappings.some(m => m.targetCellId === target || (m.sourceCellId === target && !(vendorCell && m.sourceComponent.startsWith("offer-revision:")))),
    "Sel masih milik mapping; lepaskan mapping-nya lebih dulu.");
  const clearedFormulaId = cell.source.kind === "FORMULA" ? cell.source.formulaId : null;
  const formulas = clearedFormulaId ? s.formulas.filter(f => f.id !== clearedFormulaId) : s.formulas;
  const worksheets = s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
    cells: t.cells.map(c => c.id === target ? { ...c, source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } } : c) })) }));
  const workbook = s.workbook ? { ...s.workbook, cells: s.workbook.cells.map(p => p.cellId === target ? { ...p, kind: "INPUT" as const } : p) } : undefined;
  return withIndexes(s, { worksheets, formulas, ...(workbook ? { workbook } : {}) });
}
