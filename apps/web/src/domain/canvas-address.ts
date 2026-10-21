import type { CellSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "./contracts.ts";
import type { Profile } from "./profiles.ts";
import { ahsGroups } from "./ahs-groups.ts";
import { ahsFields } from "./ahs-fields.ts";
import { vendorComponents, vendorComponentRoles } from "./vendor-components.ts";
import { requireCondition } from "./validation.ts";

const cache = new WeakMap<WorkbookSnapshot, Map<Profile, ReadonlyMap<string, string>>>();

export function columnName(index: number): string {
  let name = "";
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) name = String.fromCharCode(65 + (number - 1) % 26) + name;
  return name;
}

// One logical canvas per profile; responsive CSS and database table indexes never determine addresses.
export function canvasCellAddresses(s: WorkbookSnapshot, profile: Profile = s.activeProfile): ReadonlyMap<string, string> {
  const cached = cache.get(s)?.get(profile);
  if (cached) return cached;
  const addresses = new Map<string, string>(), occupied = new Map<string, string>();
  const worksheets = s.worksheets.map(w => ({ ...w, tables: w.tables.filter(t => t.cells.some(c => c.scope === "SHARED" || c.scope === profile)) }));
  const cells = worksheets.flatMap(w => w.tables.flatMap(t => t.cells.filter(c => c.scope === "SHARED" || c.scope === profile)));
  const put = (cell: CellSnapshot | undefined, row: number, column: number) => {
    if (!cell) return;
    const address = columnName(column) + (row + 1);
    requireCondition(!addresses.has(cell.id) || addresses.get(cell.id) === address, "Sel mempunyai dua posisi pada kanvas.");
    requireCondition(!occupied.has(address) || occupied.get(address) === cell.id, `Alamat ${address} bertabrakan pada kanvas.`);
    addresses.set(cell.id, address); occupied.set(address, cell.id);
  };
  let vendorWidth = Math.max(4, s.analysis.offers.length + 1), vendorHeight = 0, conversionHeight = 0, ahsHeight = 0;
  if (s.workbook) {
    const metadata = new Map(s.workbook.cells.map(p => [p.cellId, p.address]));
    const vendors = worksheets.find(w => w.stage === "EVALUASI_VENDOR");
    vendorWidth = Math.max(vendorWidth, ...vendors?.tables.map(t => t.columnOrder.length) ?? []);
    const place = (stage: WorksheetSnapshot["stage"], top: number, left: number) => {
      let row = top;
      for (const table of worksheets.find(w => w.stage === stage)?.tables ?? []) {
        const rows = table.rowOrder.filter(rowId => {
          if (stage !== "KONVERSI_JAGAD" || profile !== "SOLAR_BAWAH") return true;
          const address = table.cells.filter(c => c.rowId === rowId).map(c => metadata.get(c.id)).find(Boolean);
          const number = Number(address?.match(/\d+$/)?.[0]) + 1;
          return !(number >= 37 && number <= 42);
        });
        const positions = new Map(rows.map((id, index) => [id, row + index]));
        for (const cell of table.cells) {
          const at = positions.get(cell.rowId);
          if (at !== undefined && (cell.scope === profile || cell.scope === "SHARED")) put(cell, at, left + table.columnOrder.indexOf(cell.columnId));
        }
        row += rows.length + 1;
      }
      return Math.max(0, row - top - 1);
    };
    vendorHeight = place("EVALUASI_VENDOR", 0, 0);
    conversionHeight = place("KONVERSI_JAGAD", vendorHeight + 1, 0);
    ahsHeight = place("AHS", 0, vendorWidth + 1);
  } else {
    const fields = new Map<string, CellSnapshot>();
    for (const w of worksheets) for (const table of w.tables) for (const cell of table.cells) {
      if (cell.scope !== profile && cell.scope !== "SHARED") continue;
      const label = table.rows.find(r => r.id === cell.rowId)?.label;
      if (label) fields.set(`${w.stage}:${label}`, cell);
    }
    const find = (stage: WorksheetSnapshot["stage"], label: string) => fields.get(`${stage}:${label}`);
    const ev = (address: string) => [...fields.entries()].find(([key]) => key.startsWith(`EVALUASI_VENDOR:@EV!${address}|`))?.[1];
    for (const [index, address] of ["B3", "B4", "B5", "B6", "B7", "B8", "B9"].entries()) put(ev(address), index, 0);
    for (const [index, label] of ["Pekerjaan / Material", "Customer", "Lokasi"].entries()) put(find("EVALUASI_VENDOR", label), index + 2, 2);
    const components = new Map<string, ReturnType<typeof vendorComponents>>(s.analysis.offers.map(offer => [offer.id, vendorComponents(s, offer.id)]));
    const rows = (components.get(s.analysis.offers[0]?.id ?? "") ?? []).filter(c => c.role !== "TOTAL");
    for (const [index, component] of rows.entries()) put(component.labelCell, index + 7, 0);
    const totalRow = rows.length + 7;
    put(ev("B17"), totalRow, 0); put(ev("B18"), totalRow + 1, 0);
    for (const [index, offer] of s.analysis.offers.entries()) {
      const offerField = (name: string) => [...fields.entries()].find(([key]) => key.startsWith("EVALUASI_VENDOR:") && key.endsWith(`|vendor:${offer.id}:${name}`))?.[1];
      put(offerField("Nama vendor"), 6, index + 1);
      for (const component of components.get(offer.id) ?? []) {
        const at = component.role === "TOTAL" ? totalRow : 7 + rows.findIndex(row =>
          row.labelCell ? row.labelCell.id === component.labelCell?.id : row.role === component.role);
        if (at >= 7) put(component.source, at, index + 1);
      }
      put(offerField("Notes"), totalRow + 1, index + 1);
    }
    vendorHeight = totalRow + 2;
    const conversionTop = vendorHeight + 1;
    put(find("KONVERSI_JAGAD", "Periode"), conversionTop + 2, 0);
    put(find("KONVERSI_JAGAD", "Lokasi"), conversionTop + 3, 1);
    const selected = components.get(s.selectedOfferId ?? "") ?? [];
    const conversionRows = selected.length ? selected.map(component => vendorComponentRoles.some(role => role === component.role)
      ? component.role === "TOTAL" ? "ALL IN" : component.role : `vendor-extra:${component.labelCell?.id ?? component.source.id}`)
      : vendorComponentRoles.map(role => role === "TOTAL" ? "ALL IN" : role);
    for (const [index, key] of conversionRows.entries()) for (const [column, name] of ["Harga INU", "Biaya"].entries()) {
      put(find("KONVERSI_JAGAD", `${name} · ${key}`), conversionTop + 7 + index, column + 1);
    }
    conversionHeight = 7 + conversionRows.length;
    if (profile === "INU") {
      for (const [index, name] of ["Gross Profit", "BPH Migas", "Net Margin", "PPH", "Profit MUE"].entries()) put(find("KONVERSI_JAGAD", name), conversionTop + conversionHeight + 1 + index, 1);
      conversionHeight += 6;
    }
    const left = vendorWidth + 1;
    const caption = (column: string, number: number) => {
      const address = column + (number - (profile === "SOLAR_BAWAH" ? 1 : 0));
      return [...fields.entries()].find(([key]) => key.startsWith(`AHS:@AHS-${profile === "INU" ? "INU" : "SOLAR"}!${address}|`))?.[1];
    };
    const itemRow = (cellId: string, row: number) => {
      const table = worksheets.find(w => w.stage === "AHS")?.tables.find(t => t.cells.some(c => c.id === cellId));
      const cell = table?.cells.find(c => c.id === cellId);
      if (table?.columns.length === 6 && cell) for (const entry of table.cells.filter(c => c.rowId === cell.rowId)) {
        put(entry, row, left + table.columnOrder.indexOf(entry.columnId));
      }
    };
    const summary = (name: string, number: number, row: number) => {
      put(caption("G", number), row, left); put(find("AHS", name), row, left + 5);
    };
    put(caption("G", 3), 0, left);
    for (const [index, pair] of [["Tgl Analisis (Rn)", "Sumber"], ["Marketing", "Lokasi"], ["Pembayaran", "Dokumen"]].entries()) {
      for (const [column, label] of pair.entries()) {
        put(caption(column ? "J" : "G", index + 4), index + 1, left + column * 3);
        put(find("AHS", label), index + 1, left + column * 3 + 1);
      }
    }
    let row = 5;
    for (const field of ahsFields(s, "INFORMASI", profile)) {
      itemRow(field.valueCellId, row); put(cells.find(c => c.id === field.labelCellId), row, left);
      put(cells.find(c => c.id === field.valueCellId), row++, left + 3);
    }
    put(caption("G", 8), row, left); put(find("AHS", "Harga Include"), row++, left + 3);
    summary("TOTAL PENDAPATAN", 9, row++); summary("HARGA JUAL SETELAH PAJAK", 10, row++);
    const groups = (section: "PENDAPATAN" | "BIAYA") => {
      if (!find("AHS", "Harga Jual · Harga Dasar")) return;
      for (const group of ahsGroups(s, profile, section)) for (const [index, item] of group.items.entries()) {
        itemRow(item.priceCellId, row);
        if (index === 0) put(cells.find(c => c.id === group.labelCellId), row, left);
        for (const [column, id] of [item.labelCellId, item.priceCellId, item.volumeCellId, item.totalCellId].entries()) put(cells.find(c => c.id === id), row, left + column + 1);
        row++;
      }
    };
    groups("PENDAPATAN"); summary("TOTAL BIAYA", 14, row++); summary("BIAYA PER LITER", 15, row++); groups("BIAYA");
    for (const [index, name] of ["LABA KOTOR", "SELISIH PPN", "LABA BERSIH", "LABA BERSIH PER LITER", "PERSENTASE"].entries()) summary(name, index + 34, row++);
    for (const field of ahsFields(s, "LABA", profile)) {
      itemRow(field.valueCellId, row); put(cells.find(c => c.id === field.labelCellId), row, left);
      put(cells.find(c => c.id === field.valueCellId), row++, left + 5);
    }
    put(caption("G", 39), row++, left); put(find("AHS", "Notes"), row++, left);
    ahsHeight = row;
  }
  const width = vendorWidth + 7, bottom = Math.max(vendorHeight + 1 + conversionHeight, ahsHeight) + 1;
  let hidden = 0;
  for (const cell of cells) if (!addresses.has(cell.id)) {
    put(cell, bottom + Math.floor(hidden / width), hidden % width); hidden++;
  }
  const profiles = cache.get(s) ?? new Map<Profile, ReadonlyMap<string, string>>();
  profiles.set(profile, addresses); cache.set(s, profiles);
  return addresses;
}
