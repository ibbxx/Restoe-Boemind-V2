import type { AhsField, AhsValueType, CellPresentation, CellSnapshot, TableSnapshot, WorkbookSnapshot } from "./contracts.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import { createStableId as id } from "./ids.ts";
import { ahsCell, ahsLabel, ahsRoleCell, finishAhsChange } from "./ahs-groups.ts";
import { units } from "./procurement-template.ts";
import { requireCondition } from "./validation.ts";
import { updateCellInput } from "./commands.ts";

export const ahsFieldUnit = (type: AhsValueType): CellPresentation["unit"] => type === "TEXT" ? "text" : type === "IDR" || type === "IDR/L" ? type : "1";
export const ahsFields = (s: WorkbookSnapshot, section: AhsField["section"], profile = s.activeProfile) =>
  s.ahsFields?.filter(f => f.profile === profile && f.section === section) ?? [];

export function addAhsField(s: WorkbookSnapshot, section: AhsField["section"], rawName: string, valueType: AhsValueType): WorkbookSnapshot {
  const name = rawName.trim();
  requireCondition(name, "Nama uraian wajib diisi.");
  requireCondition(section === "INFORMASI" ? ["TEXT", "NUMBER"].includes(valueType) : valueType !== "TEXT", "Jenis nilai tidak sesuai bagian AHS.");
  const profile = s.activeProfile;
  const anchor = section === "INFORMASI" ? ahsRoleCell(s, profile, "J8", "Harga Include") : ahsRoleCell(s, profile, "G39", "Notes");
  requireCondition(anchor, "Posisi bagian AHS tidak ditemukan.");
  const tables = s.worksheets.flatMap(w => w.tables);
  let table = s.workbook ? tables.find(t => t.id === anchor.tableId) : undefined;
  if (!table) {
    const columns = ["G", "H", "I", "J", "K", "L"].map(label => ({ id: id<"column">(), label }));
    table = { id: id<"table">(), rows: [], columns, rowOrder: [], columnOrder: columns.map(c => c.id), cells: [], merges: [] };
  }
  const rowId = id<"row">(), unit = ahsFieldUnit(valueType);
  const cells: CellSnapshot[] = table.columns.map(column => ({ id: id<"cell">(), tableId: table!.id, rowId, columnId: column.id,
    scope: profile, source: { kind: "INPUT", input: { kind: "TEXT", text: "" } } }));
  const at = (label: string) => cells.find(c => c.columnId === table!.columns.find(col => col.label === label)?.id)!;
  const label = at("G"), value = at(section === "INFORMASI" ? "J" : "L");
  requireCondition(label && value && table.columns.length === 6, "Kolom bagian AHS tidak lengkap.");
  const field: AhsField = { profile, section, name, valueType, labelCellId: label.id, valueCellId: value.id };
  const rowOrder = [...table.rowOrder];
  const index = table.rowOrder.indexOf(anchor.rowId); rowOrder.splice(index < 0 ? rowOrder.length : index, 0, rowId);
  const merges = [...table.merges, { id: id<"merge">(), anchorCellId: label.id, rowSpan: 1, colSpan: section === "INFORMASI" ? 3 : 5 },
    ...(section === "INFORMASI" ? [{ id: id<"merge">(), anchorCellId: value.id, rowSpan: 1, colSpan: 3 }] : [])];
  const updated: TableSnapshot = { ...table, rowOrder, rows: [...table.rows, { id: rowId, label: "ahs-field" }], merges,
    cells: [...table.cells, ...cells.map(c => c.id === label.id ? { ...c, source: { kind: "INPUT" as const, input: { kind: "TEXT" as const, text: name } } }
      : c.id === value.id ? { ...c, source: { kind: "INPUT" as const, input: valueType === "TEXT" ? { kind: "UNSET" as const } : { kind: "NUMERIC_TEXT" as const, text: "0" } } } : c)] };
  const nextTables = tables.some(t => t.id === table!.id) ? tables.map(t => t.id === table!.id ? updated : t) : [...tables, updated];
  const number = Math.max(42, ...s.workbook?.cells.map(p => Number(p.address.match(/\d+$/)?.[0]) || 0) ?? []) + 1;
  const presentation = cells.map(c => ({ cellId: c.id, address: table!.columns.find(col => col.id === c.columnId)!.label + number,
    unit: c.id === value.id ? unit : "text" as const, kind: c.id === value.id ? "INPUT" as const : "LABEL" as const,
    tone: section === "INFORMASI" ? "yellow" as const : "gray" as const, bold: c.id === label.id, align: c.id === value.id && unit !== "text" ? "right" as const : "left" as const }));
  const config = s.workbook?.configuration;
  return finishAhsChange(s, nextTables, [], s.formulas, s.workbook ? [...s.workbook.cells, ...presentation] : undefined,
    config ? { ...config, units: [...config.units, ...presentation.map(p => ({ cellId: p.cellId, symbol: p.unit === "text" ? "1" : p.unit, dimensions: units[p.unit] }))] } : config,
    null, [...s.ahsFields ?? [], field]);
}

function findField(s: WorkbookSnapshot, valueCellId: string) {
  const field = s.ahsFields?.find(f => f.profile === s.activeProfile && f.valueCellId === valueCellId);
  requireCondition(field, "Uraian tambahan tidak ditemukan pada profil aktif."); return field;
}

export function renameAhsField(s: WorkbookSnapshot, valueCellId: string, rawName: string) {
  const field = findField(s, valueCellId), name = rawName.trim();
  requireCondition(name, "Nama uraian wajib diisi.");
  const renamed = updateCellInput(s, field.profile, field.labelCellId, { kind: "TEXT", text: name });
  return finishAhsChange(renamed, renamed.worksheets.flatMap(w => w.tables), [], renamed.formulas, undefined, undefined, null,
    renamed.ahsFields!.map(f => f.valueCellId === valueCellId ? { ...f, name } : f));
}

export function removeAhsField(s: WorkbookSnapshot, valueCellId: string, configuration: EngineConfiguration) {
  const field = findField(s, valueCellId), value = ahsCell(s, field.valueCellId)!;
  const tables = s.worksheets.flatMap(w => w.tables);
  const removing = new Set(tables.flatMap(t => t.cells.filter(c => c.rowId === value.rowId).map(c => c.id)));
  requireCondition(!s.formulas.some(f => !removing.has(f.targetCellId) && f.referenceCellIds.some(id => removing.has(id))) &&
    !s.mappings.some(m => removing.has(m.sourceCellId) || removing.has(m.targetCellId)) &&
    !configuration.aggregates.some(a => a.memberCellIds.some(id => removing.has(id))) && !configuration.selectionDependentCellIds.some(id => removing.has(id)),
    "Uraian masih digunakan rumus, mapping, atau agregat; lepaskan referensinya terlebih dahulu.");
  requireCondition(!s.workbook?.bindings.some(b => removing.has(b.cellId)) && !Object.values(s.profiles).some(p => removing.has(p.hppBase.cellId)), "Sel inti AHS tidak dapat dihapus.");
  const nextTables = tables.flatMap(t => {
    const merges = t.merges.filter(m => {
      const anchor = t.cells.find(c => c.id === m.anchorCellId)!;
      const start = t.rowOrder.indexOf(anchor.rowId);
      const touches = t.rowOrder.slice(start, start + m.rowSpan).includes(value.rowId);
      requireCondition(!touches || m.rowSpan === 1, "Pisahkan sel gabungan sebelum menghapus uraian.");
      return !touches;
    });
    const updated = { ...t, merges, cells: t.cells.filter(c => !removing.has(c.id)), rows: t.rows.filter(r => r.id !== value.rowId), rowOrder: t.rowOrder.filter(row => row !== value.rowId) };
    return updated.rows.length ? [updated] : [];
  });
  return finishAhsChange(s, nextTables, [], s.formulas.filter(f => !removing.has(f.targetCellId)), undefined, undefined, null,
    s.ahsFields!.filter(f => f.valueCellId !== field.valueCellId));
}

export function ahsFieldName(s: WorkbookSnapshot, field: AhsField) { return ahsLabel(s, field); }
