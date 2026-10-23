import type { AhsGroup, CellPresentation, CellSnapshot, FormulaDefinition, TableSnapshot, WorkbookSnapshot } from "./contracts.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { PROFILES } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { canonicalJson } from "./snapshots.ts";
import { compileGraph } from "../engine/graph.ts";
import { createStableId as id } from "./ids.ts";
import { canvasCellAddresses, columnName } from "./canvas-address.ts";
import { ahsGroups, ahsLabel, ahsRoleCell } from "./ahs-groups.ts";
import { changeWorkbook } from "./workflow.ts";
import { requireCondition } from "./validation.ts";
import { addRow, setCellFormula, setCellInput } from "./structure.ts";
import { units } from "./procurement-template.ts";

export function externalCellIds(s: WorkbookSnapshot): ReadonlySet<string> {
  return new Set(s.worksheets.filter(w => w.stage === "AHS_EXTERNAL").flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))));
}
export { externalCellAddresses as externalAddresses } from "./canvas-address.ts";
function rewriteReferences(expression: string, transform: (ref: string) => string): string {
  return expression.split(/("(?:[^"]|"")*")/g).map((part, index) => index % 2 ? part : part.replace(/@\{([0-9a-f-]+)\}/gi, (_, ref: string) => transform(ref))).join("");
}
function coordinate(address: string | undefined) {
  const match = /^([A-Z]+)(\d+)$/.exec(address ?? "");
  if (!match) return null;
  return { column: [...match[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1, row: Number(match[2]) - 1 };
}
export async function internalAhsFingerprint(s: WorkbookSnapshot, configuration: EngineConfiguration, run: EngineRun, profile: Profile) {
  requireCondition(run.snapshotId === s.id, "Tunggu perhitungan Internal terbaru sebelum menyalin.");
  const results = new Map(run.results.map(result => [result.cellId, result]));
  const tables = s.worksheets.filter(w => w.stage === "AHS").flatMap(w => w.tables).filter(t => t.cells.some(c => c.scope === profile)).map(table => ({
    ...table, cells: table.cells.filter(c => c.scope === profile).map(cell => {
      const formula = s.formulas.find(f => f.targetCellId === cell.id && f.activation === "ACTIVE");
      const result = results.get(cell.id);
      return { ...cell, source: cell.source.kind === "INPUT" ? cell.source : formula ? { kind: "FORMULA", expression: formula.expression, referenceCellIds: formula.referenceCellIds } : { kind: "MAPPING" },
        result: !result ? null : "value" in result ? { status: result.status, value: result.value, unit: result.unit } : "text" in result ? { status: result.status, text: result.text } : { status: result.status, code: result.code } };
    }),
  }));
  const ids = new Set(tables.flatMap(t => t.cells.map(c => c.id)));
  const payload = canonicalJson({ tables, decimal: configuration.decimal, units: configuration.units.filter(u => ids.has(u.cellId)) });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

type SourceFingerprints = NonNullable<NonNullable<WorkbookSnapshot["externalAhs"]>["sourceFingerprints"]>;
export function createExternalAhs(s: WorkbookSnapshot, configuration: EngineConfiguration, run: EngineRun, fingerprints: SourceFingerprints = {}) {
  requireCondition(!s.worksheets.some(w => w.stage === "AHS_EXTERNAL"), "AHS Eksternal sudah dibuat.");
  return copyExternalAhs(s, configuration, run, PROFILES, fingerprints);
}

export function refreshExternalAhs(s: WorkbookSnapshot, configuration: EngineConfiguration, run: EngineRun, fingerprint: string) {
  const profile = s.activeProfile;
  requireCondition(s.externalAhs, "AHS Eksternal belum dibuat.");
  const removedTables = new Set(s.worksheets.filter(w => w.stage === "AHS_EXTERNAL").flatMap(w => w.tables).filter(t => t.cells.some(c => c.scope === profile)).map(t => t.id));
  const removed = new Set<string>(s.worksheets.flatMap(w => w.tables).filter(t => removedTables.has(t.id)).flatMap(t => t.cells.map(c => c.id)));
  requireCondition(removed.size > 0, "AHS Eksternal profil ini belum tersedia.");
  const graph = compileGraph(s, configuration);
  requireCondition([...graph.nodes.values()].every(node => removed.has(node.cell.id) || node.dependencies.every(ref => !removed.has(ref))) &&
    s.formulas.every(f => removed.has(f.targetCellId) || f.referenceCellIds.every(ref => !removed.has(ref))) &&
    s.mappings.every(m => removed.has(m.targetCellId) || !removed.has(m.sourceCellId)), "Sel Eksternal masih dipakai di luar profil yang akan diganti.");
  const removedAggregates = configuration.aggregates.filter(a => a.memberCellIds.some(cell => removed.has(cell)));
  requireCondition(removedAggregates.every(a => a.memberCellIds.every(cell => removed.has(cell))) &&
    s.formulas.every(f => removed.has(f.targetCellId) || removedAggregates.every(a => !f.expression.includes(a.id))), "Agregat Eksternal masih dipakai di luar profil yang akan diganti.");
  requireCondition(!s.workbook?.bindings.some(b => removed.has(b.cellId)), "Sel Eksternal masih dipakai oleh binding workbook.");
  const nextConfig = { ...configuration, units: configuration.units.filter(u => !removed.has(u.cellId)),
    aggregates: configuration.aggregates.filter(a => !removedAggregates.includes(a)), selectionDependentCellIds: configuration.selectionDependentCellIds.filter(cell => !removed.has(cell)) };
  const cleaned: WorkbookSnapshot = { ...s, formulas: s.formulas.filter(f => !removed.has(f.targetCellId)), mappings: s.mappings.filter(m => !removed.has(m.targetCellId)),
    worksheets: s.worksheets.map(w => w.stage !== "AHS_EXTERNAL" ? w : { ...w, tables: w.tables.filter(t => !removedTables.has(t.id)) }),
    externalAhs: { ...s.externalAhs, cells: s.externalAhs.cells.filter(c => !removed.has(c.cellId)), groups: s.externalAhs.groups.filter(g => g.profile !== profile), fields: s.externalAhs.fields.filter(f => f.profile !== profile) },
    ...(s.workbook ? { workbook: { ...s.workbook, configuration: nextConfig, cells: s.workbook.cells.filter(c => !removed.has(c.cellId)), tables: s.workbook.tables.filter(t => !removedTables.has(t.tableId)) } } : {}) };
  return copyExternalAhs(cleaned, nextConfig, run, [profile], { [profile]: fingerprint });
}

function copyExternalAhs(s: WorkbookSnapshot, configuration: EngineConfiguration, run: EngineRun, profilesToCopy: readonly Profile[], fingerprints: SourceFingerprints) {
  requireCondition(run.snapshotId === s.id, "Tunggu perhitungan Internal terbaru sebelum menyalin.");
  const byResult = new Map(run.results.map(r => [r.cellId, r]));
  const internal = s.worksheets.filter(w => w.stage === "AHS").flatMap(w => w.tables.flatMap(t => t.cells));
  const oldMeta = new Map<string, CellPresentation>(s.workbook?.cells.map(p => [p.cellId, p]));
  const oldUnits = new Map(configuration.units.map(u => [u.cellId, u]));
  const textIds = new Set(PROFILES.flatMap(profile => [...ahsGroups(s, profile, "PENDAPATAN"), ...ahsGroups(s, profile)].flatMap(g => [...(g.labelCellId ? [g.labelCellId] : []), ...g.items.flatMap(i => i.labelCellId ? [i.labelCellId] : [])])));
  for (const field of s.ahsFields ?? []) { textIds.add(field.labelCellId); if (field.valueType === "TEXT") textIds.add(field.valueCellId); }
  for (const table of s.worksheets.find(w => w.stage === "AHS")?.tables ?? []) for (const cell of table.cells) {
    const label = table.rows.find(row => row.id === cell.rowId)?.label ?? "";
    if (label.endsWith("|template:text") || ["Tgl Analisis (Rn)", "Sumber", "Marketing", "Lokasi", "Pembayaran", "Dokumen", "Notes", "AHS_RIGHT_LABEL"].includes(label)) textIds.add(cell.id);
  }


  const sourceMap = new Map<string, CellSnapshot>();
  const tables: TableSnapshot[] = [], presentations: CellPresentation[] = [];
  const newUnits: EngineConfiguration["units"][number][] = [];
  let incomplete = 0;
  for (const profile of profilesToCopy) {
    const addresses = canvasCellAddresses(s, profile);
    const title = ahsRoleCell(s, profile, "G3", "");
    const sale = ahsRoleCell(s, profile, "I11", "Harga Jual · Harga Dasar");
    const notes = ahsRoleCell(s, profile, "G39", "Notes");
    const saleAt = coordinate(addresses.get(sale?.id ?? ""));
    const titleAt = coordinate(addresses.get(title?.id ?? ""));
    const noteAt = coordinate(addresses.get(notes?.id ?? ""));
    requireCondition(saleAt && noteAt, "Struktur AHS Internal tidak lengkap.");
    const left = titleAt?.column ?? saleAt.column - 2;
    const top = titleAt?.row ?? 0;
    const discount = ahsRoleCell(s, profile, "I25", "COST OF FUND · Diskonto SKBDN");
    const discountRow = coordinate(addresses.get(discount?.id ?? ""))?.row;
    const selected = internal.filter(c => {
      const at = coordinate(addresses.get(c.id));
      return c.scope === profile && at && at.column >= left && at.column < left + 6 && at.row >= top && at.row <= noteAt.row;
    });
    const sourceRows = [...new Set(selected.map(c => coordinate(addresses.get(c.id))!.row))].sort((a, b) => a - b);
    const tableId = id<"table">();
    const columns = Array.from({ length: 6 }, (_, i) => ({ id: id<"column">(), label: columnName(i) }));
    const roleRow = (address: string, label: string) => coordinate(addresses.get(ahsRoleCell(s, profile, address, label)?.id ?? ""))?.row ?? -1;
    const costs = roleRow("I16", "HPP · Harga Dasar"), gross = roleRow("L34", "LABA KOTOR");
    const summaryRows = new Map([[roleRow("L14", "TOTAL BIAYA"), "TOTAL BIAYA"], [roleRow("L15", "BIAYA PER LITER"), "BIAYA PER LITER"], [roleRow("L9", "TOTAL PENDAPATAN"), "TOTAL PENDAPATAN"], [roleRow("J8", "Harga Include"), "HARGA INCLUDE"], [roleRow("L10", "HARGA JUAL SETELAH PAJAK"), "HARGA JUAL SETELAH PAJAK"], [gross, "LABA KOTOR"]]);
    const rows = sourceRows.map((r, index) => ({ id: id<"row">(), label: `external|${r}|${r === discountRow ? "external-hidden" : index === 0 ? "ahs-title" : ["TOTAL BIAYA", "BIAYA PER LITER"].includes(summaryRows.get(r) ?? "") ? "cost-row cost-total" : ["TOTAL PENDAPATAN", "HARGA JUAL SETELAH PAJAK"].includes(summaryRows.get(r) ?? "") ? "income-row income-total" : r >= noteAt.row ? "ahs-notes" : r >= gross && gross >= 0 ? "profit-row" : r >= costs && costs >= 0 ? "cost-row" : r >= saleAt.row ? "income-row" : "ahs-meta"}|${summaryRows.get(r) ?? ""}` }));
    const cells: CellSnapshot[] = [];
    for (const [ri, row] of rows.entries()) for (const [ci, column] of columns.entries()) {
      const source = selected.find(c => { const at = coordinate(addresses.get(c.id))!; return at.row === sourceRows[ri] && at.column === left + ci; });
      const cell: CellSnapshot = { id: id<"cell">(), tableId, rowId: row.id, columnId: column.id, scope: profile, source: { kind: "INPUT", input: { kind: "TEXT", text: "" } } };
      if (source) sourceMap.set(source.id, cell);
      cells.push(cell);
      const originalUnit = source && oldUnits.get(source.id);
      const unit: CellPresentation["unit"] = source && textIds.has(source.id) ? "text" : source ? oldMeta.get(source.id)?.unit ?? (source.source.kind === "INPUT" && source.source.input.kind === "TEXT" ? "text" : originalUnit?.symbol === "L" ? "L" : originalUnit?.symbol === "IDR" ? "IDR" : originalUnit?.symbol === "1" ? "1" : "IDR/L") : "text";
      presentations.push({ cellId: cell.id, address: `EXTERNAL!${columnName(ci)}${ri + 1}`, kind: "INPUT", tone: oldMeta.get(source?.id ?? "")?.tone ?? "plain", bold: oldMeta.get(source?.id ?? "")?.bold ?? ci < 2, align: oldMeta.get(source?.id ?? "")?.align ?? (ci < 2 ? "left" : "right"), unit });
      newUnits.push({ cellId: cell.id, symbol: unit === "text" ? "1" : unit, dimensions: units[unit] });
    }
    // Preserve the visible horizontal spans; category cells retain their vertical span.
    const merges: TableSnapshot["merges"][number][] = [];
    const vertical = new Map<string, number>();
    for (const group of [...ahsGroups(s, profile, "PENDAPATAN"), ...ahsGroups(s, profile)]) {
      const anchor = group.labelCellId && sourceMap.get(group.labelCellId);
      if (anchor) {
        const span = new Set(group.items.map(i => sourceMap.get(i.priceCellId)?.rowId).filter(Boolean)).size;
        if (span > 1) { vertical.set(anchor.id, span); merges.push({ id: id<"merge">(), anchorCellId: anchor.id, colSpan: 1, rowSpan: span }); }
      }
    }
    if (s.workbook) {
      for (const old of s.worksheets.find(w => w.stage === "AHS")!.tables.filter(t => t.cells.some(c => c.scope === profile))) for (const merge of old.merges) {
        const anchor = sourceMap.get(merge.anchorCellId);
        if (!anchor || vertical.has(anchor.id)) continue;
        const oldAnchor = old.cells.find(c => c.id === merge.anchorCellId)!;
        const start = old.rowOrder.indexOf(oldAnchor.rowId);
        const count = old.rowOrder.slice(start, start + merge.rowSpan).filter(rowId => selected.some(c => c.rowId === rowId)).length;
        if (count) merges.push({ ...merge, id: id<"merge">(), anchorCellId: anchor.id, rowSpan: count });
      }
    } else {
      for (const [ri, row] of rows.entries()) {
        const occupied = selected.filter(c => coordinate(addresses.get(c.id))!.row === sourceRows[ri]).map(c => coordinate(addresses.get(c.id))!.column - left).sort((a, b) => a - b);
        for (const [index, ci] of occupied.entries()) {
          const span = (occupied[index + 1] ?? 6) - ci;
          const anchor = cells.find(c => c.rowId === row.id && c.columnId === columns[ci]!.id)!;
          if (span > 1 && !vertical.has(anchor.id)) merges.push({ id: id<"merge">(), anchorCellId: anchor.id, rowSpan: 1, colSpan: span });
        }
      }
    }
    tables.push({ id: tableId, rows, columns, rowOrder: rows.map(r => r.id), columnOrder: columns.map(c => c.id), cells, merges });
  }
  const formulas: FormulaDefinition[] = [];
  for (const source of internal) {
    const cell = sourceMap.get(source.id);
    if (!cell) continue;
    const formula = s.formulas.find(f => f.targetCellId === source.id && f.activation === "ACTIVE");
    if (formula && formula.referenceCellIds.every(ref => sourceMap.has(ref)) && !formula.expression.includes("#{")) {
      const formulaId = id<"formula">();
      formulas.push({ ...formula, id: formulaId, targetCellId: cell.id, expression: rewriteReferences(formula.expression, ref => `@{${sourceMap.get(ref)!.id}}`), referenceCellIds: formula.referenceCellIds.map(ref => sourceMap.get(ref)!.id), sourceKind: "OPERATIONAL_OVERRIDE", provenance: null });
      (cell as { source: CellSnapshot["source"] }).source = { kind: "FORMULA", formulaId };
    } else if (source.source.kind === "INPUT") {
      (cell as { source: CellSnapshot["source"] }).source = source.source;
    } else {
      const result = byResult.get(source.id);
      const input = result?.status === "VALUE" || result?.status === "ZERO" ? { kind: "NUMERIC_TEXT" as const, text: result.value } : result?.status === "TEXT" ? { kind: "TEXT" as const, text: result.text } : { kind: "UNSET" as const };
      if (input.kind === "UNSET") incomplete++;
      (cell as { source: CellSnapshot["source"] }).source = { kind: "INPUT", input };
    }
  }
  const groups: AhsGroup[] = profilesToCopy.flatMap(profile => [...ahsGroups(s, profile, "PENDAPATAN"), ...ahsGroups(s, profile)].flatMap(g => {
    const items = g.items.filter(i => [i.priceCellId, i.volumeCellId, i.totalCellId, ...(i.labelCellId ? [i.labelCellId] : [])].every(ref => sourceMap.has(ref))).map(i => ({ ...i, labelCellId: i.labelCellId ? sourceMap.get(i.labelCellId)!.id : null, priceCellId: sourceMap.get(i.priceCellId)!.id, volumeCellId: sourceMap.get(i.volumeCellId)!.id, totalCellId: sourceMap.get(i.totalCellId)!.id }));
    return items.length ? [{ ...g, id: id<"ahs-group">(), labelCellId: g.labelCellId ? sourceMap.get(g.labelCellId)?.id ?? null : null, items }] : [];
  }));
  const fields = (s.ahsFields ?? []).filter(f => sourceMap.has(f.labelCellId) && sourceMap.has(f.valueCellId)).map(f => ({ ...f, labelCellId: sourceMap.get(f.labelCellId)!.id, valueCellId: sourceMap.get(f.valueCellId)!.id }));
  const allCells = [...s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)), ...tables.flatMap(t => t.cells)];
  requireCondition(allCells.length <= 10000, "Jumlah sel melebihi batas perhitungan; kurangi struktur sebelum membuat Eksternal.");
  const allFormulas = [...s.formulas, ...formulas];
  const profiles = { ...s.profiles };
  for (const p of PROFILES) profiles[p] = { ...profiles[p], cellIds: allCells.filter(c => c.scope === p).map(c => c.id), formulaIds: allFormulas.filter(f => allCells.some(c => c.id === f.targetCellId && c.scope === p)).map(f => f.id) };
  const nextConfig = { ...configuration, version: id<"policy">(), units: [...configuration.units, ...newUnits] };
  const worksheets = s.worksheets.some(w => w.stage === "AHS_EXTERNAL") ? s.worksheets.map(w => w.stage !== "AHS_EXTERNAL" ? w : { ...w, tables: [...w.tables, ...tables] })
    : [...s.worksheets, { id: id<"worksheet">(), stage: "AHS_EXTERNAL" as const, label: "AHS Eksternal", tables }];
  const sourceFingerprints = { ...s.externalAhs?.sourceFingerprints, ...fingerprints };
  const snapshot = changeWorkbook(s, { profiles, formulas: allFormulas, externalAhs: { cells: [...(s.externalAhs?.cells ?? []), ...presentations], groups: [...(s.externalAhs?.groups ?? []), ...groups], fields: [...(s.externalAhs?.fields ?? []), ...fields],
    ...(Object.keys(sourceFingerprints).length ? { sourceFingerprints } : {}) }, worksheets, ...(s.workbook ? { workbook: { ...s.workbook, configuration: nextConfig, cells: [...s.workbook.cells, ...presentations], tables: [...s.workbook.tables, ...tables.map(t => ({ tableId: t.id, profile: t.cells[0]!.scope, rowHeights: t.rows.map(r => ({ id: r.id, size: 30 })), columnWidths: t.columns.map((c, i) => ({ id: c.id, size: i === 1 ? 190 : 110 })) }))] } } : {}) });
  return { snapshot, configuration: nextConfig, incomplete };
}

export function addExternalAhsItem(s: WorkbookSnapshot, configuration: EngineConfiguration, name: string, section: "PENDAPATAN" | "BIAYA", groupId: string | null, groupName: string) {
  requireCondition(name.trim(), "Nama uraian wajib diisi.");
  const available = s.externalAhs?.groups.filter(g => g.profile === s.activeProfile && (g.section ?? "BIAYA") === section) ?? [];
  const group = available.find(g => g.id === groupId);
  requireCondition(groupId === null ? groupName.trim() : group, "Pilih kelompok atau isi nama kelompok baru.");
  const normalized = (text: string) => text.trim().toLocaleLowerCase("id-ID");
  requireCondition(group || !available.some(g => normalized(ahsLabel(s, g)) === normalized(groupName)), "Nama kelompok sudah digunakan.");
  requireCondition(!group?.items.some(item => normalized(ahsLabel(s, item)) === normalized(name)), "Nama uraian sudah digunakan dalam kelompok ini.");
  const table = s.worksheets.find(w => w.stage === "AHS_EXTERNAL")?.tables.find(t => t.cells.some(c => c.scope === s.activeProfile));
  requireCondition(table && s.externalAhs, "AHS Eksternal belum dibuat.");
  const before = table.rows.find(r => r.label.endsWith(section === "BIAYA" ? "|LABA KOTOR" : "|TOTAL BIAYA"));
  const lastItem = group?.items.at(-1);
  const previous = lastItem ? table.cells.find(c => c.id === lastItem.priceCellId)?.rowId : before ? table.rowOrder[table.rowOrder.indexOf(before.id) - 1] : table.rowOrder.at(-1);
  let next = addRow(s, table.id, { label: `external|extra|${section === "BIAYA" ? "cost-row" : "income-row"}`, scope: s.activeProfile, afterRowId: previous ?? null });
  const updated = next.worksheets.flatMap(w => w.tables).find(t => t.id === table.id)!;
  const rowId = updated.rowOrder.find(r => !table.rowOrder.includes(r))!;
  const cells = updated.columnOrder.map(columnId => updated.cells.find(c => c.rowId === rowId && c.columnId === columnId)!);
  const [category, label, price, volume, total] = cells;
  const presentations: CellPresentation[] = cells.map((cell, i) => ({ cellId: cell.id, address: "", kind: "INPUT", tone: "plain", bold: i < 2, align: i < 2 ? "left" : "right", unit: i < 2 ? "text" : i === 2 ? "IDR/L" : i === 3 ? "L" : "IDR" }));
  const item = { name: name.trim(), builtin: false, labelCellId: label!.id, priceCellId: price!.id, volumeCellId: volume!.id, totalCellId: total!.id };
  const groups = group ? s.externalAhs.groups.map(g => g.id === group.id ? { ...g, items: [...g.items, item] } : g) : [...s.externalAhs.groups, { id: id<"ahs-group">(), profile: s.activeProfile, section, name: groupName.trim(), builtin: false, labelCellId: category!.id, items: [item] }];
  const nextConfig = { ...configuration, version: id<"policy">(), units: [...configuration.units, ...presentations.map(p => ({ cellId: p.cellId, symbol: p.unit === "text" ? "1" : p.unit, dimensions: units[p.unit] }))] };
  next = changeWorkbook(next, { externalAhs: { ...s.externalAhs, groups, cells: [...s.externalAhs.cells, ...presentations] }, worksheets: next.worksheets.map(w => w.stage !== "AHS_EXTERNAL" ? w : { ...w, tables: w.tables.map(t => t.id !== table.id ? t : { ...t, merges: [...t.merges.filter(m => !group?.labelCellId || m.anchorCellId !== group.labelCellId), ...(group?.labelCellId ? [{ id: id<"merge">(), anchorCellId: group.labelCellId, rowSpan: group.items.length + 1, colSpan: 1 }] : []), { id: id<"merge">(), anchorCellId: total!.id, rowSpan: 1, colSpan: 2 }] }) }), ...(next.workbook ? { workbook: { ...next.workbook, configuration: nextConfig, cells: [...next.workbook.cells.filter(p => !cells.some(c => c.id === p.cellId)), ...presentations] } } : {}) });
  next = setCellInput(next, label!.id, { kind: "TEXT", text: name.trim() });
  next = setCellInput(next, category!.id, { kind: "TEXT", text: group ? "" : groupName.trim() });
  next = setCellFormula(next, total!.id, `@{${price!.id}}*@{${volume!.id}}`);
  const rollups = section === "BIAYA" ? [["TOTAL BIAYA", 5, total!.id], ["BIAYA PER LITER", 5, price!.id]] as const : [["TOTAL PENDAPATAN", 5, total!.id], ["HARGA INCLUDE", 3, price!.id], ["HARGA JUAL SETELAH PAJAK", 5, price!.id]] as const;
  const targets = rollups.flatMap(([name, columnIndex, member]) => {
    const row = table.rows.find(r => r.label.endsWith(`|${name}`));
    const target = row && table.cells.find(c => c.rowId === row.id && c.columnId === table.columnOrder[columnIndex]);
    return target ? [{ target, member }] : [];
  });
  const changing = new Set<string>(targets.map(({ target }) => target.id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const formula of s.formulas) if (!changing.has(formula.targetCellId) && formula.referenceCellIds.some(ref => changing.has(ref))) { changing.add(formula.targetCellId); expanded = true; }
  }
  // Inline the old summary dependency before adding its own contributor, so linked summaries do not count it twice.
  const oldExpression = (expression: string, depth = 0): string => {
    requireCondition(depth < 128 && expression.length <= 16384, "Rumus total terlalu kompleks untuk menambah uraian.");
    return rewriteReferences(expression, ref => {
      if (!changing.has(ref)) return `@{${ref}}`;
      const formula = s.formulas.find(f => f.targetCellId === ref);
      if (formula) return `(${oldExpression(formula.expression, depth + 1)})`;
      const source = table.cells.find(c => c.id === ref)?.source;
      if (source?.kind === "INPUT" && source.input.kind === "NUMERIC_TEXT") return `(${source.input.text})`;
      if (source?.kind === "INPUT" && source.input.kind === "UNSET") return "0";
      return `@{${ref}}`;
    });
  };
  for (const { target, member } of targets) {
    const expression = target.source.kind === "FORMULA" ? oldExpression(s.formulas.find(f => f.targetCellId === target.id)!.expression) : target.source.kind === "INPUT" && target.source.input.kind === "NUMERIC_TEXT" ? target.source.input.text : "0";
    next = setCellFormula(next, target.id, `(${expression})+@{${member}}`);
  }
  return { snapshot: next, configuration: next.workbook?.configuration ?? nextConfig, firstCellId: label!.id };
}

export function addExternalAhsField(s: WorkbookSnapshot, configuration: EngineConfiguration, section: "INFORMASI" | "LABA", rawName: string) {
  const name = rawName.trim();
  requireCondition(name, "Nama uraian wajib diisi.");
  requireCondition(section === "INFORMASI" || section === "LABA", "Bagian uraian AHS tidak sesuai.");
  const table = s.worksheets.find(w => w.stage === "AHS_EXTERNAL")?.tables.find(t => t.cells.some(c => c.scope === s.activeProfile));
  requireCondition(table && s.externalAhs && table.columnOrder.length === 6, "Tabel AHS Eksternal tidak lengkap.");
  const anchor = section === "INFORMASI" ? table.rows.find(row => row.label.endsWith("|HARGA INCLUDE"))
    : table.rowOrder.map(rowId => table.rows.find(row => row.id === rowId)!).find(row => row.label.split("|")[2] === "ahs-notes");
  const position = anchor ? table.rowOrder.indexOf(anchor.id) : -1;
  requireCondition(position > 0, "Posisi bagian AHS Eksternal tidak ditemukan.");
  let next = addRow(s, table.id, { label: `external|extra|${section === "INFORMASI" ? "ahs-meta" : "profit-row"}`, scope: s.activeProfile, afterRowId: table.rowOrder[position - 1]! });
  const updated = next.worksheets.flatMap(w => w.tables).find(t => t.id === table.id)!;
  const rowId = updated.rowOrder.find(row => !table.rowOrder.includes(row))!;
  const cells = updated.columnOrder.map(column => updated.cells.find(cell => cell.rowId === rowId && cell.columnId === column)!);
  const label = cells[0]!, value = cells[section === "INFORMASI" ? 1 : 5]!;
  const presentations: CellPresentation[] = cells.map(cell => ({ cellId: cell.id, address: "", kind: "INPUT", tone: section === "INFORMASI" ? "yellow" : "gray",
    unit: section === "LABA" && cell.id === value.id ? "1" : "text", bold: cell.id === label.id, align: section === "LABA" && cell.id === value.id ? "right" : "left" }));
  const field = { profile: s.activeProfile, section, name, valueType: section === "INFORMASI" ? "TEXT" as const : "NUMBER" as const, labelCellId: label.id, valueCellId: value.id };
  const nextConfig = { ...configuration, version: id<"policy">(), units: [...configuration.units, ...presentations.map(p => ({ cellId: p.cellId, symbol: "1", dimensions: units[p.unit] }))] };
  const merges: TableSnapshot["merges"] = section === "INFORMASI" ? [
    { id: id<"merge">(), anchorCellId: value.id, rowSpan: 1, colSpan: 2 },
    { id: id<"merge">(), anchorCellId: cells[4]!.id, rowSpan: 1, colSpan: 2 },
  ] : [{ id: id<"merge">(), anchorCellId: label.id, rowSpan: 1, colSpan: 5 }];
  next = changeWorkbook(next, {
    externalAhs: { ...s.externalAhs, fields: [...s.externalAhs.fields, field], cells: [...s.externalAhs.cells, ...presentations] },
    worksheets: next.worksheets.map(w => w.stage !== "AHS_EXTERNAL" ? w : { ...w, tables: w.tables.map(t => t.id !== table.id ? t : { ...t, merges: [...t.merges, ...merges],
      cells: t.cells.map(cell => cell.rowId !== rowId ? cell : { ...cell, source: { kind: "INPUT" as const, input: cell.id === label.id ? { kind: "TEXT" as const, text: name }
        : cell.id === value.id ? section === "LABA" ? { kind: "NUMERIC_TEXT" as const, text: "0" } : { kind: "UNSET" as const }
        : { kind: "TEXT" as const, text: "" } } }) }) }),
    ...(next.workbook ? { workbook: { ...next.workbook, configuration: nextConfig, cells: [...next.workbook.cells, ...presentations],
      tables: next.workbook.tables.map(layout => layout.tableId !== table.id ? layout : { ...layout, rowHeights: [...layout.rowHeights, { id: rowId, size: 30 }] }) } } : {}),
  });
  return { snapshot: next, configuration: next.workbook?.configuration ?? nextConfig, firstCellId: label.id };
}
