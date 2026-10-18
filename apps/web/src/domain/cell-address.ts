import type { WorkbookSnapshot } from "./contracts.ts";

function columnName(index: number): string {
  let name = "";
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    name = String.fromCharCode(65 + (number - 1) % 26) + name;
  }
  return name;
}

function columnIndex(name: string): number {
  return [...name].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function mapFormulaCode(expression: string, transform: (code: string) => string) {
  return expression.split(/("(?:[^"]|"")*")/g).map((part, index) => index % 2 ? part : transform(part)).join("");
}

// Table indexes are implementation details; keep the profile/sheet alias readable in UI text.
function displayCode(code: string) {
  return code.replace(/\b(EV|INU|SOLAR|AHS-INU|AHS-SOLAR)-T(\d+)!/g, "$1$2!");
}

export function cellCodes(snapshot: WorkbookSnapshot): ReadonlyMap<string, string> {
  const codes = new Map<string, string>();
  const presentation = new Map(snapshot.workbook?.cells.map(cell => [cell.cellId, cell.address]));
  for (const worksheet of snapshot.worksheets) for (const [tableIndex, table] of worksheet.tables.entries()) {
    const rows = new Map<string, number>(), columns = new Map<string, string>();
    const usedRows = new Set<number>(), usedColumns = new Set<string>();
    for (const cell of table.cells) {
      const match = /^([A-Z]+)([1-9]\d*)$/.exec(presentation.get(cell.id) ?? "");
      if (!match) continue;
      if (!rows.has(cell.rowId)) { rows.set(cell.rowId, Number(match[2])); usedRows.add(Number(match[2])); }
      if (!columns.has(cell.columnId)) { columns.set(cell.columnId, match[1]!); usedColumns.add(match[1]!); }
    }
    for (const rowId of table.rowOrder) {
      const label = table.rows.find(row => row.id === rowId)?.label ?? "";
      const number = Number(label);
      if (!rows.has(rowId) && /^[1-9]\d*$/.test(label) && !usedRows.has(number)) { rows.set(rowId, number); usedRows.add(number); }
    }
    for (const columnId of table.columnOrder) {
      const label = table.columns.find(column => column.id === columnId)?.label ?? "";
      if (!columns.has(columnId) && /^[A-Z]+$/.test(label) && !usedColumns.has(label)) { columns.set(columnId, label); usedColumns.add(label); }
    }
    let nextRow = Math.max(0, ...usedRows) + 1;
    let nextColumn = Math.max(-1, ...[...usedColumns].map(columnIndex)) + 1;
    for (const rowId of table.rowOrder) if (!rows.has(rowId)) rows.set(rowId, nextRow++);
    for (const columnId of table.columnOrder) if (!columns.has(columnId)) columns.set(columnId, columnName(nextColumn++));
    for (const cell of table.cells) {
      const row = table.rows.find(item => item.id === cell.rowId);
      const legacyAddress = row?.label.match(/^@([^|]+)\|/)?.[1];
      if (legacyAddress) { codes.set(cell.id, legacyAddress); continue; }
      const metadataAddress = worksheet.stage === "EVALUASI_VENDOR"
        ? ({ "Pekerjaan / Material": "D5", Customer: "D6", Lokasi: "D7" } as Record<string, string>)[row?.label ?? ""] : undefined;
      if (metadataAddress) { codes.set(cell.id, `EV!${metadataAddress}`); continue; }
      const address = presentation.get(cell.id) || `${columns.get(cell.columnId)}${rows.get(cell.rowId)}`;
      const prefix = worksheet.stage === "EVALUASI_VENDOR" ? "EV" : worksheet.stage === "KONVERSI_JAGAD"
        ? cell.scope === "SOLAR_BAWAH" ? "SOLAR" : "INU"
        : cell.scope === "SOLAR_BAWAH" ? "AHS-SOLAR" : "AHS-INU";
      const tableSuffix = worksheet.stage === "EVALUASI_VENDOR" ? "" : `-T${tableIndex + 1}`;
      codes.set(cell.id, `${prefix}${tableSuffix}!${address}`);
    }
  }
  return codes;
}

function localFormulaCells(snapshot: WorkbookSnapshot, codes: ReadonlyMap<string, string>, targetCellId?: string) {
  const table = snapshot.worksheets.flatMap(worksheet => worksheet.tables).find(table => table.cells.some(cell => cell.id === targetCellId));
  if (snapshot.workbook) return table?.cells ?? [];
  const prefix = targetCellId ? codes.get(targetCellId)?.split("!")[0] : undefined;
  return prefix ? snapshot.worksheets.flatMap(worksheet => worksheet.tables.flatMap(table => table.cells))
    .filter(cell => codes.get(cell.id)?.split("!")[0] === prefix) : [];
}

export function displayFormula(expression: string, snapshot: WorkbookSnapshot, targetCellId?: string): string {
  const codes = cellCodes(snapshot);
  const localIds = new Set<string>(localFormulaCells(snapshot, codes, targetCellId).map(cell => cell.id));
  return mapFormulaCode(expression, codeExpression => displayCode(codeExpression.replace(/@\{([0-9a-fA-F-]+)\}/g, (token, id: string) => {
    const code = codes.get(id);
    return code && localIds.has(id) ? code.split("!").at(-1)! : code ? displayCode(code) : token;
  })));
}

export function describeFormula(expression: string, snapshot: WorkbookSnapshot): string {
  const codes = cellCodes(snapshot);
  return mapFormulaCode(expression, codeExpression => codeExpression.replace(/\s*\*\s*/g, " × ").replace(/\s*\/\s*/g, " ÷ ").replace(/@\{([0-9a-fA-F-]+)\}/g, (token, id: string) => {
    const worksheet = snapshot.worksheets.find(sheet => sheet.tables.some(table => table.cells.some(cell => cell.id === id)));
    const table = worksheet?.tables.find(item => item.cells.some(cell => cell.id === id));
    const cell = table?.cells.find(item => item.id === id);
    if (!table || !cell) return codes.get(id) ?? token;
    const label = table.columnOrder.slice(0, table.columnOrder.indexOf(cell.columnId)).reverse()
      .map(columnId => table.cells.find(item => item.rowId === cell.rowId && item.columnId === columnId)?.source)
      .find(source => source?.kind === "INPUT" && source.input.kind === "TEXT" && source.input.text.trim());
    const legacyVendor = /\|vendor:([^:]+):(.+)$/.exec(table.rows.find(row => row.id === cell.rowId)?.label ?? "");
    const rowName = label?.kind === "INPUT" && label.input.kind === "TEXT" ? label.input.text.trim().replace(/\s*:+$/, "") : legacyVendor?.[2] ?? "";
    if (!rowName) return displayCode(codes.get(id) ?? token);
    const offer = snapshot.workbook?.offers.find(item => item.columnId === cell.columnId && worksheet?.stage === "EVALUASI_VENDOR");
    const vendorCell = offer && table?.cells.find(item => item.id === offer.nameCellId);
    const vendorId = snapshot.analysis.offers.find(item => item.id === (offer?.offerId ?? legacyVendor?.[1]))?.vendorId;
    const vendorName = vendorCell?.source.kind === "INPUT" && vendorCell.source.input.kind === "TEXT" ? vendorCell.source.input.text.trim()
      : snapshot.analysis.vendors.find(vendor => vendor.id === vendorId)?.name ?? "";
    if (worksheet?.stage === "EVALUASI_VENDOR") return `${rowName} (${vendorName || table.columns.find(item => item.id === cell.columnId)?.label || "Vendor"})`;
    return `${rowName} (${worksheet?.stage === "KONVERSI_JAGAD" ? "Konversi" : "AHS"} ${cell.scope === "SOLAR_BAWAH" ? "Solar" : "INU"})`;
  }));
}

export function resolveFormula(expression: string, snapshot: WorkbookSnapshot, targetCellId?: string): string {
  if (expression.length > 16384) throw new Error("Rumus terlalu panjang.");
  const codes = cellCodes(snapshot);
  const matches = new Map<string, string[]>();
  for (const [id, code] of codes) for (const key of [code.toUpperCase(), displayCode(code).toUpperCase()]) {
    matches.set(key, [...(matches.get(key) ?? []), id]);
  }
  const localCells = localFormulaCells(snapshot, codes, targetCellId);
  const target = localCells.find(cell => cell.id === targetCellId);
  const addressPattern = "(?:(?:EV|INU|SOLAR|AHS-INU|AHS-SOLAR)(?:-T\\d+|\\d+)?!)?\\$?[A-Za-z]+\\$?[1-9]\\d*";
  let rangeMembers = 0;
  return mapFormulaCode(expression, codeExpression => {
    const expanded = codeExpression.replace(/\bSUM(?=\s*\()/gi, "SUM").replaceAll(";", ",")
      .replace(new RegExp(`(${addressPattern})\\s*:\\s*(${addressPattern})`, "gi"), (_, start: string, end: string) => {
        const split = (code: string) => { const parts = code.toUpperCase().replaceAll("$", "").split("!"); return parts.length > 1 ? parts : ["", parts[0]!]; };
        const [firstPrefix, first] = split(start), [lastPrefix, last] = split(end);
        if (firstPrefix && lastPrefix && firstPrefix !== lastPrefix) throw new Error("Rentang harus berada di bagian worksheet yang sama.");
        const from = /^([A-Z]+)(\d+)$/.exec(first!)!, to = /^([A-Z]+)(\d+)$/.exec(last!)!;
        const left = Math.min(columnIndex(from[1]!), columnIndex(to[1]!)), right = Math.max(columnIndex(from[1]!), columnIndex(to[1]!));
        const top = Math.min(Number(from[2]), Number(to[2])), bottom = Math.max(Number(from[2]), Number(to[2]));
        rangeMembers += (right - left + 1) * (bottom - top + 1);
        if (!Number.isSafeInteger(bottom) || !Number.isSafeInteger(right) || rangeMembers > 10000) throw new Error("Rentang melebihi batas worksheet.");
        const prefix = firstPrefix || lastPrefix;
        const members: string[] = [];
        for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) members.push(`${prefix ? prefix + "!" : ""}${columnName(col)}${row}`);
        return members.join(",");
      });
    return expanded.replace(/@\{[0-9a-fA-F-]+\}|\b(?:EV|INU|SOLAR|AHS-INU|AHS-SOLAR)(?:-T\d+|\d+)?!\$?[A-Za-z]+\$?\d+\b|(?<![!A-Za-z0-9_])\$?[A-Za-z]+\$?\d+\b/gi, token => {
      if (token.startsWith("@{")) return token;
      const code = token.toUpperCase().replaceAll("$", "");
      const ids = code.includes("!") ? matches.get(code) ?? [] : localCells.filter(cell =>
        (cell.scope === target?.scope || cell.scope === "SHARED") && codes.get(cell.id)?.split("!").at(-1)?.toUpperCase() === code).map(cell => cell.id);
      if (!ids.length) throw new Error(`Kode sel ${code} tidak ditemukan. Pilih sel sumber di kanvas.`);
      if (ids.length > 1) throw new Error(`Kode sel ${code} ambigu (${ids.length} sel). Pilih sel sumber di kanvas.`);
      return `@{${ids[0]}}`;
    });
  });
}

export function displayCellId(id: string, snapshot: WorkbookSnapshot): string {
  const code = cellCodes(snapshot).get(id);
  return code ? displayCode(code) : id;
}
