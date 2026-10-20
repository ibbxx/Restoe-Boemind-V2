import type { AhsField, AhsGroup, AhsGroupSection, AhsItem, CellSnapshot, FormulaDefinition, TableSnapshot, WorkbookSnapshot } from "./contracts.ts";
import type { Profile } from "./profiles.ts";
import { createStableId as id, parseStableId } from "./ids.ts";
import { requireCondition, parseSnapshot } from "./validation.ts";
import { changeWorkbook } from "./workflow.ts";
import { ahsVolumeSource } from "./ahs-volume.ts";
import { sourceAddress, units } from "./procurement-template.ts";
import { parseFormula, references } from "../engine/parser.ts";
import { removeFormulaAddends } from "./vendor-components.ts";
import type { Ast } from "../engine/parser.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";

export const AHS_COST_GROUPS = [
  { label: "HPP", rows: ["Harga Dasar", "OAT", "PBBKB", "PPH INU 0,3%", "BPH Migas 0,25%"] },
  { label: "PAJAK", rows: ["PPN 11%", "PPH penjualan"] },
  { label: "COST OF FUND", rows: ["Investor", "Bunga Bank", "Diskonto SKBDN"] },
  { label: "OPERASIONAL", rows: ["Biaya Operasional", "Bonus Marketing"] },
  { label: "ASET", rows: ["Tangki Solar"] },
  { label: "KOORDINASI", rows: ["Ormas/Lainnya"] },
  { label: "RELASI", rows: ["Biaya Proyek", "Biaya Mediator"] },
  { label: "RESIKO", rows: ["Biaya Resiko", "Kenaikan Harga"] },
] as const;

const normalized = (name: string) => name.trim().toLocaleLowerCase("id-ID");
const cellsOf = (s: WorkbookSnapshot) => s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells));
export function ahsCell(s: WorkbookSnapshot, cellId: string | null) { return cellsOf(s).find(c => c.id === cellId); }

export function ahsLabel(s: WorkbookSnapshot, item: { readonly name: string; readonly labelCellId: string | null }): string {
  const source = ahsCell(s, item.labelCellId)?.source;
  return source?.kind === "INPUT" && source.input.kind === "TEXT" ? source.input.text : item.name;
}

export function ahsRoleCell(s: WorkbookSnapshot, profile: Profile, address: string, label: string) {
  const targets = new Set(s.workbook?.cells.filter(p => p.address === sourceAddress(address, profile)).map(p => p.cellId));
  const found = s.worksheets.filter(w => w.stage === "AHS").flatMap(w => w.tables.flatMap(t => t.cells.filter(c => c.scope === profile &&
    (s.workbook ? targets.has(c.id) : t.rows.some(r => r.id === c.rowId && r.label === label)))))[0];
  return found ?? (label === "HPP · Harga Dasar" ? ahsCell(s, s.profiles[profile].hppBase.cellId) : undefined);
}

export const ahsGroupSection = (group: AhsGroup): AhsGroupSection => group.section ?? "BIAYA";

export function ahsSectionOfCell(s: WorkbookSnapshot, cell: CellSnapshot): "INFORMASI" | "PENDAPATAN" | "BIAYA" | "LABA" {
  const field = s.ahsFields?.find(f => f.profile === cell.scope && ahsCell(s, f.valueCellId)?.rowId === cell.rowId);
  if (field) return field.section;
  for (const section of ["PENDAPATAN", "BIAYA"] as const) if (ahsGroups(s, s.activeProfile, section).some(g =>
    g.items.some(item => [item.priceCellId, item.volumeCellId, item.totalCellId, item.labelCellId].includes(cell.id) || ahsCell(s, item.priceCellId)?.rowId === cell.rowId))) return section;
  const table = s.worksheets.flatMap(w => w.tables).find(t => t.id === cell.tableId);
  const label = table?.rows.find(r => r.id === cell.rowId)?.label ?? "";
  const address = s.workbook?.cells.find(p => p.cellId === cell.id)?.address;
  const number = address ? Number(address.match(/\d+$/)?.[0]) + (cell.scope === "SOLAR_BAWAH" ? 1 : 0) : 0;
  if ((number >= 9 && number <= 13) || ["TOTAL PENDAPATAN", "HARGA JUAL SETELAH PAJAK"].includes(label)) return "PENDAPATAN";
  if ((number >= 14 && number <= 33) || ["TOTAL BIAYA", "BIAYA PER LITER"].includes(label)) return "BIAYA";
  if ((number >= 34 && number <= 38) || ["LABA KOTOR", "SELISIH PPN", "LABA BERSIH", "LABA BERSIH PER LITER", "PERSENTASE"].includes(label)) return "LABA";
  return "INFORMASI";
}

export function ahsGroups(s: WorkbookSnapshot, profile = s.activeProfile, section: AhsGroupSection = "BIAYA"): readonly AhsGroup[] {
  const stored = s.ahsGroups?.filter(g => g.profile === profile && ahsGroupSection(g) === section);
  if (stored?.length) return stored;
  let row = section === "BIAYA" ? 16 : 11;
  const catalogue = section === "BIAYA" ? AHS_COST_GROUPS : [{ label: "HARGA JUAL", rows: ["Harga Dasar", "PBBKB", "PPN 11%"] }];
  return catalogue.map(group => {
    const firstRow = row;
    const items = group.rows.map((name): AhsItem | null => {
      const label = `${section === "PENDAPATAN" ? "Harga Jual" : group.label} · ${name}`, number = row++;
      const price = ahsRoleCell(s, profile, `I${number}`, label);
      const volume = ahsRoleCell(s, profile, `J${number}`, label + " · Volume");
      const total = ahsRoleCell(s, profile, `K${number}`, label + " · Total");
      if (!price || !volume || !total) return null;
      return { name, builtin: true, labelCellId: ahsRoleCell(s, profile, `H${number}`, "")?.id ?? null,
        priceCellId: price.id, volumeCellId: volume.id, totalCellId: total.id };
    }).filter((item): item is AhsItem => item !== null);
    const labelCell = s.workbook ? ahsRoleCell(s, profile, `G${firstRow}`, "") : undefined;
    return { id: parseStableId<"ahs-group">(labelCell?.id ?? items[0]?.priceCellId), profile, name: group.label,
      builtin: true, labelCellId: labelCell?.id ?? null, items, ...(section === "PENDAPATAN" ? { section } : {}) };
  });
}

export function ahsFormula(s: WorkbookSnapshot, target: CellSnapshot, expression: string): FormulaDefinition {
  return { id: target.source.kind === "FORMULA" ? target.source.formulaId : id<"formula">(), targetCellId: target.id,
    expression, referenceCellIds: [...new Set(references(parseFormula(expression), aggregateId => {
      const aggregate = s.workbook?.configuration?.aggregates.find(a => a.id === aggregateId);
      requireCondition(aggregate, "Agregat AHS tidak ditemukan."); return aggregate.memberCellIds;
    }))].map(ref => parseStableId<"cell">(ref)), activation: "ACTIVE", sourceKind: "OPERATIONAL_OVERRIDE", provenance: null };
}

function totalExpression(s: WorkbookSnapshot, total: CellSnapshot) {
  const source = total.source;
  const expression = source.kind === "FORMULA" ? s.formulas.find(f => f.id === source.formulaId && f.activation === "ACTIVE")?.expression
    : source.kind === "INPUT" && source.input.kind === "NUMERIC_TEXT" ? source.input.text : undefined;
  requireCondition(expression && expression.trim(), "Perbaiki rumus total AHS sebelum mengubah uraian.");
  parseFormula(expression); return expression;
}

function dependsOn(s: WorkbookSnapshot, target: string, source: string): boolean {
  const definitions = new Map(s.formulas.map(f => [f.targetCellId as string, f.referenceCellIds as readonly string[]]));
  for (const mapping of s.mappings.filter(m => m.status === "ACTIVE")) definitions.set(mapping.targetCellId, [mapping.sourceCellId]);
  const pending = [...definitions.get(target) ?? []], seen = new Set<string>();
  while (pending.length) {
    const cell = pending.pop()!;
    if (cell === source) return true;
    if (seen.has(cell)) continue;
    seen.add(cell); pending.push(...definitions.get(cell) ?? []);
  }
  return false;
}

function rollupTargets(s: WorkbookSnapshot, section: AhsGroupSection) {
  const roles = section === "BIAYA" ? [["L14", "TOTAL BIAYA", "total"], ["L15", "BIAYA PER LITER", "price"]]
    : [["J8", "Harga Include", "price"], ["L10", "HARGA JUAL SETELAH PAJAK", "price"], ["L9", "TOTAL PENDAPATAN", "total"]];
  return roles.map(([address, label, member]) => {
    const cell = ahsRoleCell(s, s.activeProfile, address!, label!);
    requireCondition(cell, `Sel ${label} AHS tidak ditemukan.`);
    totalExpression(s, cell);
    return { cell, member };
  });
}

function additiveReferences(ast: Ast): readonly string[] | null {
  if (ast.kind === "reference") return [ast.id];
  const args = ast.kind === "sum" ? ast.args : ast.kind === "binary" && ast.operator === "+" ? [ast.left, ast.right] : null;
  if (!args) return null;
  const lists = args.map(additiveReferences);
  return lists.every(list => list !== null) ? lists.flatMap(list => list!) : null;
}

// Upgrade only a recognizable sum of the original cost rows; custom formulas remain authoritative.
export function prepareAhsRollups(s: WorkbookSnapshot): WorkbookSnapshot {
  const updates = new Map<string, FormulaDefinition>();
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
    const groups = s.ahsGroups?.filter(g => g.profile === profile && ahsGroupSection(g) === "BIAYA");
    if (!groups) continue;
    const extra = groups.flatMap(g => g.items.filter(item => !item.builtin).map(item => item.priceCellId));
    if (!extra.length) continue;
    const total = ahsRoleCell(s, profile, "L15", "BIAYA PER LITER");
    const definition = total && s.formulas.find(f => f.targetCellId === total.id && f.activation === "ACTIVE");
    if (!total || !definition) continue;
    const refs = additiveReferences(parseFormula(definition.expression));
    const base = groups.flatMap(g => g.items.filter(item => item.builtin).map(item => item.priceCellId));
    if (!refs || !base.every(id => refs.includes(id)) || refs.some(id => !base.includes(parseStableId<"cell">(id)) && !extra.includes(parseStableId<"cell">(id)))) continue;
    const missing = extra.filter(id => !refs.includes(id));
    requireCondition(!missing.some(id => dependsOn(s, id, total.id)), "Tambahan biaya merujuk BIAYA PER LITER dan akan membentuk siklus. Perbaiki rumus uraian terlebih dahulu.");
    if (missing.length) updates.set(total.id, ahsFormula(s, total, `(${definition.expression})+SUM(${missing.map(id => `@{${id}}`).join(",")})`));
  }
  if (!updates.size) return s;
  const formulas = s.formulas.map(f => updates.get(f.targetCellId) ?? f);
  return changeWorkbook(s, { formulas, worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
    cells: t.cells.map(c => updates.has(c.id) ? { ...c, source: { kind: "FORMULA" as const, formulaId: updates.get(c.id)!.id } } : c) })) })) });
}

function renameInput(cell: CellSnapshot, text: string): CellSnapshot {
  return { ...cell, source: { kind: "INPUT", input: { kind: "TEXT", text } } };
}

// Rebuild only category merges; the remaining workbook merges keep their stable anchors.
function groupMerges(table: TableSnapshot, groups: readonly AhsGroup[]): TableSnapshot {
  const category = table.columns.find(c => c.label === "G");
  if (!category) return table;
  const groupRows = new Set(groups.flatMap(g => g.items.map(item => table.cells.find(c => c.id === item.priceCellId)?.rowId)));
  const merges = table.merges.filter(m => {
    const anchor = table.cells.find(c => c.id === m.anchorCellId);
    if (!anchor || anchor.columnId !== category.id || !groupRows.has(anchor.rowId)) return true;
    requireCondition(m.colSpan === 1, "Pisahkan sel gabungan kelompok sebelum mengubah uraian AHS."); return false;
  });
  const labels = new Map<string, string>();
  const updatedGroups = groups.filter(g => g.items.some(item => table.cells.some(c => c.id === item.priceCellId)));
  for (const group of updatedGroups) {
    const rows = group.items.map(item => table.cells.find(c => c.id === item.priceCellId)!.rowId);
    const positions = rows.map(row => table.rowOrder.indexOf(row));
    requireCondition(positions.every((position, index) => position === positions[0]! + index), "Uraian kelompok AHS harus berurutan.");
    const anchor = table.cells.find(c => c.rowId === rows[0] && c.columnId === category.id)!;
    if (!group.builtin && anchor.source.kind === "INPUT" && anchor.source.input.kind === "TEXT" && !anchor.source.input.text)
      labels.set(anchor.id, group.name);
    if (rows.length > 1) merges.push({ id: id<"merge">(), anchorCellId: anchor.id, rowSpan: rows.length, colSpan: 1 });
  }
  return { ...table, merges, cells: table.cells.map(c => labels.has(c.id) ? renameInput(c, labels.get(c.id)!) : c) };
}

export function finishAhsChange(s: WorkbookSnapshot, tables: readonly TableSnapshot[], groups: readonly AhsGroup[], formulas: readonly FormulaDefinition[],
  presentations = s.workbook?.cells, configuration = s.workbook?.configuration, section: AhsGroupSection | null = "BIAYA", fields: readonly AhsField[] | undefined = s.ahsFields): WorkbookSnapshot {
  const cells = tables.flatMap(t => t.cells);
  const retained = new Set(cells.map(c => c.id));
  const originalTableIds = new Set(s.worksheets.flatMap(w => w.tables.map(t => t.id)));
  const profiles = { ...s.profiles };
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) profiles[profile] = { ...profiles[profile],
    cellIds: cells.filter(c => c.scope === profile).map(c => c.id),
    formulaIds: formulas.filter(f => cells.some(c => c.id === f.targetCellId && c.scope === profile)).map(f => f.id) };
  return changeWorkbook(s, { ...(section ? { ahsGroups: [...(s.ahsGroups ?? []).filter(g => g.profile !== s.activeProfile || ahsGroupSection(g) !== section), ...groups] } : {}),
    ...(fields ? { ahsFields: fields } : {}), profiles, formulas,
    worksheets: s.worksheets.map(w => ({ ...w, tables: tables.filter(t => w.tables.some(old => old.id === t.id) ||
      (w.stage === "AHS" && !originalTableIds.has(t.id))) })),
    ...(s.workbook ? { workbook: { ...s.workbook, cells: presentations!.filter(p => retained.has(p.cellId)),
      tables: tables.map(table => s.workbook!.tables.find(p => p.tableId === table.id) ?? { tableId: table.id, profile: s.activeProfile,
        rowHeights: table.rowOrder.map(id => ({ id, size: 24 })), columnWidths: table.columnOrder.map(id => ({ id, size: 101 })) }),
      configuration: configuration ? { ...configuration, version: id<"policy">(), units: configuration.units.filter(u => retained.has(u.cellId)) } : null } } : {}) });
}

export function addAhsItem(value: WorkbookSnapshot, groupId: string | null, rawName: string, rawGroupName = "", section: AhsGroupSection = "BIAYA"): WorkbookSnapshot {
  const s = prepareAhsRollups(parseSnapshot(value)), profile = s.activeProfile;
  const groups = ahsGroups(s, profile, section).map(g => ({ ...g, name: ahsLabel(s, g) })), name = rawName.trim(), groupName = rawGroupName.trim();
  requireCondition(name, "Nama uraian wajib diisi.");
  let group = groups.find(g => g.id === groupId);
  if (groupId) requireCondition(group, "Kelompok AHS tidak ditemukan pada profil aktif.");
  else {
    requireCondition(groupName, "Nama kelompok wajib diisi.");
    requireCondition(!groups.some(g => normalized(ahsLabel(s, g)) === normalized(groupName)), "Nama kelompok sudah digunakan.");
  }
  requireCondition(!group?.items.some(item => normalized(ahsLabel(s, item)) === normalized(name)), "Nama uraian sudah digunakan dalam kelompok ini.");
  const volumeSource = ahsVolumeSource(s, profile);
  requireCondition(volumeSource, "Sumber Volume AHS tidak ditemukan.");
  const targets = rollupTargets(s, section);
  const tables = s.worksheets.flatMap(w => w.tables);
  const last = group?.items.at(-1) ?? groups.at(-1)?.items.at(-1);
  const anchor = last && ahsCell(s, last.priceCellId);
  let table = s.workbook ? tables.find(t => t.id === anchor?.tableId) : tables.find(t => t.rows.some(r => r.label === "ahs-extra") && t.cells[0]?.scope === profile);
  if (!table) {
    requireCondition(!s.workbook, "Tabel AHS tidak ditemukan.");
    table = { id: id<"table">(), rows: [], columns: ["G", "H", "I", "J", "K", "L"].map(label => ({ id: id<"column">(), label })), rowOrder: [], columnOrder: [], cells: [], merges: [] };
    table = { ...table, columnOrder: table.columns.map(c => c.id) };
  }
  const rowId = id<"row">();
  const newCells: CellSnapshot[] = table.columns.map(column => ({ id: id<"cell">(), tableId: table!.id, rowId, columnId: column.id, scope: profile,
    source: { kind: "INPUT", input: { kind: "TEXT", text: "" } } }));
  const at = (label: string) => newCells.find(c => c.columnId === table!.columns.find(column => column.label === label)?.id)!;
  requireCondition(["G", "H", "I", "J", "K", "L"].every(label => at(label)), "Kolom AHS tidak lengkap.");
  const item: AhsItem = { name, builtin: false, labelCellId: at("H").id, priceCellId: at("I").id, volumeCellId: at("J").id, totalCellId: at("K").id };
  const volumeFormula = ahsFormula(s, at("J"), `@{${volumeSource.id}}`);
  const itemFormula = ahsFormula(s, at("K"), `@{${item.priceCellId}}*@{${item.volumeCellId}}`);
  const addedFormulas = [volumeFormula, itemFormula, ...targets.filter(target => !targets.some(other => other.cell.id !== target.cell.id && dependsOn(s, target.cell.id, other.cell.id)))
    .map(target => ahsFormula(s, target.cell, `(${totalExpression(s, target.cell)})+@{${target.member === "price" ? item.priceCellId : item.totalCellId}}`))];
  const newSources = new Map(addedFormulas.map(f => [f.targetCellId, { kind: "FORMULA" as const, formulaId: f.id }]));
  const insert = anchor?.tableId === table.id ? table.rowOrder.indexOf(anchor.rowId) + 1 : table.rowOrder.length;
  const rows = [...table.rowOrder]; rows.splice(insert, 0, rowId);
  table = { ...table, rows: [...table.rows, { id: rowId, label: s.workbook ? `ahs-item:${rowId}` : "ahs-extra" }], rowOrder: rows,
    cells: [...table.cells, ...newCells.map(c => c.id === item.labelCellId ? renameInput(c, name) : c.id === item.priceCellId
      ? { ...c, source: { kind: "INPUT" as const, input: { kind: "NUMERIC_TEXT" as const, text: "0" } } } : c)],
    merges: [...table.merges, { id: id<"merge">(), anchorCellId: at("K").id, rowSpan: 1, colSpan: 2 }] };
  if (group) {
    const index = groups.indexOf(group); group = { ...group, name: ahsLabel(s, group), items: [...group.items, item] }; groups[index] = group;
  } else {
    group = { id: id<"ahs-group">(), profile, section, name: groupName, builtin: false, labelCellId: at("G").id, items: [item] }; groups.push(group);
  }
  const updatedTables = (tables.some(t => t.id === table!.id) ? tables.map(t => t.id === table!.id ? table! : t) : [...tables, table]).map(groupMergesOnce);
  function groupMergesOnce(t: TableSnapshot) {
    // Legacy base fields live in separate one-cell tables; only the added grid has category columns.
    const merged = s.workbook || t.id === table!.id ? groupMerges(t, groups.filter(g => g.items.every(item => t.cells.some(c => c.id === item.priceCellId)))) : t;
    return { ...merged, cells: merged.cells.map(c => newSources.has(c.id) ? { ...c, source: newSources.get(c.id)! } : c) };
  }
  const rowNumber = Math.max(42, ...s.workbook?.cells.map(p => Number(p.address.match(/\d+$/)?.[0]) || 0) ?? []) + 1;
  const presentations = s.workbook ? [...s.workbook.cells, ...newCells.map(c => {
    const column = table!.columns.find(column => column.id === c.columnId)!.label;
    const unit = column === "I" ? "IDR/L" as const : column === "J" ? "L" as const : column === "K" ? "IDR" as const : "text" as const;
    return { cellId: c.id, address: column + rowNumber, kind: newSources.has(c.id) ? "RESULT" as const : unit === "text" ? "LABEL" as const : "INPUT" as const,
      tone: section === "BIAYA" ? "red" as const : "green" as const, bold: column === "G", align: unit === "text" ? "left" as const : "right" as const, unit };
  })] : undefined;
  const configuration = s.workbook?.configuration;
  return finishAhsChange(s, updatedTables, groups, [...s.formulas.filter(f => !newSources.has(f.targetCellId)), ...addedFormulas], presentations,
    configuration ? { ...configuration, units: [...configuration.units, ...presentations!.filter(p => newCells.some(c => c.id === p.cellId)).map(p =>
      ({ cellId: p.cellId, symbol: p.unit === "text" ? "1" : p.unit, dimensions: units[p.unit] }))] } : configuration, section);
}

export function renameAhsEntry(s: WorkbookSnapshot, groupId: string, itemId: string | null, rawName: string, section: AhsGroupSection = "BIAYA"): WorkbookSnapshot {
  const groups = [...ahsGroups(s, s.activeProfile, section)], group = groups.find(g => g.id === groupId), name = rawName.trim();
  requireCondition(group && name, "Nama dan kelompok AHS wajib diisi.");
  const item = itemId ? group.items.find(item => item.priceCellId === itemId) : null;
  requireCondition(itemId ? item && !item.builtin : !group.builtin, "Komponen bawaan AHS tidak dapat diubah namanya.");
  requireCondition(itemId ? !group.items.some(other => other.priceCellId !== itemId && normalized(ahsLabel(s, other)) === normalized(name))
    : !groups.some(other => other.id !== groupId && normalized(ahsLabel(s, other)) === normalized(name)), "Nama sudah digunakan.");
  const target = item ?? group, labelId = target.labelCellId;
  requireCondition(labelId, "Sel nama AHS tidak ditemukan.");
  const cell = ahsCell(s, labelId)!;
  requireCondition(cell.source.kind === "INPUT", "Nama masih berupa rumus; ubah melalui formula bar.");
  const updated = groups.map(g => g.id !== groupId ? g : item ? { ...g, items: g.items.map(other => other === item ? { ...other, name } : other) } : { ...g, name });
  return finishAhsChange(s, s.worksheets.flatMap(w => w.tables.map(t => ({ ...t, cells: t.cells.map(c => c.id === labelId ? renameInput(c, name) : c) }))), updated, s.formulas, undefined, undefined, section);
}

export function removeAhsEntry(s: WorkbookSnapshot, groupId: string, itemId: string | null, configuration: EngineConfiguration, section: AhsGroupSection = "BIAYA"): WorkbookSnapshot {
  s = prepareAhsRollups(s);
  const groups = [...ahsGroups(s, s.activeProfile, section)], group = groups.find(g => g.id === groupId);
  requireCondition(group, "Kelompok AHS tidak ditemukan.");
  const items = itemId ? group.items.filter(item => item.priceCellId === itemId) : [...group.items];
  requireCondition(items.length && items.every(item => !item.builtin) && (itemId || !group.builtin), "Komponen bawaan AHS tidak dapat dihapus.");
  requireCondition(itemId === null || group.items.length > 1 || !group.builtin, "Kelompok bawaan tidak dapat dikosongkan.");
  const tables = s.worksheets.flatMap(w => w.tables);
  const removedRows = new Set(items.map(item => ahsCell(s, item.priceCellId)!.rowId));
  const removing = new Set(tables.flatMap(t => t.cells.filter(c => removedRows.has(c.rowId)).map(c => c.id)));
  const targets = rollupTargets(s, section);
  requireCondition(!configuration.aggregates.some(a => a.memberCellIds.some(id => removing.has(id))) &&
    !configuration.selectionDependentCellIds.some(id => removing.has(id)) &&
    !s.mappings.some(m => removing.has(m.sourceCellId) || removing.has(m.targetCellId)), "Uraian masih digunakan mapping atau agregat.");
  requireCondition(!s.workbook?.bindings.some(b => removing.has(b.cellId)) && !Object.values(s.profiles).some(p => removing.has(p.hppBase.cellId)), "Sel inti AHS tidak dapat dihapus.");
  const changed = targets.filter(target => s.formulas.some(f => f.targetCellId === target.cell.id && f.referenceCellIds.some(ref => removing.has(ref))))
    .map(target => ahsFormula(s, target.cell, removeFormulaAddends(totalExpression(s, target.cell), removing, "Total AHS")));
  const writers = new Map(changed.map(f => [f.targetCellId, f]));
  for (const f of s.formulas) if (!removing.has(f.targetCellId) && !writers.has(f.targetCellId))
    requireCondition(!f.referenceCellIds.some(id => removing.has(id)), "Uraian masih digunakan rumus lain; lepaskan referensinya terlebih dahulu.");
  const remaining = group.items.filter(item => !items.includes(item));
  let updated = groups.filter(g => g.id !== group.id || remaining.length).map(g => g.id !== group.id ? g : { ...g, name: ahsLabel(s, g), items: remaining });
  const movedLabels = new Map<string, string>();
  if (remaining.length && group.labelCellId && removing.has(group.labelCellId)) {
    const nextPrice = ahsCell(s, remaining[0]!.priceCellId)!;
    const table = tables.find(t => t.id === nextPrice.tableId)!;
    const label = table.cells.find(c => c.rowId === nextPrice.rowId && c.columnId === table.columns.find(col => col.label === "G")?.id)!;
    movedLabels.set(label.id, ahsLabel(s, group));
    updated = updated.map(g => g.id === group.id ? { ...g, labelCellId: label.id } : g);
  }
  const nextTables = tables.flatMap(t => {
    const category = t.columns.find(c => c.label === "G")?.id;
    const merges = t.merges.filter(m => {
      const anchor = t.cells.find(c => c.id === m.anchorCellId)!;
      const start = t.rowOrder.indexOf(anchor.rowId);
      if (!t.rowOrder.slice(start, start + m.rowSpan).some(row => removedRows.has(row))) return true;
      requireCondition((anchor.columnId === category && m.colSpan === 1) || (m.rowSpan === 1 && removing.has(anchor.id)), "Pisahkan sel gabungan sebelum menghapus uraian."); return false;
    });
    const table = { ...t, rows: t.rows.filter(r => !removedRows.has(r.id)), rowOrder: t.rowOrder.filter(row => !removedRows.has(row)), merges,
      cells: t.cells.filter(c => !removing.has(c.id)).map(c => writers.has(c.id) ? { ...c, source: { kind: "FORMULA" as const, formulaId: writers.get(c.id)!.id } }
        : movedLabels.has(c.id) ? renameInput(c, movedLabels.get(c.id)!) : c) };
    return table.rows.length ? [groupMerges(table, updated.filter(g => g.items.every(item => table.cells.some(c => c.id === item.priceCellId))))] : [];
  });
  return finishAhsChange(s, nextTables, updated, [...s.formulas.filter(f => !removing.has(f.targetCellId) && !writers.has(f.targetCellId)), ...changed], undefined, undefined, section);
}
