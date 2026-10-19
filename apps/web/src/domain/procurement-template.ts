import type { CellPresentation, CellSnapshot, DynamicWorkbook, FormulaDefinition, TableSnapshot, WorkbookSnapshot } from "./contracts.ts";
import type { StableId } from "./ids.ts";
import { createStableId as id } from "./ids.ts";
import { PROFILES } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { emptyWorkbook, changeWorkbook } from "./workflow.ts";
import { SOURCE_HASH, SOURCE_SHEETS } from "./source-template.ts";
import { parseFormula, references } from "../engine/parser.ts";
import type { DecimalPolicy } from "../engine/decimal.ts";
import type { EngineConfiguration, Unit } from "../engine/contracts.ts";
import { requireCondition } from "./validation.ts";
import { canonicalJson } from "./snapshots.ts";
import { OPERATIONAL_DECIMAL_POLICY, OPERATIONAL_POLICY_VERSION_ID } from "./calculation-policy.ts";

export const units: Record<CellPresentation["unit"], Unit> = { text: {}, "1": {}, "IDR/L": { money: 1, volume: -1 }, L: { volume: 1 }, IDR: { money: 1 } };
export const cellsOf = (s: WorkbookSnapshot) => s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells));
export function prepareNumericBlanks(s: WorkbookSnapshot): WorkbookSnapshot {
  if (!s.workbook) return s;
  const byId = new Map(cellsOf(s).map(c => [c.id, c]));
  const numericBlanks = new Set(s.workbook.cells.filter(p => {
    const source = byId.get(p.cellId)?.source;
    return p.kind === "BLANK" && p.unit !== "text" && source?.kind === "INPUT" &&
      (source.input.kind === "UNSET" || (source.input.kind === "TEXT" && !source.input.text));
  }).map(p => p.cellId));
  const presentations = new Map(s.workbook.cells.map(p => [p.cellId, p]));
  const addresses = new Map(s.workbook.cells.map(p => [p.address, p.cellId]));
  const repaired = new Map(s.formulas.flatMap(formula => {
    if (formula.sourceKind !== "WORKBOOK_SOURCE" || formula.provenance?.address !== "E17") return [];
    const target = byId.get(formula.targetCellId), address = presentations.get(formula.targetCellId)?.address;
    if (!target || !address || !/^[A-Z]+17$/.test(address)) return [];
    const offer = s.workbook!.offers.find(o => o.columnId === target.columnId);
    if (address !== "E17" && offer?.pattern !== "E") return [];
    const column = address.slice(0, -2);
    const members = Array.from({ length: 7 }, (_, index) => addresses.get(column + (index + 10)));
    if (members.some(member => !member || byId.get(member)?.tableId !== target.tableId)) return [];
    const expression = `SUM(${members.map(member => `@{${member}}`).join(",")})`;
    return formula.expression === expression ? [] : [[formula.id, { ...formula, versionId: id<"formula-version">(), expression,
      referenceCellIds: members as StableId<"cell">[] }] as const];
  }));
  if (!numericBlanks.size && !repaired.size) return s;
  return changeWorkbook(s, {
    formulas: s.formulas.map(formula => repaired.get(formula.id) ?? formula),
    worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
      cells: t.cells.map(c => numericBlanks.has(c.id) ? { ...c, source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } } : c),
    })) })),
    workbook: { ...s.workbook, cells: s.workbook.cells.map(p => numericBlanks.has(p.cellId) ? { ...p, kind: "INPUT" as const } : p) },
  });
}
export const binding = (s: WorkbookSnapshot, profile: Profile, key: string) => s.workbook?.bindings.find(b => b.profile === profile && b.key === key)?.cellId;
export const sourceAddress = (address: string, profile: Profile) => address.replace(/\d+$/, n => String(Number(n) - (profile === "SOLAR_BAWAH" ? 1 : 0)));
export function formulaFromAddresses(expression: string, resolve: (address: string) => string, omit: (address: string) => boolean = () => false) {
  return expression.toUpperCase().replace(/\$?([A-Z])\$?(\d+):\$?([A-Z])\$?(\d+)/g, (_, a: string, r: string, b: string, end: string) => {
    const addresses: string[] = [];
    for (let row = Number(r); row <= Number(end); row++) for (let col = a.charCodeAt(0); col <= b.charCodeAt(0); col++) {
      const address = String.fromCharCode(col) + row; if (!omit(address)) addresses.push(address);
    }
    return addresses.join(",");
  }).replace(/\$?[A-Z]+\$?\d+/g, address => `@{${resolve(address.replaceAll("$", ""))}}`);
}

export function createProcurementWorkbook(projectName: string, analysisName: string, projectId?: StableId<"project">): WorkbookSnapshot {
  const base = emptyWorkbook(projectName, analysisName, projectId);
  const worksheets = base.worksheets.map(w => ({ ...w, tables: [] as TableSnapshot[] }));
  const presentation: CellPresentation[] = [], layouts: DynamicWorkbook["tables"][number][] = [], bindings: DynamicWorkbook["bindings"][number][] = [];
  const formulas: FormulaDefinition[] = [];
  const hppIds = {} as Record<Profile, StableId<"cell">>;
  for (const [profileIndex, profile] of PROFILES.entries()) {
    const sheet = SOURCE_SHEETS[profileIndex]!, offset = profileIndex;
    const byAddress = new Map<string, CellSnapshot>();
    const role = (key: string, address: string) => bindings.push({ profile, key, cellId: byAddress.get(sourceAddress(address, profile))!.id });
    for (const [stage, startColumn, endColumn, startRow, endRow] of [
      ["EVALUASI_VENDOR", "B", "E", 3, 21], ["KONVERSI_JAGAD", "B", "D", 23, 42], ["AHS", "G", "L", 3, 42],
    ] as const) {
      if (stage === "EVALUASI_VENDOR" && profile === "SOLAR_BAWAH") continue;
      const tableId = id<"table">();
      const rows = Array.from({ length: endRow - startRow + 1 }, (_, i) => ({ id: id<"row">(), label: String(startRow + i - offset) }));
      const columns = Array.from({ length: endColumn.charCodeAt(0) - startColumn.charCodeAt(0) + 1 }, (_, i) => ({ id: id<"column">(), label: String.fromCharCode(startColumn.charCodeAt(0) + i) }));
      const cells: CellSnapshot[] = [];
      rows.forEach((row, ri) => columns.forEach(column => {
        const r = startRow + ri, col = column.label, address = col + (r - offset), source = sheet.cells[address];
        let kind: CellPresentation["kind"] = source?.formula ? "RESULT" : source?.text ? "LABEL" : source?.number ? "INPUT" : "BLANK";
        let unit: CellPresentation["unit"] = "text";
        if (stage === "EVALUASI_VENDOR" && col !== "B" && r >= 10 && r <= 17) unit = "IDR/L";
        if (stage === "KONVERSI_JAGAD" && col !== "B" && r >= 30) unit = "IDR/L";
        if (stage === "AHS") {
          if (col === "I" && r >= 11 && r <= 33) unit = "IDR/L";
          if (col === "J" && ((r >= 11 && r <= 13) || (r >= 16 && r <= 33))) unit = "L";
          if (col === "K" && ((r >= 11 && r <= 13) || (r >= 16 && r <= 33))) unit = "IDR";
          if (col === "L" && [9, 14, 34, 35, 36].includes(r)) unit = "IDR";
          if ((col === "L" && [10, 15, 37].includes(r)) || (col === "J" && r === 8) || (col === "H" && r === 7)) unit = "IDR/L";
          if (col === "L" && r === 38) unit = "1";
        }
        const metadata = ["D5", "D6", "D7", "B25", "C26", "H4", "H5", "H6", "H7", "K7", "K6", "G39"].includes(col + r);
        const vendorName = stage === "EVALUASI_VENDOR" && col !== "B" && r === 9;
        if (metadata || vendorName || (stage === "EVALUASI_VENDOR" && col !== "B" && r === 18)) kind = "INPUT";
        if (["C10", "I11"].includes(col + r) || (stage === "EVALUASI_VENDOR" && col !== "B" && r === 13)) kind = "INPUT";
        if (["C30", "C27"].includes(col + r) || (profile === "INU" && col + r === "D30")) kind = "RESULT";
        if (kind === "BLANK" && unit !== "text") kind = "INPUT";
        let input: CellSnapshot["source"] = { kind: "INPUT", input: kind === "LABEL" ? { kind: "TEXT", text: source?.text?.trim() ?? "" } : { kind: "UNSET" } };
        if (col + r === "K4") kind = "RESULT";
        if (kind === "BLANK") input = { kind: "INPUT", input: { kind: "TEXT", text: "" } };
        // Explicit source zero inputs remain zero; example prices, volumes and nonzero costs never become defaults.
        if (kind === "INPUT" && source?.number && Number(source.number) === 0 && unit !== "text" && !(stage === "EVALUASI_VENDOR" && r === 10)) input = { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "0" } };
        if (col + r === "I15") input = { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "0" } };
        if (metadata && unit === "text") input = { kind: "INPUT", input: { kind: "TEXT", text: "" } };
        if (col + r === "I15") unit = "IDR/L";
        if (profile === "SOLAR_BAWAH" && stage === "KONVERSI_JAGAD" && r >= 37) { kind = "BLANK"; input = { kind: "INPUT", input: { kind: "TEXT", text: "" } }; }
        const cell: CellSnapshot = { id: id<"cell">(), tableId, rowId: row.id, columnId: column.id, scope: stage === "EVALUASI_VENDOR" ? "SHARED" : profile, source: input };
        cells.push(cell); byAddress.set(address, cell);
        if (profile === "SOLAR_BAWAH" && col + r === "B23") input = { kind: "INPUT", input: { kind: "TEXT", text: "Konversi Satuan Jagad" } };
        if (profile === "SOLAR_BAWAH" && ["B27", "C29"].includes(col + r)) input = { kind: "INPUT", input: { kind: "TEXT", text: col === "B" ? "Nama Supplier :" : "Harga Supplier" } };
        cells[cells.length - 1] = { ...cell, source: input }; byAddress.set(address, cells[cells.length - 1]!);
        const tone = stage === "AHS" ? r <= 8 ? "yellow" : r <= 13 ? "green" : r <= 33 ? "red" : r <= 38 ? "gray" : "plain" : stage === "KONVERSI_JAGAD" && r === 42 && col !== "D" ? "gray" : "plain";
        presentation.push({ cellId: cell.id, address, kind, tone, unit,
          bold: stage === "AHS" ? r <= 10 || [14, 15, 34, 35, 36, 37, 38].includes(r) || col === "G" : [startRow, 9, 17, 25, 26, 27, 29, 36].includes(r),
          align: r === startRow || (stage === "EVALUASI_VENDOR" && r >= 9 && r <= 17) ? "center" : kind === "LABEL" || unit === "text" ? "left" : "right" });
      }));
      const table: TableSnapshot = { id: tableId, rows, columns, rowOrder: rows.map(r => r.id), columnOrder: columns.map(c => c.id), cells, merges: [] };
      const merges = sheet.merges.flatMap(range => {
        const [from, to] = range.split(":"); const anchor = byAddress.get(from!); const end = byAddress.get(to!);
        if (!anchor || !end || anchor.tableId !== tableId || end.tableId !== tableId) return [];
        return [{ id: id<"merge">(), anchorCellId: anchor.id, rowSpan: table.rowOrder.indexOf(end.rowId) - table.rowOrder.indexOf(anchor.rowId) + 1, colSpan: table.columnOrder.indexOf(end.columnId) - table.columnOrder.indexOf(anchor.columnId) + 1 }];
      });
      worksheets.find(w => w.stage === stage)!.tables.push({ ...table, merges });
      layouts.push({ tableId, profile: stage === "EVALUASI_VENDOR" ? "SHARED" : profile, rowHeights: rows.map((row, ri) => ({ id: row.id, size: ri === 0 && stage !== "KONVERSI_JAGAD" ? 37 : stage === "EVALUASI_VENDOR" ? 23.7 : stage === "KONVERSI_JAGAD" ? 22.85 : 23.23 })), columnWidths: columns.map(c => ({ id: c.id, size: 101 })) });
    }
    const replacement: Record<string, string | null> = { C10: null, C30: null, C27: null, I11: null, K4: sourceAddress("C27", profile), K6: null };
    if (profile === "SOLAR_BAWAH") replacement.D30 = sourceAddress("C30", profile);
    for (const [address, source] of Object.entries(sheet.cells)) {
      const cell = byAddress.get(address); if (!cell || !source.formula) continue;
      const canonical = address.replace(/\d+$/, n => String(Number(n) + offset));
      if (profile === "SOLAR_BAWAH" && /^[CD](3[7-9]|4[0-2])$/.test(canonical)) continue;
      if (Object.hasOwn(replacement, canonical) && replacement[canonical] === null) continue;
      if (cell.scope === "SHARED" && /13$/.test(address) && !address.startsWith("B")) continue;
      const expression = formulaFromAddresses(replacement[canonical] ?? source.formula, a => {
        requireCondition(byAddress.has(a), "Source reference outside template: " + a); return byAddress.get(a)!.id;
      }, a => presentation.find(p => p.cellId === byAddress.get(a)?.id)?.kind === "BLANK");
      const formulaId = id<"formula">();
      formulas.push({ id: formulaId, versionId: id<"formula-version">(), targetCellId: cell.id, expression,
        referenceCellIds: [...new Set(references(parseFormula(expression), () => []))] as StableId<"cell">[], activation: "ACTIVE",
        sourceKind: Object.hasOwn(replacement, canonical) ? "OPERATIONAL_OVERRIDE" : "WORKBOOK_SOURCE", provenance: { workbookSha256: SOURCE_HASH, sheet: sheet.name, address } });
      const table = worksheets.flatMap(w => w.tables).find(t => t.id === cell.tableId)!;
      (table.cells as CellSnapshot[])[table.cells.indexOf(cell)] = { ...cell, source: { kind: "FORMULA", formulaId } };
    }
    for (const [key, address] of Object.entries({ supplier: "C30", cost: "D30", mue: "C42", oat: "C34", supplierName: "C27", sale: "I11", volume: "J11", hpp: "I16", profit: "L36", gross: "C38", bph: "C39", margin: "C40", pph: "C41" })) role(key, address);
    hppIds[profile] = byAddress.get(sourceAddress("I16", profile))!.id;
  }
  const workbook: DynamicWorkbook = { template: "AHAS-v1", sourceHash: SOURCE_HASH, configuration: null, solver: null, cells: presentation, tables: layouts, bindings, offers: [], selections: { INU: null, SOLAR_BAWAH: null } };
  const snapshot = changeWorkbook(base, { schemaVersion: 3, activeProfile: "SOLAR_BAWAH", worksheets, formulas, workbook, profiles: Object.fromEntries(PROFILES.map(profile => [profile, {
    hppBase: { origin: "CONVERSION_COST", cellId: hppIds[profile], contextRunId: null }, reviewContext: null,
    cellIds: worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).filter(c => c.scope === profile).map(c => c.id),
    formulaIds: formulas.filter(f => worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(c => c.id === f.targetCellId)?.scope === profile).map(f => f.id),
  }])) as unknown as WorkbookSnapshot["profiles"] });
  return configureTemplate(snapshot, OPERATIONAL_DECIMAL_POLICY, null);
}

export function configureTemplate(s: WorkbookSnapshot, decimal: DecimalPolicy, solver: DynamicWorkbook["solver"]) {
  requireCondition(s.workbook, "Template dinamis diperlukan.");
  const policyVersionId = canonicalJson(decimal) === canonicalJson(OPERATIONAL_DECIMAL_POLICY) ? OPERATIONAL_POLICY_VERSION_ID : id<"policy">();
  const configuration: EngineConfiguration = { version: id<"policy">(), policyVersionId, decimal,
    units: s.workbook.cells.map(c => ({ cellId: c.cellId, symbol: c.unit === "text" ? "1" : c.unit, dimensions: units[c.unit] })),
    aggregates: [], selectionDependentCellIds: [] };
  return changeWorkbook(s, { policy: { status: "CONFIGURED", versionId: configuration.policyVersionId }, workbook: { ...s.workbook, configuration, solver } });
}
