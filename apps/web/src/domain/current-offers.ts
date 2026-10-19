import type { WorkbookSnapshot, Offer } from "./contracts.ts";
import { createStableId as id } from "./ids.ts";
import { canonicalJson } from "./snapshots.ts";
import { changeWorkbook } from "./workflow.ts";

// The editor materializes inputs; storage writes each vendor input once in its offer.
export function refreshCurrentOffers(s: WorkbookSnapshot): WorkbookSnapshot {
  const tables = s.worksheets.filter(w => w.stage === "EVALUASI_VENDOR").flatMap(w => w.tables);
  const names = new Map<string, string>();
  const offers = s.analysis.offers.map(offer => {
    const column = s.workbook?.offers.find(o => o.offerId === offer.id);
    const values: Offer["values"][number][] = [];
    let hasCells = false;
    for (const table of tables) for (const cell of table.cells) {
      const marker = `|vendor:${offer.id}:`;
      const row = table.rows.find(r => r.id === cell.rowId)?.label ?? "";
      if (column ? cell.columnId !== column.columnId : !row.includes(marker)) continue;
      hasCells = true;
      if (cell.source.kind !== "INPUT") continue;
      const label = column ? cell.id : row.slice(row.indexOf(marker) + marker.length);
      values.push({ id: offer.values.find(v => v.label === label)?.id ?? id<"offer-value">(), label, input: cell.source.input });
      if ((column ? cell.id === column.nameCellId : label === "Nama vendor") && cell.source.input.kind === "TEXT" && cell.source.input.text.trim()) names.set(offer.vendorId, cell.source.input.text.trim());
    }
    return { ...offer, values: hasCells ? values : offer.values };
  });
  const vendors = s.analysis.vendors.map(v => names.has(v.id) ? { ...v, name: names.get(v.id)! } : v);
  if (canonicalJson(offers) === canonicalJson(s.analysis.offers) && canonicalJson(vendors) === canonicalJson(s.analysis.vendors)) return s;
  return changeWorkbook(s, { analysis: { ...s.analysis, offers, vendors } });
}
