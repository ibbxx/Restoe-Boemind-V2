function copyTable(source: HTMLTableElement, kind: string): HTMLTableElement {
  const table = source.cloneNode(true) as HTMLTableElement;
  table.className = `print-table print-${kind}`;
  table.removeAttribute("style");
  table.querySelectorAll(".vendor-table-actions, .cell-formula-preview, dialog").forEach(element => element.remove());
  table.querySelectorAll("input, select").forEach(element => element.remove());
  table.querySelectorAll("button").forEach(button => button.replaceWith(document.createTextNode(button.textContent ?? "")));
  table.querySelectorAll("[style], [tabindex], [title], [data-cell-id], [data-cell-code]").forEach(element => {
    for (const attribute of ["style", "tabindex", "title", "data-cell-id", "data-cell-code"]) element.removeAttribute(attribute);
  });
  table.querySelectorAll(".vendor-unselected, .cell-selected").forEach(element => element.classList.remove("vendor-unselected", "cell-selected"));
  table.querySelectorAll('[class*="cell-reference-"]').forEach(element => {
    element.classList.remove(...Array.from(element.classList).filter(name => name.startsWith("cell-reference-")));
  });
  return table;
}

export function vendorTables(source: HTMLTableElement, columnIndexes: readonly number[]): HTMLTableElement[] {
  if (!columnIndexes.length || new Set(columnIndexes).size !== columnIndexes.length ||
    columnIndexes.some(index => !Number.isInteger(index) || index < 1)) {
    throw new Error("Daftar kolom vendor untuk cetak tidak valid.");
  }
  const tables: HTMLTableElement[] = [];
  for (let start = 0; start < columnIndexes.length; start += 3) {
    const columns = [0, ...columnIndexes.slice(start, start + 3)];
    const table = copyTable(source, "vendor");
    table.querySelectorAll("colgroup").forEach(group => group.remove());
    const occupiedUntil = new Map<number, number>();
    let width = 0;
    for (const [rowIndex, row] of Array.from(table.rows).entries()) {
      let offset = 0;
      const cells = Array.from(row.cells);
      const kept = cells.filter(cell => {
        while ((occupiedUntil.get(offset) ?? 0) > rowIndex) offset++;
        const first = offset, end = offset + cell.colSpan;
        for (; offset < end; offset++) occupiedUntil.set(offset, rowIndex + cell.rowSpan);
        width = Math.max(width, end);
        const span = columns.filter(column => first <= column && column < end).length;
        if (span) cell.colSpan = span;
        return span > 0;
      });
      // Project metadata spans vendor columns but belongs on every page.
      if (row.classList.contains("vendor-meta") && cells.length === 2) {
        cells[0]!.colSpan = 1;
        cells[1]!.colSpan = columns.length - 1;
        row.replaceChildren(...cells);
      } else row.replaceChildren(...kept);
    }
    if (columns.some(column => column >= width)) throw new Error("Kolom vendor untuk cetak tidak ditemukan.");
    tables.push(table);
  }
  return tables;
}

export async function printWorkbook(sheet: HTMLElement, vendorColumnIndexes: readonly number[], title: string): Promise<void> {
  if (document.querySelector(".workbook-print-host")) return;
  const vendor = sheet.querySelector<HTMLTableElement>(".vendor-sheet");
  const conversion = Array.from(sheet.querySelectorAll<HTMLTableElement>(".conversion-sheet"));
  const ahs = Array.from(sheet.querySelectorAll<HTMLTableElement>(".ahs-sheet"));
  if (!vendor || !conversion.length || !ahs.length) throw new Error("Tabel laporan cetak belum lengkap.");
  const host = document.createElement("div");
  host.className = "workbook-print-host";
  host.setAttribute("aria-hidden", "true");
  let previousTitle: string | undefined;
  const cleanup = () => {
    host.remove(); window.removeEventListener("afterprint", cleanup);
    if (previousTitle !== undefined) { document.title = previousTitle; previousTitle = undefined; }
  };
  try {
    const vendors = vendorTables(vendor, vendorColumnIndexes);
    for (const table of vendors) {
      const page = document.createElement("div"), report = document.createElement("div"), left = document.createElement("div"), right = document.createElement("div");
      page.className = "workbook-print-page"; report.className = "workbook-print-report";
      left.className = "print-left"; right.className = "print-right";
      left.append(table, ...conversion.map(table => copyTable(table, "conversion")));
      right.append(...ahs.map(table => copyTable(table, "ahs")));
      report.append(left, right); page.append(report); host.append(page);
    }
    document.body.append(host);
    await document.fonts.ready;
    window.addEventListener("afterprint", cleanup);
    previousTitle = document.title;
    document.title = title;
    window.print();
  } catch (error) { cleanup(); throw error; }
}

export function workbookPrintTitle({ projectName, analysisName, volume, material }: { projectName: string; analysisName: string; volume: string; material: string }): string {
  const clean = (value: string) => value.replace(/[\p{Cc}<>:"/\\|?*]/gu, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  const volumeText = clean(volume);
  return [`PROYEK ${clean(projectName)}`.trim(), clean(analysisName), volumeText ? `${volumeText} L` : "", clean(material)].filter(Boolean).join(" - ");
}
