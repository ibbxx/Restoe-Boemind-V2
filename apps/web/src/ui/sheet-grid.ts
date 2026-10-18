import type { CellSnapshot, TableSnapshot } from "../domain/contracts.ts";
import { requireCondition } from "../domain/validation.ts";

// Display formatting only: grouping the original decimal string never rounds or converts money through Number.
export function sheetNumber(text: string, decimals = 2): string {
  if (/^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(text)) return "";
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return text;
  const fraction = (match[3] ?? "").slice(0, decimals);
  return match[1] + match[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (fraction ? "," + fraction : "");
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
  let digits = match[2]! + (match[3] ?? "");
  let point = match[2]!.length + 2;
  if (/^0+$/.test(digits)) return "";
  while (digits.length > 1 && digits.startsWith("0")) { digits = digits.slice(1); point--; }
  const shifted = point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point) + "." + digits.slice(point);
  return match[1] + sheetNumber(shifted, 2) + "%";
}

// Presentation-only grid: it never changes values, membership or identity.
export interface GridCell {
  readonly cell: CellSnapshot | null;
  readonly rowSpan: number;
  readonly colSpan: number;
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
