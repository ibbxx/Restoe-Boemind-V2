import type { CellInput, CellSnapshot, FormulaDefinition, WorkbookSnapshot } from "./contracts.ts";
import { requireCondition } from "./validation.ts";
import { PROFILES } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { createStableId as id } from "./ids.ts";
import { changeWorkbook } from "./workflow.ts";
import { displayCellId } from "./cell-address.ts";

export function isAhsVolumeCell(snapshot: WorkbookSnapshot, cell: CellSnapshot): boolean {
  const table = snapshot.worksheets.find(worksheet => worksheet.stage === "AHS")?.tables.find(table => table.id === cell.tableId);
  if (!table) return false;
  return snapshot.workbook
    ? snapshot.workbook.cells.some(meta => meta.cellId === cell.id && meta.unit === "L")
    : table.rows.some(row => row.id === cell.rowId && (row.label.endsWith(" · Volume") || row.label.endsWith("|template:L")));
}

export function validateAhsVolumeInput(snapshot: WorkbookSnapshot, cell: CellSnapshot, input: CellInput) {
  if (!isAhsVolumeCell(snapshot, cell)) return;
  requireAhsVolumeEditable(snapshot, cell);
  requireCondition(input.kind === "UNSET" || (input.kind === "NUMERIC_TEXT" && input.text.length <= 258 &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(input.text)), "Volume AHS wajib berupa angka. Contoh: 50.000 atau 50000.");
}

export function ahsVolumeSource(snapshot: WorkbookSnapshot, profile: Profile): CellSnapshot | undefined {
  const cells = snapshot.worksheets.filter(worksheet => worksheet.stage === "AHS").flatMap(worksheet => worksheet.tables.flatMap(table => table.cells));
  const sources = snapshot.workbook
    ? snapshot.workbook.bindings.filter(binding => binding.profile === profile && binding.key === "volume").map(binding => cells.find(cell => cell.id === binding.cellId))
    : snapshot.worksheets.filter(worksheet => worksheet.stage === "AHS").flatMap(worksheet => worksheet.tables.flatMap(table =>
      table.cells.filter(cell => cell.scope === profile && table.rows.some(row => row.id === cell.rowId && row.label === "Harga Jual · Harga Dasar · Volume"))));
  const source = sources.length === 1 ? sources[0] : undefined;
  return source?.scope === profile && isAhsVolumeCell(snapshot, source) ? source : undefined;
}

export function isAhsVolumeFollower(snapshot: WorkbookSnapshot, cell: CellSnapshot): boolean {
  return isAhsVolumeCell(snapshot, cell) && (cell.scope === "SHARED" || ahsVolumeSource(snapshot, cell.scope)?.id !== cell.id);
}

export function requireAhsVolumeEditable(snapshot: WorkbookSnapshot, cell: CellSnapshot) {
  requireCondition(!isAhsVolumeFollower(snapshot, cell), "Volume ini mengikuti Harga Jual · Harga Dasar. Ubah Volume pada baris tersebut.");
}

export function connectAhsVolumes(snapshot: WorkbookSnapshot): WorkbookSnapshot {
  const cells = snapshot.worksheets.flatMap(worksheet => worksheet.tables.flatMap(table => table.cells));
  const updates = new Map<string, FormulaDefinition>();
  const followers = new Set<string>();
  const dependencies = new Map(snapshot.formulas.filter(formula => formula.activation === "ACTIVE").map(formula => [formula.targetCellId as string, formula.referenceCellIds as readonly string[]]));
  for (const mapping of snapshot.mappings.filter(mapping => mapping.status === "ACTIVE")) dependencies.set(mapping.targetCellId, [mapping.sourceCellId]);
  for (const profile of PROFILES) {
    const volumes = cells.filter(cell => cell.scope === profile && isAhsVolumeCell(snapshot, cell));
    if (!volumes.length) continue;
    const source = ahsVolumeSource(snapshot, profile);
    requireCondition(source, `Sumber Volume AHS ${profile} hilang atau ambigu.`);
    const targets = volumes.filter(cell => cell.id !== source.id);
    const targetIds = new Set<string>(targets.map(cell => cell.id));
    const visited = new Set<string>();
    const pending: string[] = [...dependencies.get(source.id) ?? []];
    while (pending.length) {
      const dependency = pending.pop()!;
      requireCondition(dependency !== source.id && !targetIds.has(dependency), `Volume ${displayCellId(source.id, snapshot)} merujuk kembali ke Volume turunan. Perbaiki rumus sumber.`);
      requireCondition(cells.some(cell => cell.id === dependency), `Referensi sumber Volume ${displayCellId(source.id, snapshot)} tidak ditemukan.`);
      if (visited.has(dependency)) continue;
      visited.add(dependency); pending.push(...dependencies.get(dependency) ?? []);
    }
    for (const target of targets) {
      requireCondition(!snapshot.mappings.some(mapping => mapping.targetCellId === target.id && mapping.status === "ACTIVE"), `Volume ${displayCellId(target.id, snapshot)} masih menjadi target mapping.`);
      followers.add(target.id);
      const formulaId = target.source.kind === "FORMULA" ? target.source.formulaId : null;
      const existing = formulaId ? snapshot.formulas.find(formula => formula.id === formulaId) : undefined;
      const expression = `@{${source.id}}`;
      if (existing?.activation === "ACTIVE" && existing.expression === expression && existing.referenceCellIds.length === 1 && existing.referenceCellIds[0] === source.id) continue;
      updates.set(target.id, { id: existing?.id ?? id<"formula">(), targetCellId: target.id,
        expression, referenceCellIds: [source.id], activation: "ACTIVE", sourceKind: "OPERATIONAL_OVERRIDE", provenance: existing?.provenance ?? null });
    }
  }
  const presentationChanged = snapshot.workbook?.cells.some(meta => followers.has(meta.cellId) && meta.kind !== "RESULT");
  if (!updates.size && !presentationChanged) return snapshot;
  const formulas = [...snapshot.formulas.filter(formula => !updates.has(formula.targetCellId)), ...updates.values()];
  const profiles = { ...snapshot.profiles };
  for (const profile of PROFILES) profiles[profile] = { ...profiles[profile],
    formulaIds: formulas.filter(formula => cells.some(cell => cell.id === formula.targetCellId && cell.scope === profile)).map(formula => formula.id) };
  return changeWorkbook(snapshot, {
    formulas,
    worksheets: snapshot.worksheets.map(worksheet => ({ ...worksheet, tables: worksheet.tables.map(table => ({ ...table,
      cells: table.cells.map(cell => updates.has(cell.id) ? { ...cell, source: { kind: "FORMULA" as const, formulaId: updates.get(cell.id)!.id } } : cell) })) })),
    profiles,
    ...(snapshot.workbook ? { workbook: { ...snapshot.workbook, cells: snapshot.workbook.cells.map(meta => followers.has(meta.cellId) ? { ...meta, kind: "RESULT" as const } : meta) } } : {}),
  });
}
