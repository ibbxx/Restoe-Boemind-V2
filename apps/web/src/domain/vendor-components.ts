import type { CellSnapshot, WorkbookSnapshot } from "./contracts.ts";
import { createStableId as id, parseStableId } from "./ids.ts";
import { appendField, changeWorkbook } from "./workflow.ts";
import { addRow, setCellFormula } from "./structure.ts";
import { requireCondition } from "./validation.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import { parseFormula, references } from "../engine/parser.ts";
import type { Ast } from "../engine/parser.ts";
import { displayCellId } from "./cell-address.ts";
import { refreshCurrentOffers } from "./current-offers.ts";

export const vendorComponentRoles = ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN OAT", "BPH", "TOTAL"] as const;
export interface VendorComponent {
  source: CellSnapshot;
  labelCell: CellSnapshot | undefined;
  role: string;
}

export function vendorComponents(s: WorkbookSnapshot, offerId: string): VendorComponent[] {
  const tables = s.worksheets.filter(w => w.stage === "EVALUASI_VENDOR").flatMap(w => w.tables);
  const column = s.workbook?.offers.find(offer => offer.offerId === offerId);
  const components: VendorComponent[] = [];
  for (const table of tables) for (const rowId of table.rowOrder) {
    const row = table.rows.find(row => row.id === rowId)!;
    const marker = `|vendor:${offerId}:`;
    const source = table.cells.find(cell => cell.rowId === rowId && (column ? cell.columnId === column.columnId : row.label.includes(marker)));
    if (!source) continue;
    const address = s.workbook?.cells.find(p => p.cellId === source.id)?.address ?? row.label.split("|")[0];
    const number = Number(address?.match(/\d+$/)?.[0]);
    const labelCell = column ? table.cells.find(cell => cell.rowId === rowId && cell.columnId === table.columnOrder[0])
      : tables.flatMap(t => t.cells.filter(cell => t.rows.some(r => r.id === cell.rowId && r.label === `@EV!B${number}|caption`)))[0];
    const extra = number > 18 || !Number.isFinite(number);
    const hasLabel = labelCell?.source.kind !== "INPUT" || (labelCell.source.input.kind !== "UNSET" && !!labelCell.source.input.text.trim());
    const generated = row.label.startsWith("component:") || row.label.includes(`|vendor:${offerId}:component:`);
    if (!(number >= 10 && number <= 17) && !(extra && labelCell && (hasLabel || generated))) continue;
    const role = number >= 10 && number <= 17 ? vendorComponentRoles[number - 10]! : source.id;
    components.push({ source, labelCell, role });
  }
  return [...components.filter(component => component.role !== "TOTAL"), ...components.filter(component => component.role === "TOTAL")];
}

export function removableVendorComponents(s: WorkbookSnapshot): VendorComponent[] {
  const offer = s.analysis.offers[0];
  return offer ? vendorComponents(s, offer.id).filter(component => component.labelCell && !vendorComponentRoles.some(role => role === component.role)) : [];
}

function formulaText(ast: Ast): string {
  switch (ast.kind) {
    case "number": return ast.text;
    case "text": return `"${ast.text.replaceAll('"', '""')}"`;
    case "reference": return `@{${ast.id}}`;
    case "aggregate": return `#{${ast.id}}`;
    case "sum": return `SUM(${ast.args.map(formulaText).join(",")})`;
    case "binary": return `(${formulaText(ast.left)}${ast.operator}${formulaText(ast.right)})`;
    case "unary": return ast.operator === "%" ? `(${formulaText(ast.operand)})%` : `${ast.operator}(${formulaText(ast.operand)})`;
  }
}

function removeAddend(ast: Ast, cellIds: ReadonlySet<string>, address: string): Ast | null {
  if (ast.kind === "reference" && cellIds.has(ast.id)) return null;
  if (ast.kind === "sum") {
    const args = ast.args.map(arg => removeAddend(arg, cellIds, address)).filter((arg): arg is Ast => arg !== null);
    return args.length ? { ...ast, args } : null;
  }
  if (ast.kind === "binary" && ast.operator === "+") {
    const left = removeAddend(ast.left, cellIds, address), right = removeAddend(ast.right, cellIds, address);
    return left && right ? { ...ast, left, right } : left ?? right;
  }
  requireCondition(!references(ast, () => []).some(id => cellIds.has(id)), `Perbaiki formula ${address}: uraian digunakan di luar penjumlahan langsung.`);
  return ast;
}

export function removeFormulaAddends(expression: string, cellIds: ReadonlySet<string>, address: string): string {
  return formulaText(removeAddend(parseFormula(expression), cellIds, address) ?? { kind: "number", text: "0" });
}

export function removeVendorComponent(snapshot: WorkbookSnapshot, componentId: string, configuration: EngineConfiguration): WorkbookSnapshot {
  const component = removableVendorComponents(snapshot).find(component => component.labelCell?.id === componentId);
  requireCondition(component, "Hanya uraian tambahan yang dapat dihapus.");
  const components = snapshot.analysis.offers.flatMap(offer => vendorComponents(snapshot, offer.id).filter(item => item.labelCell?.id === componentId));
  const tables = snapshot.worksheets.flatMap(w => w.tables);
  const sourceIds = new Set(components.map(item => item.source.id));
  const removing = new Set([...sourceIds, component.labelCell!.id]);
  const totalIds = new Set(snapshot.analysis.offers.flatMap(offer => vendorComponents(snapshot, offer.id).filter(item => item.role === "TOTAL").map(item => item.source.id)));
  const key = `vendor-extra:${componentId}`;
  const targetIds = new Set(snapshot.workbook?.bindings.filter(binding => binding.key === key).map(binding => binding.cellId));
  for (const table of tables) {
    const rows = new Set(table.cells.filter(cell => removing.has(cell.id) || targetIds.has(cell.id) ||
      table.rows.some(row => row.id === cell.rowId && (row.label === `Harga INU · ${key}` || row.label === `Biaya · ${key}`))).map(cell => cell.rowId));
    table.cells.filter(cell => rows.has(cell.rowId)).forEach(cell => removing.add(cell.id));
  }
  requireCondition(!snapshot.workbook?.bindings.some(binding => removing.has(binding.cellId) && binding.key !== key) &&
    !Object.values(snapshot.profiles).some(profile => removing.has(profile.hppBase.cellId)), "Penghapusan menyentuh sel inti workbook.");
  requireCondition(!configuration.aggregates.some(aggregate => aggregate.memberCellIds.some(id => removing.has(id))), "Uraian masih dipakai agregat perhitungan; lepaskan referensinya terlebih dahulu.");
  requireCondition(!snapshot.mappings.some(mapping => removing.has(mapping.sourceCellId) && !removing.has(mapping.targetCellId)), "Uraian masih dipakai mapping lain.");
  const formulas = snapshot.formulas.filter(formula => !removing.has(formula.targetCellId)).map(formula => {
    if (!formula.referenceCellIds.some(id => removing.has(id))) return formula;
    const address = displayCellId(formula.targetCellId, snapshot);
    requireCondition(totalIds.has(formula.targetCellId), `Uraian masih dipakai formula ${address}; ubah referensinya terlebih dahulu.`);
    const ast = removeAddend(parseFormula(formula.expression), removing, address) ?? { kind: "number" as const, text: "0" };
    return { ...formula, expression: formulaText(ast), referenceCellIds: [...new Set(references(ast, aggregateId =>
      configuration.aggregates.find(aggregate => aggregate.id === aggregateId)?.memberCellIds ?? []))].map(id => parseStableId<"cell">(id)) };
  });
  const worksheets = snapshot.worksheets.map(w => ({ ...w, tables: w.tables.flatMap(table => {
    const removedRows = new Set(table.cells.filter(cell => removing.has(cell.id)).map(cell => cell.rowId));
    if (!removedRows.size) return [table];
    const rows = table.rows.filter(row => !removedRows.has(row.id));
    if (!rows.length) return [];
    requireCondition(!table.merges.some(merge => {
      const anchor = table.cells.find(cell => cell.id === merge.anchorCellId)!;
      const start = table.rowOrder.indexOf(anchor.rowId);
      return table.rowOrder.slice(start, start + merge.rowSpan).some(rowId => removedRows.has(rowId));
    }), "Uraian masih berada dalam sel gabungan; pisahkan sel terlebih dahulu.");
    return [{ ...table, rows, rowOrder: table.rowOrder.filter(rowId => !removedRows.has(rowId)), cells: table.cells.filter(cell => !removing.has(cell.id)) }];
  }) }));
  const retainedFormulaIds = new Set(formulas.map(formula => formula.id));
  const profiles = { ...snapshot.profiles };
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) profiles[profile] = { ...profiles[profile],
    cellIds: profiles[profile].cellIds.filter(id => !removing.has(id)), formulaIds: profiles[profile].formulaIds.filter(id => retainedFormulaIds.has(id)) };
  const nextConfiguration = { ...configuration, version: id<"policy">(), units: configuration.units.filter(unit => !removing.has(unit.cellId)),
    selectionDependentCellIds: configuration.selectionDependentCellIds.filter(id => !removing.has(id)) };
  const updated = changeWorkbook(snapshot, { worksheets, formulas, profiles, mappings: snapshot.mappings.filter(mapping => !removing.has(mapping.sourceCellId) && !removing.has(mapping.targetCellId)),
    ...(snapshot.workbook ? { workbook: { ...snapshot.workbook, bindings: snapshot.workbook.bindings.filter(binding => !removing.has(binding.cellId)), configuration: nextConfiguration } } : {}) });
  // Refresh current vendor records before legacy materialization can recreate deleted rows.
  return refreshCurrentOffers(updated);
}

export function addVendorComponent(snapshot: WorkbookSnapshot, rawName: string) {
  const name = rawName.trim();
  requireCondition(name, "Nama uraian wajib diisi.");
  requireCondition(snapshot.analysis.offers.length > 0, "Siapkan vendor terlebih dahulu.");
  const inventory = snapshot.analysis.offers.map(offer => ({ offer, components: vendorComponents(snapshot, offer.id) }));
  const label = (component: VendorComponent) => component.labelCell?.source.kind === "INPUT" && component.labelCell.source.input.kind !== "UNSET"
    ? component.labelCell.source.input.text : component.role;
  requireCondition(!inventory.some(item => item.components.some(component => label(component).trim().toLocaleLowerCase("id-ID") === name.toLocaleLowerCase("id-ID"))), "Nama uraian sudah digunakan.");
  const totals = inventory.map(({ offer, components }) => {
    const vendorName = snapshot.analysis.vendors.find(vendor => vendor.id === offer.vendorId)?.name ?? offer.label;
    const total = components.find(component => component.role === "TOTAL")?.source;
    requireCondition(total, `TOTAL ${vendorName} tidak ditemukan.`);
    const source = total.source;
    const expression = source.kind === "FORMULA" ? snapshot.formulas.find(formula => formula.id === source.formulaId && formula.activation === "ACTIVE")?.expression
      : source.kind === "INPUT" && source.input.kind === "NUMERIC_TEXT" ? source.input.text : undefined;
    requireCondition(expression?.trim(), `Perbaiki TOTAL ${vendorName} sebelum menambah uraian.`);
    return { offer, total, expression };
  });
  let s = snapshot;
  const number = Math.max(21, ...snapshot.worksheets.filter(w => w.stage === "EVALUASI_VENDOR").flatMap(w => w.tables.flatMap(t => t.cells.map(cell => {
    const address = snapshot.workbook?.cells.find(p => p.cellId === cell.id)?.address ?? t.rows.find(row => row.id === cell.rowId)?.label.split("|")[0];
    return Number(address?.match(/\d+$/)?.[0]) || 0;
  })))) + 1;
  const key = `component:${id<"row">()}`;
  const addedCells = new Map<string, CellSnapshot>();
  if (s.workbook) {
    const table = s.worksheets.find(w => w.stage === "EVALUASI_VENDOR")!.tables.find(t => t.cells.some(cell => cell.id === totals[0]!.total.id))!;
    const totalIndex = table.rowOrder.indexOf(totals[0]!.total.rowId);
    requireCondition(totalIndex > 0, "Posisi TOTAL tidak valid.");
    s = addRow(s, table.id, { label: key, scope: "SHARED", afterRowId: table.rowOrder[totalIndex - 1]! });
    const updated = s.worksheets.flatMap(w => w.tables).find(t => t.id === table.id)!;
    const row = updated.rows.find(row => row.label === key)!;
    const cells = updated.cells.filter(cell => cell.rowId === row.id);
    const labelCell = cells.find(cell => cell.columnId === updated.columnOrder[0])!;
    for (const binding of s.workbook!.offers) addedCells.set(binding.offerId, cells.find(cell => cell.columnId === binding.columnId)!);
    const newIds = new Set(cells.map(cell => cell.id));
    const vendorColumns = new Map(s.workbook!.offers.map(binding => [binding.columnId,
      s.workbook!.cells.find(p => p.cellId === binding.baseCellId)!.address.replace(/\d+$/, "")]));
    const presentation = s.workbook!.cells.map(p => {
      const cell = cells.find(cell => cell.id === p.cellId);
      return !cell ? p : { ...p, address: `${cell.id === labelCell.id ? "B" : vendorColumns.get(cell.columnId)}${number}`,
        kind: "INPUT" as const, unit: cell.id === labelCell.id ? "text" as const : "IDR/L" as const, align: cell.id === labelCell.id ? "left" as const : "right" as const };
    });
    s = changeWorkbook(s, { worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => t.id !== table.id ? t : { ...t,
      cells: t.cells.map(cell => cell.id === labelCell.id ? { ...cell, source: { kind: "INPUT" as const, input: { kind: "TEXT" as const, text: name } } } : cell) }) })),
      workbook: { ...s.workbook!, cells: presentation, configuration: s.workbook!.configuration ? { ...s.workbook!.configuration, version: id<"policy">(),
        units: s.workbook!.configuration.units.map(unit => newIds.has(unit.cellId) ? { ...unit, symbol: unit.cellId === labelCell.id ? "1" : "IDR/L", dimensions: unit.cellId === labelCell.id ? {} : { money: 1, volume: -1 } } : unit) } : null } });
  } else {
    s = appendField(s, "EVALUASI_VENDOR", "SHARED", `@EV!B${number}|caption`, { kind: "TEXT", text: name }).snapshot;
    for (const [index, { offer, components }] of inventory.entries()) {
      let column = "", position = index + 3;
      while (position > 0) { position--; column = String.fromCharCode(65 + position % 26) + column; position = Math.floor(position / 26); }
      const existing = components[0]?.source;
      const existingLabel = s.worksheets.flatMap(w => w.tables).find(t => t.id === existing?.tableId)?.rows.find(row => row.id === existing?.rowId)?.label;
      column = /^@EV!([A-Z]+)/.exec(existingLabel ?? "")?.[1] ?? column;
      const added = appendField(s, "EVALUASI_VENDOR", "SHARED", `@EV!${column}${number}|vendor:${offer.id}:${key}`, { kind: "UNSET" });
      s = added.snapshot;
      addedCells.set(offer.id, s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(cell => cell.id === added.cellId)!);
    }
  }
  for (const { offer, total, expression } of totals) s = setCellFormula(s, total.id, `(${expression})+@{${addedCells.get(offer.id)!.id}}`);
  return { snapshot: s, firstCellId: addedCells.get(inventory[0]!.offer.id)!.id };
}

export function includeNewVendorComponentTotals(s: WorkbookSnapshot, offerId: string): WorkbookSnapshot {
  const components = vendorComponents(s, offerId);
  const total = components.find(component => component.role === "TOTAL")?.source;
  if (!total) return s;
  const source = total.source;
  const formula = source.kind === "FORMULA" ? s.formulas.find(f => f.id === source.formulaId) : undefined;
  const extra = components.filter(component => s.worksheets.flatMap(w => w.tables).some(table => table.cells.some(cell => cell.id === component.source.id &&
    table.rows.some(row => row.id === cell.rowId && (row.label.startsWith("component:") || row.label.includes(`|vendor:${offerId}:component:`))))) &&
    !formula?.referenceCellIds.includes(component.source.id));
  if (!extra.length) return s;
  const base = formula?.expression ?? (total.source.kind === "INPUT" && total.source.input.kind === "NUMERIC_TEXT" ? total.source.input.text : undefined);
  requireCondition(base, "TOTAL vendor baru belum siap.");
  return setCellFormula(s, total.id, `(${base})+SUM(${extra.map(component => `@{${component.source.id}}`).join(",")})`);
}
