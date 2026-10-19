function copyTable(source: HTMLTableElement, kind: string): HTMLTableElement {
  const table = source.cloneNode(true) as HTMLTableElement;
  table.className = `print-table print-${kind}`;
  table.removeAttribute("style");
  table.querySelectorAll(".vendor-table-actions").forEach(element => element.remove());
  table.querySelectorAll("input, select").forEach(element => element.remove());
  table.querySelectorAll("button").forEach(button => button.replaceWith(document.createTextNode(button.textContent ?? "")));
  table.querySelectorAll("[style], [tabindex], [title], [data-cell-id], [data-cell-code]").forEach(element => {
    for (const attribute of ["style", "tabindex", "title", "data-cell-id", "data-cell-code"]) element.removeAttribute(attribute);
  });
  table.querySelectorAll(".vendor-unselected, .cell-selected").forEach(element => element.classList.remove("vendor-unselected", "cell-selected"));
  return table;
}

function selectedVendorTable(source: HTMLTableElement, columnIndex: number): HTMLTableElement {
  const table = copyTable(source, "vendor");
  table.querySelectorAll("colgroup").forEach(group => group.remove());
  for (const row of Array.from(table.rows)) {
    const cells = Array.from(row.cells);
    if (row.classList.contains("vendor-meta")) {
      row.replaceChildren(...cells.slice(0, 2));
      for (const cell of Array.from(row.cells)) cell.colSpan = 1;
    } else if (cells[0] && cells[0].colSpan > 1) {
      row.replaceChildren(cells[0]); cells[0].colSpan = 2;
    } else {
      let offset = 0;
      const kept = cells.filter(cell => {
        const start = offset; offset += cell.colSpan;
        return start === 0 || (start <= columnIndex && columnIndex < offset);
      });
      row.replaceChildren(...kept);
      for (const cell of kept) cell.colSpan = 1;
    }
  }
  return table;
}

export async function printWorkbook(sheet: HTMLElement, vendorColumnIndex: number): Promise<void> {
  if (document.querySelector(".workbook-print-host")) return;
  const vendor = sheet.querySelector<HTMLTableElement>(".vendor-sheet");
  const conversion = Array.from(sheet.querySelectorAll<HTMLTableElement>(".conversion-sheet"));
  const ahs = Array.from(sheet.querySelectorAll<HTMLTableElement>(".ahs-sheet"));
  if (!vendor || !conversion.length || !ahs.length) throw new Error("Tabel laporan cetak belum lengkap.");
  const host = document.createElement("div");
  host.className = "workbook-print-host";
  host.setAttribute("aria-hidden", "true");
  const page = document.createElement("div"), report = document.createElement("div"), left = document.createElement("div"), right = document.createElement("div");
  page.className = "workbook-print-page"; report.className = "workbook-print-report";
  left.className = "print-left"; right.className = "print-right";
  left.append(selectedVendorTable(vendor, vendorColumnIndex), ...conversion.map(table => copyTable(table, "conversion")));
  right.append(...ahs.map(table => copyTable(table, "ahs")));
  report.append(left, right); page.append(report); host.append(page);
  document.body.append(host);
  const cleanup = () => { host.remove(); window.removeEventListener("afterprint", cleanup); };
  try {
    await document.fonts.ready;
    const scale = Math.min(1, page.clientWidth / Math.max(report.scrollWidth, 1), page.clientHeight / Math.max(report.scrollHeight, 1));
    report.style.transform = `scale(${scale})`;
    window.addEventListener("afterprint", cleanup);
    window.print();
  } catch (error) { cleanup(); throw error; }
}
