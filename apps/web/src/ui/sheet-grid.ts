import type { CellSnapshot, TableSnapshot } from "../domain/contracts.ts";
import { requireCondition } from "../domain/validation.ts";
import { DecimalArithmetic } from "../engine/decimal.ts";

// Display rounding never changes the stored value or converts money through Number.
export function sheetNumber(text: string, decimals = 2): string {
  if (/^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(text)) return "";
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return text;
  const decimal = new DecimalArithmetic({ scale: decimals, rounding: "HALF_UP", roundAt: "EVERY_OPERATION" });
  let rounded: bigint;
  try { rounded = decimal.parse(text); }
  catch (error) {
    // Raw inputs can render before the engine reports invalid numbers or numeric limits.
    if (error instanceof RangeError || error instanceof TypeError) return text;
    throw error;
  }
  if (rounded === 0n) return "";
  const [whole, fraction = ""] = decimal.format(rounded).split(".");
  const shownFraction = fraction.padEnd(Math.min((match[3] ?? "").length, decimals), "0");
  return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (shownFraction ? "," + shownFraction : "");
}

export function sheetNumberFixed(text: string, decimals = 2): string {
  const shown = sheetNumber(text, decimals);
  if (!shown || !shown.includes(",")) return shown ? shown + "," + "0".repeat(decimals) : shown;
  const [whole, fraction = ""] = shown.split(",");
  return `${whole},${fraction.padEnd(decimals, "0")}`;
}

// Spreadsheet-style percentage display for ratio values (0.125 -> 12,50%).
export function sheetPercent(text: string): string {
  const match = /^([+-]?)((?:\d+))(?:\.(\d*))?$/.exec(text);
  if (!match) return text;
  const fraction = match[3] ?? "";
  const whole = (match[2]! + fraction.padEnd(2, "0").slice(0, 2)).replace(/^0+(?=\d)/, "");
  const remainder = fraction.slice(2);
  const shown = sheetNumberFixed(match[1] + whole + (remainder ? "." + remainder : ""));
  return shown ? shown + "%" : "";
}

// Presentation-only grid: it never changes values, membership or identity.
export interface GridCell {
  readonly cell: CellSnapshot | null;
  readonly rowSpan: number;
  readonly colSpan: number;
}

// Hidden rows must also be removed from rowspans, otherwise the following group shifts columns.
export function visibleSheetTable(table: TableSnapshot, hiddenRows: ReadonlySet<string>): TableSnapshot {
  if (!hiddenRows.size) return table;
  return {
    ...table,
    rows: table.rows.filter(row => !hiddenRows.has(row.id)),
    rowOrder: table.rowOrder.filter(rowId => !hiddenRows.has(rowId)),
    cells: table.cells.filter(cell => !hiddenRows.has(cell.rowId)),
    merges: table.merges.flatMap(merge => {
      const anchor = table.cells.find(cell => cell.id === merge.anchorCellId);
      requireCondition(anchor, "Merge anchor is not a cell of this table.");
      if (hiddenRows.has(anchor.rowId)) return [];
      const start = table.rowOrder.indexOf(anchor.rowId);
      const rowSpan = table.rowOrder.slice(start, start + merge.rowSpan).filter(rowId => !hiddenRows.has(rowId)).length;
      return [{ ...merge, rowSpan }];
    }),
  };
}

// A visual-only merge keeps every covered cell by ID; covered positions render as null
// (skipped), the anchor carries the span. Sparse gaps keep a table position.
export function buildSheetGrid(table: TableSnapshot): readonly (readonly (GridCell | null)[])[] {
  const rowCount = table.rowOrder.length, columnCount = table.columnOrder.length;
  const cells = new Map(table.cells.map(cell => [cell.rowId + ":" + cell.columnId, cell]));
  const covered = new Set<string>();
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  for (const merge of table.merges) {
    const anchor = table.cells.find(cell => cell.id === merge.anchorCellId);
    requireCondition(anchor, "Merge anchor is not a cell of this table.");
    const atRow = table.rowOrder.indexOf(anchor!.rowId), atColumn = table.columnOrder.indexOf(anchor!.columnId);
    requireCondition(atRow >= 0 && atColumn >= 0, "Merge anchor is not positioned in this table.");
    requireCondition(atRow + merge.rowSpan <= rowCount && atColumn + merge.colSpan <= columnCount,
      "Merge extends beyond the table bounds.");
    spans.set(anchor!.id, { rowSpan: merge.rowSpan, colSpan: merge.colSpan });
    for (let row = atRow; row < atRow + merge.rowSpan; row++) {
      for (let column = atColumn; column < atColumn + merge.colSpan; column++) {
        if (row === atRow && column === atColumn) continue;
        covered.add(table.rowOrder[row] + ":" + table.columnOrder[column]);
      }
    }
  }
  return table.rowOrder.map(rowId => table.columnOrder.map(columnId => {
    if (covered.has(rowId + ":" + columnId)) return null;
    const cell = cells.get(rowId + ":" + columnId);
    if (!cell) return { cell: null, rowSpan: 1, colSpan: 1 };
    const span = spans.get(cell.id);
    return { cell, rowSpan: span?.rowSpan ?? 1, colSpan: span?.colSpan ?? 1 };
  }));
}
