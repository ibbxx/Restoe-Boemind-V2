import type { CellInput, CellPresentation, CellSnapshot, WorkbookSnapshot } from "./contracts.ts";
import type { StableId } from "./ids.ts";
import { createStableId as id } from "./ids.ts";
import { appendField, changeWorkbook } from "./workflow.ts";
import { requireCondition } from "./validation.ts";
import { units, formulaFromAddresses } from "./procurement-template.ts";
import { SOURCE_HASH, SOURCE_SHEETS } from "./source-template.ts";
import { parseFormula, references } from "../engine/parser.ts";
import { PROFILES } from "./profiles.ts";
import { addColumn, addRow } from "./structure.ts";
import { vendorComponents, vendorComponentRoles, includeNewVendorComponentTotals } from "./vendor-components.ts";
import { validateAhsVolumeInput } from "./ahs-volume.ts";
import { prepareSolarCosts, requireSolarCostEditable } from "./solar-cost.ts";
import { ensureVendorProfileTable, isVendorProfileTable } from "./vendor-profile.ts";

export function reconcilePresentation(s: WorkbookSnapshot): WorkbookSnapshot {
  if (!s.workbook) return s;
  const tables = s.worksheets.flatMap(w => w.tables), cells = tables.flatMap(t => t.cells), cellIds = new Set(cells.map(c => c.id));
  const w = s.workbook;
  const presentations = cells.map(cell => {
    const existing = w.cells.find(c => c.cellId === cell.id); if (existing) return existing;
    const table = tables.find(t => t.id === cell.tableId)!;
    const nearby = table.cells.find(c => c.columnId === cell.columnId && w.cells.some(p => p.cellId === c.id));
    const style = w.cells.find(p => p.cellId === nearby?.id);
    const columnUnits = new Set(table.cells.filter(c => c.columnId === cell.columnId && c.id !== cell.id)
      .map(c => w.cells.find(p => p.cellId === c.id)?.unit).filter((unit): unit is CellPresentation["unit"] => !!unit));
    const unit = columnUnits.size === 1 ? [...columnUnits][0]! : "text";
    return { cellId: cell.id, address: "", kind: "INPUT" as const, tone: style?.tone ?? "plain", bold: false, align: "left" as const, unit };
  });
  const config = w.configuration;
  const oldIds = new Set(w.cells.map(c => c.cellId));
  const changed = cells.length !== w.cells.length || cells.some(c => !oldIds.has(c.id));
  return { ...s, workbook: { ...w, cells: presentations,
    tables: w.tables.filter(p => tables.some(t => t.id === p.tableId)).map(p => {
      const t = tables.find(t => t.id === p.tableId)!;
      return { ...p, rowHeights: t.rowOrder.map(id => p.rowHeights.find(r => r.id === id) ?? { id, size: 24 }), columnWidths: t.columnOrder.map(id => p.columnWidths.find(c => c.id === id) ?? { id, size: 101 }) };
    }),
    configuration: config && changed ? { ...config, version: id<"policy">(), units: [...config.units.filter(u => cellIds.has(u.cellId)), ...presentations.filter(p => !oldIds.has(p.cellId)).map(p => ({ cellId: p.cellId, symbol: p.unit === "text" ? "1" : p.unit, dimensions: units[p.unit] }))] } : config,
  } };
}

export function resizeSheet(s: WorkbookSnapshot, tableId: string, axis: "row" | "column", target: string, size: number) {
  requireCondition(s.workbook, "Template dinamis diperlukan.");
  requireCondition(Number.isFinite(size) && size >= 18 && size <= (axis === "row" ? 800 : 1200), "Ukuran di luar batas.");
  const table = s.worksheets.flatMap(w => w.tables).find(t => t.id === tableId);
  requireCondition(table && (axis === "row" ? table.rowOrder : table.columnOrder).some(id => id === target), "Target ukuran tidak ditemukan.");
  const key = axis === "row" ? "rowHeights" : "columnWidths";
  return changeWorkbook(s, { workbook: { ...s.workbook, tables: s.workbook.tables.map(t => t.tableId !== tableId ? t : { ...t, [key]: t[key].map(v => v.id === target ? { ...v, size } : v) }) } });
}

export function addSheetVendor(snapshot: WorkbookSnapshot, name: string, pattern: "C" | "D" | "E", targetColumnId?: StableId<"column">) {
  requireCondition(name.trim() && snapshot.workbook, "Nama vendor wajib diisi.");
  let s = snapshot;
  const profile = "SHARED" as const;
  const tableId = s.worksheets.find(w => w.stage === "EVALUASI_VENDOR")!.tables.find(table => !isVendorProfileTable(table))!.id;
  let table = s.worksheets.flatMap(w => w.tables).find(t => t.id === tableId)!;
  requireCondition(!targetColumnId || (table.columnOrder.slice(1).includes(targetColumnId) && !s.workbook!.offers.some(o => o.columnId === targetColumnId)), "Kolom vendor tidak tersedia.");
  let columnId = targetColumnId ?? table.columnOrder.slice(1).find(c => !s.workbook!.offers.some(o => o.columnId === c));
  if (!columnId) {
    s = addColumn(s, table.id, { label: "Vendor", scope: profile });
    table = s.worksheets.flatMap(w => w.tables).find(t => t.id === tableId)!;
    columnId = table.columnOrder.at(-1)!;
  }
  const columnName = (position: number) => {
    let name = "";
    while (position > 0) {
      position--;
      name = String.fromCharCode(65 + position % 26) + name;
      position = Math.floor(position / 26);
    }
    return name;
  };
  let columnNumber = table.columnOrder.indexOf(columnId) + 2;
  let actualColumn = columnName(columnNumber);
  while (table.cells.some(cell => cell.columnId !== columnId &&
    s.workbook!.cells.some(p => p.cellId === cell.id && p.address === actualColumn + "9"))) {
    actualColumn = columnName(++columnNumber);
  }
  const sheet = SOURCE_SHEETS[0]!;
  const vendorId = id<"vendor">(), offerId = id<"offer">();
  const formulas = [...s.formulas];
  const newPresentations = new Map<string, CellPresentation>();
  const values: { id: StableId<"offer-value">; label: string; input: CellInput }[] = [];
  const resolve = (address: string) => {
    const sourceCell = table.cells.find(c => s.workbook!.cells.some(p => p.cellId === c.id && p.address === "B" + address.slice(1)));
    const row = table.rows.find(r => r.id === sourceCell?.rowId);
    requireCondition(row, "Baris template vendor telah diubah; pilih formula secara eksplisit.");
    return table.cells.find(c => c.rowId === row.id && c.columnId === columnId)!.id;
  };
  const cells = table.cells.map(cell => {
    if (cell.columnId !== columnId) return cell;
    const rowSource = s.workbook!.cells.find(p => table.cells.some(c => c.id === p.cellId && c.rowId === cell.rowId) && /^B\d+$/.test(p.address));
    if (!rowSource) return cell;
    const rowNumber = Number(rowSource.address.slice(1)), canonicalRow = rowNumber;
    const address = actualColumn + rowNumber, source = sheet.cells[pattern + rowNumber];
    const style = s.workbook!.cells.find(p => p.cellId === cell.id)!;
    let cellSource: CellSnapshot["source"] = { kind: "INPUT", input: { kind: "TEXT", text: "" } };
    let kind: CellPresentation["kind"] = "BLANK", unit: CellPresentation["unit"] = "text";
    if (canonicalRow === 9) { kind = "INPUT"; cellSource = { kind: "INPUT", input: { kind: "TEXT", text: name.trim() } }; }
    else if (canonicalRow >= 10 && canonicalRow <= 17) {
      unit = "IDR/L";
      const isSecondVendorPbbkb = pattern === "D" && canonicalRow === 12;
      if (source?.formula && canonicalRow !== 10 && canonicalRow !== 13 && !isSecondVendorPbbkb) {
        kind = "RESULT";
        const expression = formulaFromAddresses(source.formula, a => {
          requireCondition(a.startsWith(pattern), "Formula vendor merujuk ke kolom lain; pilih formula secara eksplisit.");
          return resolve(a);
        });
        const formulaId = id<"formula">();
        formulas.push({ id: formulaId, targetCellId: cell.id, expression, referenceCellIds: [...new Set(references(parseFormula(expression), () => []))] as StableId<"cell">[], sourceKind: "WORKBOOK_SOURCE", activation: "ACTIVE", provenance: { workbookSha256: SOURCE_HASH, sheet: sheet.name, address: pattern + rowNumber } });
        cellSource = { kind: "FORMULA", formulaId };
      } else if (canonicalRow !== 17) {
        kind = "INPUT"; cellSource = { kind: "INPUT", input: isSecondVendorPbbkb ? { kind: "UNSET" } : canonicalRow === 10 && cell.source.kind === "INPUT" && cell.source.input.kind === "NUMERIC_TEXT"
          ? cell.source.input : canonicalRow === 10 || (source?.number && Number(source.number) !== 0) ? { kind: "UNSET" } : { kind: "NUMERIC_TEXT", text: "0" } };
      }
    } else if (canonicalRow === 18) { kind = "INPUT"; cellSource = { kind: "INPUT", input: { kind: "UNSET" } }; }
    else if (table.rows.some(row => row.id === cell.rowId && row.label.startsWith("component:"))) {
      kind = "INPUT"; unit = "IDR/L"; cellSource = { kind: "INPUT", input: { kind: "UNSET" } };
    }
    if (cell.source.kind === "FORMULA" || (canonicalRow !== 9 && cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" && cell.source.input.text !== "")) {
      cellSource = cell.source;
      kind = cell.source.kind === "FORMULA" ? "RESULT" : "INPUT";
      const created = formulas.findIndex(f => f.targetCellId === cell.id && !s.formulas.some(existing => existing.id === f.id));
      if (created >= 0) formulas.splice(created, 1);
    }
    if (kind === "INPUT" && cellSource.kind === "INPUT") values.push({ id: id<"offer-value">(), label: cell.id, input: cellSource.input });
    newPresentations.set(cell.id, { ...style, address, kind, unit });
    return { ...cell, source: cellSource };
  });
  const worksheets = s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => t.id === tableId ? { ...t, cells } : t) }));
  const presentations = s.workbook!.cells.map(p => newPresentations.get(p.cellId) ?? p);
  const configuration = s.workbook!.configuration;
  return ensureVendorProfileTable(includeNewVendorComponentTotals(changeWorkbook(s, { worksheets, formulas, analysis: { ...s.analysis,
    vendors: [...s.analysis.vendors, { id: vendorId, analysisId: s.analysisId, name: name.trim() }],
    offers: [...s.analysis.offers, { id: offerId, analysisId: s.analysisId, vendorId, label: name.trim(), values }] },
    workbook: { ...s.workbook!, cells: presentations, offers: [...s.workbook!.offers, { columnId, baseCellId: resolve(actualColumn + "10"), nameCellId: resolve(actualColumn + "9"), offerId, pattern }], configuration: configuration ? { ...configuration, version: id<"policy">(), units: presentations.map(p => ({ cellId: p.cellId, symbol: p.unit === "text" ? "1" : p.unit, dimensions: units[p.unit] })) } : null } }), offerId));
}

export function removeSheetVendor(snapshot: WorkbookSnapshot, offerId: StableId<"offer">) {
  requireCondition(snapshot.analysis.offers.length > 3, "Minimal tiga vendor harus dipertahankan.");
  const offer = snapshot.analysis.offers.find(item => item.id === offerId);
  requireCondition(offer, "Vendor tidak ditemukan.");
  const workbookOffer = snapshot.workbook?.offers.find(item => item.offerId === offerId);
  requireCondition(!snapshot.workbook || workbookOffer, "Vendor workbook tidak ditemukan.");
  const vendorTable = snapshot.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.find(table => !isVendorProfileTable(table));
  requireCondition(vendorTable, "Tabel evaluasi vendor tidak ditemukan.");
  const removedColumnLabel = vendorTable!.columns.find(column => column.id === workbookOffer?.columnId)?.label;
  const removedCells = new Set(snapshot.worksheets.filter(w => w.stage === "EVALUASI_VENDOR").flatMap(w => w.tables.flatMap(table => table.cells.filter(cell => snapshot.workbook
    ? cell.columnId === workbookOffer!.columnId || (isVendorProfileTable(table) && table.columns.find(column => column.id === cell.columnId)?.label === removedColumnLabel)
    : (table.rows.find(row => row.id === cell.rowId)?.label ?? "").includes(`|vendor:${offerId}:`)).map(cell => cell.id))));
  // Shared project metadata belongs to the sheet even when its vendor column is removed.
  const relocated = new Map<StableId<"cell">, StableId<"column">>();
  for (const cell of vendorTable.cells.filter(cell => removedCells.has(cell.id) && snapshot.workbook?.cells.some(p => p.cellId === cell.id && /^D[567]$/.test(p.address)))) {
    const replacement = vendorTable.cells.find(other => other.rowId === cell.rowId &&
      vendorTable.columnOrder.indexOf(other.columnId) > vendorTable.columnOrder.indexOf(cell.columnId) && !removedCells.has(other.id));
    requireCondition(replacement && replacement.source.kind === "INPUT" && (replacement.source.input.kind === "UNSET" || !replacement.source.input.text), "Kolom berisi metadata proyek; kosongkan sel penggantinya terlebih dahulu.");
    removedCells.delete(cell.id); removedCells.add(replacement.id); relocated.set(cell.id, replacement.columnId);
  }
  requireCondition(snapshot.formulas.every(formula => removedCells.has(formula.targetCellId) || !formula.referenceCellIds.some(cellId => removedCells.has(cellId))), "Vendor masih dipakai formula lain; ubah referensi formula tersebut terlebih dahulu.");
  requireCondition(!snapshot.workbook?.configuration?.aggregates.some(aggregate => aggregate.memberCellIds.some(cellId => removedCells.has(cellId))), "Vendor masih dipakai agregat perhitungan.");
  const removedMappings = new Set(snapshot.mappings.filter(mapping => removedCells.has(mapping.sourceCellId) || removedCells.has(mapping.targetCellId)).map(mapping => mapping.id));
  const tables = snapshot.worksheets.map(worksheet => ({ ...worksheet, tables: worksheet.tables.map(table => ({
    ...table, columns: table.columns.filter(column => column.id !== workbookOffer?.columnId && !(isVendorProfileTable(table) && column.label === removedColumnLabel)),
    columnOrder: table.columnOrder.filter(columnId => columnId !== workbookOffer?.columnId && !(isVendorProfileTable(table) && table.columns.find(column => column.id === columnId)?.label === removedColumnLabel)),
    cells: table.cells.filter(cell => !removedCells.has(cell.id)).map(cell => {
      const retained = relocated.has(cell.id) ? { ...cell, columnId: relocated.get(cell.id)! } : cell;
      return retained.source.kind === "MAPPING" && removedMappings.has(retained.source.mappingId)
        ? { ...retained, source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } } : retained;
    }),
    merges: table.merges.flatMap(merge => {
      if (removedCells.has(merge.anchorCellId)) return [];
      const anchor = table.cells.find(cell => cell.id === merge.anchorCellId)!;
      const start = table.columnOrder.indexOf(anchor.columnId), removing = workbookOffer ? table.columnOrder.indexOf(workbookOffer.columnId) : -1;
      return [{ ...merge, colSpan: merge.colSpan - (removing >= start && removing < start + merge.colSpan ? 1 : 0) }];
    }),
  })) }));
  const remainingOffers = snapshot.analysis.offers.filter(item => item.id !== offerId);
  const remainingVendorIds = new Set(remainingOffers.map(item => item.vendorId));
  const removedOfferIds = new Set(snapshot.analysis.offers.filter(activeOffer => activeOffer.id === offerId).map(activeOffer => activeOffer.id));
  const selectedId = snapshot.selectedOfferId && removedOfferIds.has(snapshot.selectedOfferId)
    ? null : snapshot.selectedOfferId;
  const profileTable = snapshot.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.find(isVendorProfileTable);
  const workbook = snapshot.workbook ? {
    ...snapshot.workbook,
    cells: snapshot.workbook.cells.filter(cell => !removedCells.has(cell.cellId)),
    tables: snapshot.workbook.tables.map(table => table.tableId !== vendorTable!.id ? table : {
      ...table, columnWidths: table.columnWidths.filter(column => column.id !== workbookOffer!.columnId && !(table.tableId === profileTable?.id && column.id === profileTable.columns.find(item => item.label === removedColumnLabel)?.id)),
    }),
    offers: snapshot.workbook.offers.filter(item => item.offerId !== offerId),
    selections: { INU: snapshot.workbook.selections.INU && removedOfferIds.has(snapshot.workbook.selections.INU) ? null : snapshot.workbook.selections.INU,
      SOLAR_BAWAH: snapshot.workbook.selections.SOLAR_BAWAH && removedOfferIds.has(snapshot.workbook.selections.SOLAR_BAWAH) ? null : snapshot.workbook.selections.SOLAR_BAWAH },
    configuration: snapshot.workbook.configuration ? { ...snapshot.workbook.configuration, version: id<"policy">(),
      units: snapshot.workbook.configuration.units.filter(unit => !removedCells.has(unit.cellId)),
      selectionDependentCellIds: snapshot.workbook.configuration.selectionDependentCellIds.filter(cellId => !removedCells.has(cellId)) } : null,
  } : undefined;
  const formulaIds = new Set(snapshot.formulas.filter(formula => removedCells.has(formula.targetCellId)).map(formula => formula.id));
  return changeWorkbook(snapshot, {
    selectedOfferId: selectedId,
    worksheets: tables,
    formulas: snapshot.formulas.filter(formula => !formulaIds.has(formula.id)),
    mappings: snapshot.mappings.filter(mapping => !removedMappings.has(mapping.id)),
    analysis: { ...snapshot.analysis, vendors: snapshot.analysis.vendors.filter(vendor => remainingVendorIds.has(vendor.id)), offers: remainingOffers },
    profiles: Object.fromEntries(Object.entries(snapshot.profiles).map(([profile, value]) => [profile, {
      ...value, cellIds: value.cellIds.filter(cellId => !removedCells.has(cellId)), formulaIds: value.formulaIds.filter(formulaId => !formulaIds.has(formulaId)),
    }])) as unknown as WorkbookSnapshot["profiles"],
    ...(workbook ? { workbook } : {}),
  });
}

export function prepareVendorColumns(s: WorkbookSnapshot): WorkbookSnapshot {
  if (!s.workbook) return s;
  s = ensureVendorProfileTable(s);
  const table = s.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.find(item => !isVendorProfileTable(item));
  if (!table) return s;
  let next = s;
  for (const [index, columnId] of table.columnOrder.slice(1).entries()) {
    if (next.workbook!.offers.some(o => o.columnId === columnId)) continue;
    const header = table.cells.find(c => c.columnId === columnId && s.workbook!.cells.some(p => p.cellId === c.id && /^[A-Z]+9$/.test(p.address)));
    const name = header?.source.kind === "INPUT" && header.source.input.kind === "TEXT" ? header.source.input.text.trim() : "";
    next = addSheetVendor(next, name || `Vendor ${index + 1}`, (["C", "D", "E"] as const)[Math.min(index, 2)]!, columnId);
  }
  const vendorColumn = table.columnOrder.slice(1).find(columnId => next.workbook!.offers.findIndex(offer => offer.columnId === columnId) === 1);
  if (!vendorColumn) return next;
  const pbbkb = next.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.flatMap(t => t.cells).find(cell =>
    cell.columnId === vendorColumn && next.workbook!.cells.some(presentation => presentation.cellId === cell.id && presentation.address.endsWith("12")));
  if (!pbbkb || pbbkb.source.kind !== "FORMULA") return next;
  const formulaId = pbbkb.source.formulaId;
  const formula = next.formulas.find(item => item.id === formulaId);
  if (formula?.sourceKind !== "WORKBOOK_SOURCE" || formula.provenance?.address !== "D12") return next;
  const formulaIds = new Set([formulaId]);
  return changeWorkbook(next, {
    formulas: next.formulas.filter(item => !formulaIds.has(item.id)),
    worksheets: next.worksheets.map(worksheet => ({ ...worksheet, tables: worksheet.tables.map(table => ({ ...table,
      cells: table.cells.map(cell => cell.id === pbbkb.id ? { ...cell, source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } } : cell),
    })) })),
    workbook: { ...next.workbook!, cells: next.workbook!.cells.map(cell => cell.cellId === pbbkb.id ? { ...cell, kind: "INPUT" as const } : cell) },
  });
}

export function editSheetInput(s: WorkbookSnapshot, cell: CellSnapshot, input: CellInput) {
  requireCondition(s.workbook && cell.source.kind === "INPUT", "Sel bukan input.");
  requireSolarCostEditable(s, cell);
  validateAhsVolumeInput(s, cell, input);
  const meta = s.workbook.cells.find(p => p.cellId === cell.id);
  requireCondition(!meta || meta.kind !== "RESULT", "Sel ini dihitung atau dikelola sistem.");
  const offer = s.workbook.offers.find(o => o.columnId === cell.columnId);
  if (offer && input.kind === "NUMERIC_TEXT") requireCondition(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(input.text.trim()), "Harga vendor harus berupa angka manual.");
  let analysis = s.analysis, workbook = s.workbook;
  if (offer) {
    const current = analysis.offers.find(r => r.id === offer.offerId)!;
    const values = current.values.filter(v => v.label !== cell.id);
    values.push({ id: current.values.find(v => v.label === cell.id)?.id ?? id<"offer-value">(), label: cell.id, input });
    analysis = { ...analysis, vendors: cell.id === offer.nameCellId && input.kind === "TEXT" ? analysis.vendors.map(v => v.id === analysis.offers.find(o => o.id === offer.offerId)?.vendorId ? { ...v, name: input.text.trim() || "Vendor" } : v) : analysis.vendors, offers: analysis.offers.map(activeOffer => activeOffer.id === current.id ? { ...activeOffer, values } : activeOffer) };
  }
  workbook = { ...workbook, cells: workbook.cells.map(p => p.cellId === cell.id && p.kind === "BLANK" ? { ...p, kind: "INPUT" } : p) };
  return changeWorkbook(s, { analysis, workbook, worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t, cells: t.cells.map(c => c.id === cell.id ? { ...c, source: { kind: "INPUT", input } } : c) })) })) });
}

export function selectSheetOffer(s: WorkbookSnapshot, selectionId: StableId<"offer">, actorId: StableId<"user">, profile = s.activeProfile) {
  if (s.workbook) {
    const table = s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.find(t => t.cells.some(c => c.scope === profile));
    requireCondition(table, "Tabel Konversi tidak ditemukan.");
    if (!table.rows.some(row => row.label === "BPH")) {
      const beforeTotal = table.cells.find(cell => s.workbook!.cells.some(p => p.cellId === cell.id && p.address === `C${profile === "INU" ? 35 : 34}`));
      requireCondition(beforeTotal, "Baris PPN OAT Konversi tidak ditemukan.");
      s = addRow(s, table.id, { label: "BPH", scope: profile, afterRowId: beforeTotal.rowId });
      const updated = s.worksheets.flatMap(w => w.tables).find(t => t.id === table.id)!;
      const added = updated.cells.filter(cell => updated.rows.some(row => row.id === cell.rowId && row.label === "BPH"));
      const labelCell = added.find(cell => updated.columns.find(col => col.id === cell.columnId)?.label === "B")!;
      const priceCell = added.find(cell => updated.columns.find(col => col.id === cell.columnId)?.label === "C")!;
      requireCondition(labelCell && priceCell, "Kolom BPH Konversi tidak ditemukan.");
      s = changeWorkbook(s, { worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => t.id !== table.id ? t : { ...t,
        cells: t.cells.map(cell => cell.id === labelCell.id ? { ...cell, source: { kind: "INPUT" as const, input: { kind: "TEXT" as const, text: "BPH" } } } : cell) }) })),
        workbook: { ...s.workbook!, cells: s.workbook!.cells.map(p => p.cellId === labelCell.id ? { ...p, kind: "LABEL" as const } : p.cellId === priceCell.id ? { ...p, unit: "IDR/L" as const } : p),
          configuration: s.workbook!.configuration ? { ...s.workbook!.configuration, version: id<"policy">(), units: s.workbook!.configuration.units.map(unit => unit.cellId === priceCell.id ? { ...unit, symbol: "IDR/L", dimensions: units["IDR/L"] } : unit) } : null } });
    }
  } else if (!s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.some(t => t.cells.some(c => c.scope === profile && t.rows.some(r => r.id === c.rowId && r.label === "Harga INU · BPH")))) {
    s = appendField(s, "KONVERSI_JAGAD", profile, "Harga INU · BPH", { kind: "UNSET" }).snapshot;
  }
  const activeOffer = s.analysis.offers.find(r => r.id === selectionId);
  const column = s.workbook?.offers.find(o => o.offerId === activeOffer?.id);
  requireCondition(activeOffer && (!s.workbook || column), "Penawaran tidak ada dalam worksheet ini.");
  const fields = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(cell => ({ cell, stage: w.stage,
    label: t.rows.find(row => row.id === cell.rowId)?.label ?? "" }))));
  const base = fields.find(field => field.cell.id === column?.baseCellId)?.cell;
  const vendorTable = s.worksheets.flatMap(w => w.tables).find(table => table.id === base?.tableId);
  const offset = profile === "SOLAR_BAWAH" ? 1 : 0;
  const mappings = [...s.mappings];
  const writers = new Map<string, CellSnapshot["source"]>();
  for (const [label, sourceRow, targetRow] of [["Nama vendor", 9, 27], ["Harga Dasar", 10, 30], ["PPN", 11, 31],
    ["PBBKB", 12, 32], ["PPH", 13, 33], ["OAT", 14, 34], ["PPN OAT", 15, 35], ["BPH", 16, 0], ["TOTAL", 17, 36]] as const) {
    const sourceCellId = column ? vendorTable?.cells.find(cell => cell.columnId === column.columnId &&
      s.workbook!.cells.some(p => p.cellId === cell.id && Number(p.address.match(/\d+$/)?.[0]) === sourceRow))?.id
      : fields.find(field => field.stage === "EVALUASI_VENDOR" && field.label.endsWith(`|vendor:${activeOffer.id}:${label}`))?.cell.id;
    const targetCellId = s.workbook ? fields.find(field => field.stage === "KONVERSI_JAGAD" && field.cell.scope === profile &&
      (label === "BPH" ? field.label === "BPH" && s.worksheets.flatMap(w => w.tables).some(t => t.columns.some(c => c.id === field.cell.columnId && c.label === "C")) :
        s.workbook!.cells.some(p => p.cellId === field.cell.id && p.address === `C${targetRow - offset}`)))?.cell.id
      : fields.find(field => field.stage === "KONVERSI_JAGAD" && field.cell.scope === profile &&
        field.label === (label === "Nama vendor" ? "Nama supplier" : `Harga INU · ${label === "TOTAL" ? "ALL IN" : label}`))?.cell.id;
    if (label === "Nama vendor" && !targetCellId && !s.workbook) continue;
    requireCondition(sourceCellId && targetCellId, `Sumber/target komponen ${label} tidak ditemukan.`);
    const unit = label === "Nama vendor" ? "1" : "IDR/L";
    const prior = mappings.find(m => m.targetCellId === targetCellId), mappingId = prior?.id ?? id<"mapping">();
    if (prior) mappings.splice(mappings.indexOf(prior), 1);
    mappings.push(prior?.sourceComponent === `vendor-live:${activeOffer.id}:${sourceCellId}` && prior.provenance.sourceRef === activeOffer.id ? prior : { id: mappingId, analysisId: s.analysisId, scope: profile, sourceCellId, targetCellId,
      sourceComponent: `vendor-live:${activeOffer.id}:${sourceCellId}`, sourceUnit: unit, targetUnit: unit, transformExpression: null, status: "ACTIVE",
      provenance: { actorId, sourceRef: activeOffer.id, reason: "Pilihan vendor manual pada worksheet" } });
    writers.set(targetCellId, { kind: "MAPPING", mappingId });
  }
  let extraAnchorRowId: StableId<"row"> | undefined;
  const extraRowOrder: StableId<"row">[] = [];
  for (const component of vendorComponents(s, activeOffer.id).filter(component => !vendorComponentRoles.some(role => role === component.role))) {
    if (s.workbook?.cells.some(p => p.cellId === component.source.id && p.unit === "text")) {
      s = changeWorkbook(s, { workbook: { ...s.workbook, cells: s.workbook.cells.map(p => p.cellId === component.source.id ? { ...p, unit: "IDR/L" as const } : p),
        configuration: s.workbook.configuration ? { ...s.workbook.configuration, version: id<"policy">(), units: s.workbook.configuration.units.map(unit => unit.cellId === component.source.id ? { ...unit, symbol: "IDR/L", dimensions: units["IDR/L"] } : unit) } : null } });
    }
    const key = `vendor-extra:${component.labelCell?.id ?? component.source.id}`;
    let targetCellId = s.workbook ? s.workbook.bindings.find(b => b.profile === profile && b.key === key)?.cellId
      : s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.flatMap(t => t.cells.filter(c => c.scope === profile && t.rows.some(row => row.id === c.rowId && row.label === `Harga INU · ${key}`)))[0]?.id;
    if (!targetCellId && s.workbook) {
      const table = s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")!.tables.find(t => t.cells.some(c => c.scope === profile))!;
      const anchor = table.cells.find(c => s.workbook!.cells.some(p => p.cellId === c.id && p.address === `C${36 - offset}`))!;
      s = addRow(s, table.id, { label: key, scope: profile, afterRowId: extraAnchorRowId ?? anchor.rowId });
      const updated = s.worksheets.flatMap(w => w.tables).find(t => t.id === table.id)!;
      targetCellId = updated.cells.find(c => updated.rows.some(row => row.id === c.rowId && row.label === key) && updated.columns.some(col => col.id === c.columnId && col.label === "C"))!.id;
      s = changeWorkbook(s, { workbook: { ...s.workbook!, bindings: [...s.workbook!.bindings, { profile, key, cellId: targetCellId }],
        cells: s.workbook!.cells.map(p => p.cellId === targetCellId ? { ...p, unit: "IDR/L" as const } : p),
        configuration: s.workbook!.configuration ? { ...s.workbook!.configuration, version: id<"policy">(), units: s.workbook!.configuration.units.map(unit => unit.cellId === targetCellId ? { ...unit, symbol: "IDR/L", dimensions: units["IDR/L"] } : unit) } : null } });
    } else if (!targetCellId) {
      const added = appendField(s, "KONVERSI_JAGAD", profile, `Harga INU · ${key}`, { kind: "UNSET" });
      s = added.snapshot; targetCellId = added.cellId;
    }
    extraAnchorRowId = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(c => c.id === targetCellId)?.rowId;
    if (extraAnchorRowId) extraRowOrder.push(extraAnchorRowId);
    const prior = mappings.find(m => m.targetCellId === targetCellId), mappingId = prior?.id ?? id<"mapping">();
    if (prior) mappings.splice(mappings.indexOf(prior), 1);
    mappings.push(prior?.sourceComponent === `vendor-live:${activeOffer.id}:${component.source.id}` && prior.provenance.sourceRef === activeOffer.id ? prior : { id: mappingId, analysisId: s.analysisId, scope: profile,
      sourceCellId: component.source.id, targetCellId, sourceComponent: `vendor-live:${activeOffer.id}:${component.source.id}`, sourceUnit: "IDR/L", targetUnit: "IDR/L", transformExpression: null, status: "ACTIVE",
      provenance: { actorId, sourceRef: activeOffer.id, reason: "Komponen vendor terpilih mengikuti worksheet aktif" } });
    writers.set(targetCellId, { kind: "MAPPING", mappingId });
  }
  const obsolete = new Set(mappings.filter(mapping => mapping.scope === profile && mapping.sourceComponent.startsWith("vendor-live:") && !writers.has(mapping.targetCellId)).map(mapping => mapping.id));
  const formulas = s.formulas.filter(formula => !writers.has(formula.targetCellId));
  const retainedFormulaIds = new Set(formulas.map(formula => formula.id));
  return prepareSolarCosts(changeWorkbook(s, { selectedOfferId: profile === s.activeProfile ? selectionId : s.selectedOfferId, mappings: mappings.filter(mapping => !obsolete.has(mapping.id)), formulas,
    profiles: { ...s.profiles, [profile]: { ...s.profiles[profile], formulaIds: s.profiles[profile].formulaIds.filter(id => retainedFormulaIds.has(id)) } },
    worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => {
      const total = t.cells.find(c => c.scope === profile && s.workbook?.cells.some(p => p.cellId === c.id && p.address === `C${36 - offset}`));
      const order = total && extraRowOrder.length ? t.rowOrder.filter(rowId => !extraRowOrder.includes(rowId)) : t.rowOrder;
      const rowOrder = total && extraRowOrder.length ? order.flatMap(rowId => rowId === total.rowId ? [...extraRowOrder, rowId] : [rowId]) : order;
      return { ...t, rowOrder, cells: t.cells.map(c => writers.has(c.id) ? { ...c, source: writers.get(c.id)! }
        : c.source.kind === "MAPPING" && obsolete.has(c.source.mappingId) ? { ...c, source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } } : c) };
    }) })),
    ...(s.workbook ? { workbook: { ...s.workbook, selections: { ...s.workbook.selections, [profile]: selectionId } } } : {}) }));
}

// Rebuild source links from current vendor columns, preserving manual vendor choices.
export function prepareSelectedVendorMappings(s: WorkbookSnapshot, actorId: StableId<"user">) {
  s = prepareProjectLocation(s, actorId);
  for (const profile of s.workbook ? PROFILES : [s.activeProfile]) {
    const selectionId = s.workbook ? s.workbook.selections[profile] : s.selectedOfferId;
    if (selectionId) {
      s = selectSheetOffer(s, selectionId, actorId, profile);
    }
  }
  return prepareSolarCosts(s);
}

function prepareProjectLocation(s: WorkbookSnapshot, actorId: StableId<"user">) {
  const fields = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(cell => ({ cell, stage: w.stage,
    label: t.rows.find(row => row.id === cell.rowId)?.label }))));
  const source = fields.find(field => field.stage === "EVALUASI_VENDOR" && (s.workbook
    ? s.workbook.cells.some(p => p.cellId === field.cell.id && p.address === "D7") : field.label === "Lokasi"))?.cell;
  requireCondition(source, "Lokasi detail proyek Evaluasi Vendor tidak ditemukan.");
  const targets = fields.filter(field => field.stage === "KONVERSI_JAGAD" && (s.workbook
    ? s.workbook.cells.some(p => p.cellId === field.cell.id && p.address === (field.cell.scope === "INU" ? "C26" : "C25")) : field.label === "Lokasi"));
  const targetIds = new Set(targets.map(field => field.cell.id));
  const mappings = [...s.mappings];
  for (const { cell } of targets) {
    requireCondition(cell.scope !== "SHARED", "Lokasi Konversi harus berada dalam profil.");
    const component = `project-location-live:${source.id}`;
    const prior = mappings.find(mapping => mapping.targetCellId === cell.id);
    if (prior?.sourceComponent === component && cell.source.kind === "MAPPING" && cell.source.mappingId === prior.id) continue;
    if (prior) mappings.splice(mappings.indexOf(prior), 1);
    const unit = s.workbook ? "1" : "IDR/L";
    mappings.push({ id: prior?.id ?? id<"mapping">(), analysisId: s.analysisId, scope: cell.scope,
      sourceCellId: source.id, targetCellId: cell.id, sourceComponent: component, sourceUnit: unit, targetUnit: unit,
      transformExpression: null, status: "ACTIVE", provenance: { actorId, sourceRef: null, reason: "Lokasi mengikuti detail proyek Evaluasi Vendor" } });
  }
  const formulas = s.formulas.filter(formula => !targetIds.has(formula.targetCellId));
  const retained = new Set(formulas.map(formula => formula.id));
  return changeWorkbook(s, { mappings, formulas,
    profiles: { INU: { ...s.profiles.INU, formulaIds: s.profiles.INU.formulaIds.filter(id => retained.has(id)) },
      SOLAR_BAWAH: { ...s.profiles.SOLAR_BAWAH, formulaIds: s.profiles.SOLAR_BAWAH.formulaIds.filter(id => retained.has(id)) } },
    worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t, cells: t.cells.map(cell => targetIds.has(cell.id)
      ? { ...cell, source: { kind: "MAPPING" as const, mappingId: mappings.find(mapping => mapping.targetCellId === cell.id)!.id } } : cell) })) })) });
}

export function changeSheetProfile(s: WorkbookSnapshot, profile: typeof PROFILES[number]) {
  return changeWorkbook(s, { activeProfile: profile, selectedOfferId: s.workbook ? s.workbook.selections[profile] : s.selectedOfferId });
}
