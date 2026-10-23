import type { CellSnapshot, FormulaDefinition, WorkbookSnapshot } from "./contracts.ts";
import { createStableId as id } from "./ids.ts";
import { appendField, changeWorkbook } from "./workflow.ts";
import { requireCondition } from "./validation.ts";
import { ahsRoleCell } from "./ahs-groups.ts";

function solarPriceCells(s: WorkbookSnapshot) {
  return s.worksheets.filter(w => w.stage === "KONVERSI_JAGAD").flatMap(w => w.tables.flatMap(table =>
    table.cells.filter(cell => {
      if (cell.scope !== "SOLAR_BAWAH") return false;
      const row = table.rows.find(row => row.id === cell.rowId)!;
      if (!s.workbook) return row.label.startsWith("Harga INU · ");
      const column = table.columns.find(column => column.id === cell.columnId)?.label;
      const address = s.workbook.cells.find(p => p.cellId === cell.id)?.address ?? "";
      return column === "C" && (/^C(29|3[0-5])$/.test(address) || row.label === "BPH" || row.label.startsWith("vendor-extra:"));
    }).map(source => ({ source, table }))));
}

export function isSolarCostCell(s: WorkbookSnapshot, cell: CellSnapshot): boolean {
  if (cell.scope !== "SOLAR_BAWAH") return false;
  const table = s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.find(table => table.id === cell.tableId);
  if (!table) return false;
  if (!s.workbook) return table.rows.some(row => row.id === cell.rowId && row.label.startsWith("Biaya · "));
  return table.columns.some(column => column.id === cell.columnId && column.label === "D") &&
    solarPriceCells(s).some(({ source }) => source.tableId === cell.tableId && source.rowId === cell.rowId);
}

export function requireSolarCostEditable(s: WorkbookSnapshot, cell: CellSnapshot) {
  requireCondition(!isSolarAhsPpnCell(s, cell), "PPN biaya SKP mengikuti PPN dan PPN OAT Biaya Konversi. Ubah nilai sumber di Evaluasi Vendor.");
  requireCondition(!isSolarCostCell(s, cell), "Biaya SKP mengikuti Harga Solar. Ubah nilai sumber di Evaluasi Vendor.");
}

export function isSolarAhsPpnCell(s: WorkbookSnapshot, cell: CellSnapshot): boolean {
  return cell.scope === "SOLAR_BAWAH" && ahsRoleCell(s, "SOLAR_BAWAH", "I21", "PAJAK · PPN 11%")?.id === cell.id;
}

export function prepareSolarCosts(snapshot: WorkbookSnapshot): WorkbookSnapshot {
  let s = snapshot;
  const pairs = solarPriceCells(s).map(({ source, table }) => {
    let target: CellSnapshot | undefined;
    if (s.workbook) {
      target = table.cells.find(cell => cell.rowId === source.rowId && table.columns.some(column => column.id === cell.columnId && column.label === "D"));
    } else {
      const label = table.rows.find(row => row.id === source.rowId)!.label.replace(/^Harga INU · /, "Biaya · ");
      target = s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.flatMap(t => t.cells.filter(cell =>
        cell.scope === "SOLAR_BAWAH" && t.rows.some(row => row.id === cell.rowId && row.label === label)))[0];
      if (!target) {
        const added = appendField(s, "KONVERSI_JAGAD", "SOLAR_BAWAH", label, { kind: "UNSET" });
        s = added.snapshot;
        target = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(cell => cell.id === added.cellId);
      }
    }
    requireCondition(target, "Sel Biaya SKP tidak ditemukan.");
    return { source, target };
  });
  const links = pairs.map(({ source, target }) => ({ sources: [source], target }));
  const ppn = ahsRoleCell(s, "SOLAR_BAWAH", "I21", "PAJAK · PPN 11%");
  if (ppn) {
    const sources = pairs.filter(({ target }) => s.workbook
      ? s.workbook.cells.some(p => p.cellId === target.id && ["D30", "D34"].includes(p.address))
      : s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.some(t => t.cells.some(cell => cell.id === target.id) &&
        t.rows.some(row => row.id === target.rowId && ["Biaya · PPN", "Biaya · PPN OAT"].includes(row.label))))
      .map(({ target }) => target);
    requireCondition(sources.length === 2, "Sumber PPN dan PPN OAT Biaya Konversi SKP tidak lengkap.");
    links.push({ sources, target: ppn });
  }
  const targets = new Set(links.map(link => link.target.id));
  const dependencies = new Map<string, readonly string[]>(s.formulas.filter(f => f.activation === "ACTIVE").map(f => [f.targetCellId, f.referenceCellIds]));
  for (const mapping of s.mappings.filter(m => m.status === "ACTIVE")) dependencies.set(mapping.targetCellId, [mapping.sourceCellId]);
  for (const { sources, target } of links) dependencies.set(target.id, sources.map(source => source.id));
  const updates = new Map<string, FormulaDefinition>();
  for (const { sources, target } of links) {
    const sourceIds = sources.map(source => source.id);
    const seen = new Set<string>(), pending: string[] = [...sourceIds];
    while (pending.length) {
      const dependency = pending.pop()!;
      requireCondition(dependency !== target.id, "Harga Solar merujuk kembali ke Biaya SKP dan membentuk siklus. Perbaiki rumus sumber.");
      if (seen.has(dependency)) continue;
      seen.add(dependency); pending.push(...dependencies.get(dependency) ?? []);
    }
    const existing = s.formulas.find(f => f.targetCellId === target.id);
    const expression = sourceIds.map(sourceId => `@{${sourceId}}`).join("+");
    if (target.source.kind === "FORMULA" && existing?.id === target.source.formulaId && existing.activation === "ACTIVE" &&
      existing.expression === expression && existing.referenceCellIds.length === sourceIds.length && existing.referenceCellIds.every((sourceId, index) => sourceId === sourceIds[index])) continue;
    updates.set(target.id, { id: existing?.id ?? id<"formula">(), targetCellId: target.id, expression, referenceCellIds: sourceIds,
      activation: "ACTIVE", sourceKind: "OPERATIONAL_OVERRIDE", provenance: existing?.provenance ?? null });
  }
  const presentationChanged = s.workbook?.cells.some(p => targets.has(p.cellId) && (p.kind !== "RESULT" || p.unit !== "IDR/L"));
  const mappingChanged = s.mappings.some(m => targets.has(m.targetCellId));
  if (!updates.size && !presentationChanged && !mappingChanged) return s;
  const formulas = [...s.formulas.filter(f => !updates.has(f.targetCellId)), ...updates.values()];
  const cells = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells));
  const solarIds = new Set(cells.filter(cell => cell.scope === "SOLAR_BAWAH").map(cell => cell.id));
  const configuration = s.workbook?.configuration;
  return changeWorkbook(s, {
    formulas, mappings: s.mappings.filter(m => !targets.has(m.targetCellId)),
    worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t, cells: t.cells.map(cell =>
      updates.has(cell.id) ? { ...cell, source: { kind: "FORMULA" as const, formulaId: updates.get(cell.id)!.id } } : cell) })) })),
    profiles: { ...s.profiles, SOLAR_BAWAH: { ...s.profiles.SOLAR_BAWAH,
      formulaIds: formulas.filter(f => solarIds.has(f.targetCellId)).map(f => f.id) } },
    ...(s.workbook ? { workbook: { ...s.workbook,
      cells: s.workbook.cells.map(p => targets.has(p.cellId) ? { ...p, kind: "RESULT" as const, unit: "IDR/L" as const } : p),
      configuration: configuration && presentationChanged ? { ...configuration, version: id<"policy">(),
        units: configuration.units.map(unit => targets.has(unit.cellId) ? { ...unit, symbol: "IDR/L", dimensions: { money: 1, volume: -1 } } : unit) } : configuration ?? null,
    } } : {}),
  });
}
