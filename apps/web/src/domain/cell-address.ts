import type { WorkbookSnapshot } from "./contracts.ts";
import { canvasCellAddresses, externalCellAddresses, columnName } from "./canvas-address.ts";
import { ahsGroups, ahsLabel, ahsRoleCell } from "./ahs-groups.ts";
import { vendorComponents } from "./vendor-components.ts";

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
  const external = { INU: externalCellAddresses(snapshot, "INU"), SOLAR_BAWAH: externalCellAddresses(snapshot, "SOLAR_BAWAH") };
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
      if (worksheet.stage === "AHS_EXTERNAL") { codes.set(cell.id, `EXTERNAL!${external[cell.scope === "SHARED" ? snapshot.activeProfile : cell.scope].get(cell.id)}`); continue; }
      const row = table.rows.find(item => item.id === cell.rowId);
      if (row?.label.startsWith("vendor-profile|")) {
        codes.set(cell.id, `VP!${columns.get(cell.columnId)}${rows.get(cell.rowId)}`);
        continue;
      }
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

function formulaProfile(snapshot: WorkbookSnapshot, targetCellId?: string) {
  const cell = snapshot.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(c => c.id === targetCellId);
  return cell && cell.scope !== "SHARED" ? cell.scope : snapshot.activeProfile;
}

export function displayFormula(expression: string, snapshot: WorkbookSnapshot, targetCellId?: string): string {
  const profile = formulaProfile(snapshot, targetCellId);
  const internal = canvasCellAddresses(snapshot, profile), external = externalCellAddresses(snapshot, profile);
  const externalTarget = targetCellId && external.has(targetCellId);
  return mapFormulaCode(expression, codeExpression => codeExpression.replace(/@\{([0-9a-fA-F-]+)\}/g, (token, id: string) => externalTarget ? external.get(id) ?? (internal.has(id) ? `INTERNAL!${internal.get(id)}` : token) : internal.get(id) ?? token));
}

export function describeCell(id: string, snapshot: WorkbookSnapshot): string {
    const worksheet = snapshot.worksheets.find(sheet => sheet.tables.some(table => table.cells.some(cell => cell.id === id)));
    const table = worksheet?.tables.find(item => item.cells.some(cell => cell.id === id));
    const cell = table?.cells.find(item => item.id === id);
    if (!table || !cell) return "Sel tidak tersedia";
    if (worksheet?.stage === "AHS" && cell.scope !== "SHARED") {
      const field = snapshot.ahsFields?.find(field => field.valueCellId === id || field.labelCellId === id);
      if (field) return `AHS › ${field.section === "INFORMASI" ? "Informasi" : "Laba"} › ${ahsLabel(snapshot, field)}`;
      const groups = ahsRoleCell(snapshot, cell.scope, "I33", "RESIKO · Kenaikan Harga")
        ? [...ahsGroups(snapshot, cell.scope, "PENDAPATAN"), ...ahsGroups(snapshot, cell.scope, "BIAYA")]
        : snapshot.ahsGroups?.filter(g => g.profile === cell.scope) ?? [];
      for (const group of groups) {
        const name = ahsLabel(snapshot, group);
        if (group.labelCellId === id) return `AHS › ${name}`;
        const item = group.items.find(item => [item.labelCellId, item.priceCellId, item.volumeCellId, item.totalCellId].includes(cell.id));
        if (item) return `AHS › ${name} › ${ahsLabel(snapshot, item)}${item.volumeCellId === id ? " › Volume" : item.totalCellId === id ? " › Total" : ""}`;
      }
    }
    const label = table.columnOrder.slice(0, table.columnOrder.indexOf(cell.columnId)).reverse()
      .map(columnId => table.cells.find(item => item.rowId === cell.rowId && item.columnId === columnId)?.source)
      .find(source => source?.kind === "INPUT" && source.input.kind === "TEXT" && source.input.text.trim());
    const legacyVendor = /\|vendor:([^:]+):(.+)$/.exec(table.rows.find(row => row.id === cell.rowId)?.label ?? "");
    const component = legacyVendor ? vendorComponents(snapshot, legacyVendor[1]!).find(c => c.source.id === cell.id) : undefined;
    const componentSource = component?.labelCell?.source;
    const componentName = componentSource?.kind === "INPUT" && componentSource.input.kind === "TEXT" ? componentSource.input.text
      : component ? /^[0-9a-f-]{36}$/.test(component.role) ? "Uraian tambahan" : component.role : undefined;
    const rowLabel = table.rows.find(row => row.id === cell.rowId)?.label ?? "";
    const ownText = cell.source.kind === "INPUT" && cell.source.input.kind === "TEXT" ? cell.source.input.text.trim() : "";
    const rowName = label?.kind === "INPUT" && label.input.kind === "TEXT" ? label.input.text.trim().replace(/\s*:+$/, "")
      : componentName ?? legacyVendor?.[2] ?? (rowLabel && !/^(?:@|\d|ahs-field$|ahs-extra$|ahs-item:|component:|vendor-extra:)/.test(rowLabel) ? rowLabel : ownText);
    const offer = snapshot.workbook?.offers.find(item => item.columnId === cell.columnId && worksheet?.stage === "EVALUASI_VENDOR");
    const vendorCell = offer && table?.cells.find(item => item.id === offer.nameCellId);
    const vendorId = snapshot.analysis.offers.find(item => item.id === (offer?.offerId ?? legacyVendor?.[1]))?.vendorId;
    const vendorName = vendorCell?.source.kind === "INPUT" && vendorCell.source.input.kind === "TEXT" ? vendorCell.source.input.text.trim()
      : snapshot.analysis.vendors.find(vendor => vendor.id === vendorId)?.name ?? "";
    const stage = worksheet?.stage === "EVALUASI_VENDOR" ? "Evaluasi Vendor" : worksheet?.stage === "KONVERSI_JAGAD" ? "Konversi" : "AHS";
    return [stage, vendorName, rowName.replaceAll(" · ", " › ") || displayCellId(id, snapshot)].filter(Boolean).join(" › ");
}

export function describeFormula(expression: string, snapshot: WorkbookSnapshot): string {
  return mapFormulaCode(expression, codeExpression => codeExpression.replace(/\s*\*\s*/g, " × ").replace(/\s*\/\s*/g, " ÷ ")
    .replace(/@\{([0-9a-fA-F-]+)\}/g, (_, id: string) => describeCell(id, snapshot)));
}

export function resolveFormula(expression: string, snapshot: WorkbookSnapshot, targetCellId?: string): string {
  if (expression.length > 16384) throw new Error("Rumus terlalu panjang.");
  const codes = cellCodes(snapshot);
  const matches = new Map<string, Set<string>>();
  for (const [id, code] of codes) for (const key of [code.toUpperCase(), displayCode(code).toUpperCase()]) {
    const ids = matches.get(key) ?? new Set<string>(); ids.add(id); matches.set(key, ids);
  }
  const profile = formulaProfile(snapshot, targetCellId);
  const internal = canvasCellAddresses(snapshot, profile), external = externalCellAddresses(snapshot, profile);
  const addresses = new Map([...(targetCellId && external.has(targetCellId) ? external : internal)].map(([id, address]) => [address, id]));
  for (const [prefix, cells] of [["INTERNAL", internal], ["EXTERNAL", external]] as const) for (const [id, address] of cells) matches.set(`${prefix}!${address}`, new Set([id]));
  const addressPattern = "(?:(?:EV|INU|SOLAR|AHS-INU|AHS-SOLAR|INTERNAL|EXTERNAL)(?:-T\\d+|\\d+)?!)?\\$?[A-Za-z]+\\$?[1-9]\\d*";
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
    return expanded.replace(/@\{[0-9a-fA-F-]+\}|\b(?:EV|INU|SOLAR|AHS-INU|AHS-SOLAR|INTERNAL|EXTERNAL)(?:-T\d+|\d+)?!\$?[A-Za-z]+\$?\d+\b|(?<![!A-Za-z0-9_])\$?[A-Za-z]+\$?\d+\b/gi, token => {
      if (token.startsWith("@{")) return token;
      const code = token.toUpperCase().replaceAll("$", "");
      const ids = code.includes("!") ? [...matches.get(code) ?? []] : addresses.has(code) ? [addresses.get(code)!] : [];
      if (!ids.length) throw new Error(`Kode sel ${code} tidak ditemukan. Pilih sel sumber di kanvas.`);
      if (ids.length > 1) throw new Error(`Kode sel ${code} ambigu (${ids.length} sel). Pilih sel sumber di kanvas.`);
      return `@{${ids[0]}}`;
    });
  });
}

export function displayCellId(id: string, snapshot: WorkbookSnapshot): string {
  return canvasCellAddresses(snapshot).get(id) ?? "Sel tidak tersedia";
}
