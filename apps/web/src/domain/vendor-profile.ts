import type { CellPresentation, CellSnapshot, SheetPresentation, TableSnapshot, WorkbookSnapshot } from "./contracts.ts";
import { createStableId as id } from "./ids.ts";
import { changeWorkbook } from "./workflow.ts";
import { addRow, setCellInput } from "./structure.ts";
import { requireCondition } from "./validation.ts";

export const vendorProfileRows = [
  ["Legalitas & Status Usaha", "", "heading"], ["Legalitas & Status Usaha", "Perizinan Niaga BBM"],
  ["Legalitas & Status Usaha", "Bentuk Usaha"],
  ["Legalitas & Status Usaha", "Status Perpajakan"],
  ["Harga & Skema Pembayaran", "", "heading"], ["Harga & Skema Pembayaran", "Skema Pembayaran"],
  ["Harga & Skema Pembayaran", "Termin Pembayaran"],
  ["Ketersediaan Stok", "", "heading"], ["Ketersediaan Stok", "Sumber BBM"],
  ["Ketersediaan Stok", "Status Stok"],
  ["Ketersediaan Stok", "Volume Stok Tersedia"],
  ["Ketersediaan Stok", "Kapasitas Supply"],
  ["Ketersediaan Stok", "Kontinuitas Pasokan"],
  ["Kualitas BBM", "", "heading"], ["Kualitas BBM", "Jenis & Spesifikasi BBM"],
  ["Kualitas BBM", "Certificate of Analysis (COA)"],
  ["Kualitas BBM", "Kesesuaian Spesifikasi"],
  ["Kualitas BBM", "Jaminan Kualitas"],
  ["Operasional & Logistik Pengiriman", "", "heading"], ["Operasional & Logistik Pengiriman", "Lokasi Storage"],
  ["Operasional & Logistik Pengiriman", "Kapasitas Pengiriman"],
  ["Operasional & Logistik Pengiriman", "Armada Transportasi"],
  ["Operasional & Logistik Pengiriman", "Lead Time"],
  ["Operasional & Logistik Pengiriman", "Metode Pengukuran Volume"],
  ["Kesimpulan", "Note", "conclusion"],
  ["Kesimpulan", "Vendor yang Dipilih", "conclusion"],
  ["Kesimpulan", "Alasan Pemilihan Vendor", "conclusion"],
] as const;
export const vendorProfileTableRows = [vendorProfileRows.slice(0, 13), vendorProfileRows.slice(13)] as const;

const marker = "vendor-profile|";
export function isVendorProfileTable(table: TableSnapshot) { return table.rows[0]?.label.startsWith(marker) ?? false; }

export function isVendorAspectHeading(label: string): boolean {
  return label.startsWith(marker) && (label.endsWith("|heading") || vendorProfileRows[Number(label.split("|")[1])]?.[2] === "heading");
}

export function addVendorAspect(s: WorkbookSnapshot, name: string, groupRowId: string | null) {
  requireCondition(name.trim().length > 0, "Nama aspek wajib diisi.");
  const table = s.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.find(isVendorProfileTable);
  requireCondition(table, "Tabel aspek vendor tidak ditemukan.");
  const rows = table.rowOrder.map(rowId => table.rows.find(row => row.id === rowId)!);
  const start = groupRowId === null ? -1 : rows.findIndex(row => row.id === groupRowId && isVendorAspectHeading(row.label));
  requireCondition(groupRowId === null || start >= 0, "Pilih kelompok aspek yang tersedia.");
  const boundary = rows.findIndex((row, index) => index > start && (row.label.endsWith("|conclusion") || (groupRowId !== null && isVendorAspectHeading(row.label))));
  const afterRowId = rows[(boundary < 0 ? rows.length : boundary) - 1]?.id ?? null;
  const label = groupRowId === null ? `${marker}group-${id<"row">()}|||heading` : `vendor-profile-extra|${id<"row">()}`;
  const next = addRow(s, table.id, { label, scope: "SHARED", afterRowId });
  const added = next.worksheets.flatMap(w => w.tables).find(item => item.id === table.id)!;
  const rowId = added.rowOrder.find(rowId => !table.rowOrder.includes(rowId))!;
  const cell = added.cells.find(cell => cell.rowId === rowId && cell.columnId === added.columnOrder[0])!;
  return { snapshot: setCellInput(next, cell.id, { kind: "TEXT", text: name.trim() }), firstCellId: cell.id };
}

function ensureConclusionRows(s: WorkbookSnapshot, table: TableSnapshot): WorkbookSnapshot {
  const worksheet = s.worksheets.find(w => w.stage === "EVALUASI_VENDOR")!;
  const missing = vendorProfileRows.filter(([, label, kind]) => kind === "conclusion" && !table.rows.some(row => row.label.endsWith(`|${label}|conclusion`)));
  if (!missing.length) return s;
  const rows = missing.map(([, label], index) => ({ id: id<"row">(), label: `${marker}conclusion-${index}|Kesimpulan|${label}|conclusion` }));
  const cells = rows.flatMap((row, rowIndex) => table.columns.map((column, columnIndex) => ({ id: id<"cell">(), tableId: table.id, rowId: row.id, columnId: column.id, scope: "SHARED" as const,
    source: { kind: "INPUT" as const, input: { kind: "TEXT" as const, text: columnIndex === 0 ? missing[rowIndex]![1] : "" } } })));
  const presentations = cells.map(cell => ({ cellId: cell.id, address: `${table.columns.find(column => column.id === cell.columnId)?.label ?? "B"}${200 + rows.findIndex(row => row.id === cell.rowId)}`, kind: "INPUT" as const, tone: "plain" as const, bold: false, align: "left" as const, unit: "text" as const }));
  const updated = { ...table, rows: [...table.rows, ...rows], rowOrder: [...table.rowOrder, ...rows.map(row => row.id)], cells: [...table.cells, ...cells], merges: [...table.merges, ...rows.map(row => ({ id: id<"merge">(), anchorCellId: cells.find(cell => cell.rowId === row.id && cell.columnId === table.columnOrder[1])!.id, rowSpan: 1, colSpan: Math.max(1, table.columnOrder.length - 1) }))] };
  return changeWorkbook(s, { worksheets: s.worksheets.map(w => w.id === worksheet.id ? { ...w, tables: w.tables.map(item => item.id === table.id ? updated : item) } : w), ...(s.workbook ? { workbook: { ...s.workbook, cells: [...s.workbook.cells, ...presentations], tables: s.workbook.tables.map(layout => layout.tableId === table.id ? { ...layout, rowHeights: [...layout.rowHeights, ...rows.map(row => ({ id: row.id, size: 30 }))] } : layout), configuration: s.workbook.configuration ? { ...s.workbook.configuration, version: id<"policy">(), units: [...s.workbook.configuration.units, ...presentations.map(p => ({ cellId: p.cellId, symbol: "1", dimensions: {} }))] } : null } } : {}) });
}

export function ensureVendorProfileTable(s: WorkbookSnapshot): WorkbookSnapshot {
  const worksheet = s.worksheets.find(w => w.stage === "EVALUASI_VENDOR");
  const vendorTable = worksheet?.tables.find(table => !isVendorProfileTable(table));
  if (!worksheet || !vendorTable) return s;
  const profileTables = worksheet.tables.filter(isVendorProfileTable);
  if (profileTables.length > 1) {
    const target = profileTables[0]!;
    const targetColumns = new Map(target.columns.map(column => [column.label, column.id]));
    const merged = profileTables.slice(1).reduce((current, source) => ({
      ...current,
      rows: [...current.rows, ...source.rows],
      rowOrder: [...current.rowOrder, ...source.rowOrder],
      cells: [...current.cells, ...source.cells.map(cell => ({ ...cell, tableId: target.id, columnId: targetColumns.get(source.columns.find(column => column.id === cell.columnId)?.label ?? "") ?? cell.columnId }))],
      merges: [...current.merges, ...source.merges],
    }), target);
    const mergedIds = new Set(profileTables.slice(1).map(table => table.id));
    const changed = changeWorkbook(s, {
      worksheets: s.worksheets.map(w => w.id === worksheet.id ? { ...w, tables: w.tables.filter(table => !mergedIds.has(table.id)).map(table => table.id === target.id ? merged : table) } : w),
      ...(s.workbook ? { workbook: { ...s.workbook, tables: s.workbook.tables.filter(layout => !mergedIds.has(layout.tableId)).map(layout => layout.tableId === target.id ? { ...layout, rowHeights: profileTables.flatMap(table => s.workbook!.tables.find(item => item.tableId === table.id)?.rowHeights ?? []) } : layout) } } : {}),
    });
    return ensureVendorProfileTable(changed);
  }
  const existing = profileTables[0];
  if (existing) {
    const withConclusion = ensureConclusionRows(s, profileTables.at(-1)!);
    if (withConclusion !== s) return withConclusion;
  }
  const desiredColumns = s.workbook ? vendorTable.columns : [{ id: id<"column">(), label: "B" }, ...s.analysis.offers.map((_, index) => ({ id: id<"column">(), label: String.fromCharCode(67 + index) }))];
  if (existing) {
    const missing = desiredColumns.filter(column => !existing.columns.some(item => item.label === column.label)).map(column => ({ ...column, id: id<"column">() }));
    if (!missing.length) return s;
    const addedCells = missing.flatMap(column => existing.rows.map(row => ({ id: id<"cell">(), tableId: existing.id, rowId: row.id, columnId: column.id,
      scope: "SHARED" as const, source: { kind: "INPUT" as const, input: { kind: "TEXT" as const, text: "" } } })));
    const table = { ...existing, columns: [...existing.columns, ...missing], columnOrder: [...existing.columnOrder, ...missing.map(column => column.id)], cells: [...existing.cells, ...addedCells] };
    const presentations = addedCells.map((cell, index) => ({ cellId: cell.id, address: `${missing[Math.floor(index / existing.rows.length)]!.label}${100 + existing.rows.findIndex(row => row.id === cell.rowId)}`, kind: "INPUT" as const, tone: "plain" as const, bold: false, align: "left" as const, unit: "text" as const }));
    return changeWorkbook(s, { worksheets: s.worksheets.map(w => w.id === worksheet.id ? { ...w, tables: w.tables.map(item => item.id === existing.id ? table : item) } : w), ...(s.workbook ? { workbook: { ...s.workbook, cells: [...s.workbook.cells, ...presentations], tables: s.workbook.tables.map(layout => layout.tableId === existing.id ? { ...layout, columnWidths: [...layout.columnWidths, ...missing.map(column => ({ id: column.id, size: 160 }))] } : layout), configuration: s.workbook.configuration ? { ...s.workbook.configuration, version: id<"policy">(), units: [...s.workbook.configuration.units, ...presentations.map(p => ({ cellId: p.cellId, symbol: "1", dimensions: {} }))] } : null } } : {}) });
  }
  const tableId = id<"table">();
  const rows = vendorProfileRows.map(([section, label, kind], index) => ({ id: id<"row">(), label: `${marker}${index}|${section}|${label}|${kind ?? ""}` }));
  const columns = desiredColumns.map(column => ({ ...column, id: id<"column">() }));
  const cells: CellSnapshot[] = [];
  const presentations: CellPresentation[] = [];
  rows.forEach((row, rowIndex) => columns.forEach((column, columnIndex) => {
    const item = vendorProfileRows[rowIndex]!;
    const cell: CellSnapshot = { id: id<"cell">(), tableId, rowId: row.id, columnId: column.id, scope: "SHARED", source: { kind: "INPUT", input: columnIndex === 0 ? { kind: "TEXT", text: item[1] || item[0] } : { kind: "TEXT", text: "" } } };
    cells.push(cell);
    presentations.push({ cellId: cell.id, address: `${String.fromCharCode(66 + columnIndex)}${100 + rowIndex}`, kind: columnIndex === 0 ? "LABEL" : "INPUT", tone: "plain", bold: false, align: "left", unit: "text" });
  }));
  const tables: TableSnapshot[] = [{ id: tableId, rows, columns, rowOrder: rows.map(row => row.id), columnOrder: columns.map(column => column.id), cells,
    merges: rows.flatMap((row, index) => vendorProfileRows[index]![2] === "conclusion" && columns.length > 1 ? [{ id: id<"merge">(), anchorCellId: cells.find(cell => cell.rowId === row.id && cell.columnId === columns[1]!.id)!.id, rowSpan: 1, colSpan: columns.length - 1 }] : []) }];
  const layouts: SheetPresentation[] = [{ tableId, profile: "SHARED", rowHeights: rows.map(row => ({ id: row.id, size: 30 })), columnWidths: columns.map(column => ({ id: column.id, size: 160 })) }];
  const workbook = s.workbook ? { ...s.workbook,
    cells: [...s.workbook.cells, ...presentations],
    tables: [...layouts, ...s.workbook.tables],
    configuration: s.workbook.configuration ? { ...s.workbook.configuration, version: id<"policy">(), units: [...s.workbook.configuration.units, ...presentations.map(p => ({ cellId: p.cellId, symbol: "1", dimensions: {} }))] } : null,
  } : undefined;
  return changeWorkbook(s, { worksheets: s.worksheets.map(w => w.id === worksheet.id ? { ...w, tables: [...tables, ...w.tables] } : w), ...(workbook ? { workbook } : {}) });
}

