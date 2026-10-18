import type { CellSnapshot, WorkbookSnapshot } from "./contracts.ts";

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
    if (!(number >= 10 && number <= 17) && !(extra && labelCell && hasLabel)) continue;
    const role = number >= 10 && number <= 17 ? vendorComponentRoles[number - 10]! : source.id;
    components.push({ source, labelCell, role });
  }
  return components;
}
