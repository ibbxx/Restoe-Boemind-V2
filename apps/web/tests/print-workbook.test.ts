import assert from "node:assert/strict";
import { test } from "node:test";
import { vendorTables } from "../src/ui/print-workbook.ts";

// Table-only DOM fixture; browser pagination and print-dialog behavior remain manual checks.
class Cell {
  constructor(public textContent: string, public colSpan = 1, public rowSpan = 1, public className = "") {}
  classList = {
    remove: (...names: string[]) => { this.className = this.className.split(" ").filter(name => !names.includes(name)).join(" "); },
  };
}
class Row {
  constructor(public cells: Cell[], public className = "") {}
  classList = { contains: (name: string) => this.className.split(" ").includes(name) };
  replaceChildren(...cells: Cell[]) { this.cells = cells; }
}
class Table {
  className = "vendor-sheet";
  constructor(public rows: Row[]) {}
  removeAttribute() {}
  cloneNode() {
    return new Table(this.rows.map(row => new Row(row.cells.map(cell => new Cell(cell.textContent, cell.colSpan, cell.rowSpan, cell.className)), row.className)));
  }
  querySelectorAll(selector: string) {
    if (selector === ".vendor-unselected, .cell-selected") {
      return this.rows.flatMap(row => row.cells.filter(cell => /vendor-unselected|cell-selected/.test(cell.className)));
    }
    return [];
  }
}
const dom = (table: Table) => table as unknown as HTMLTableElement;
const fixture = (count: number) => new Table([
  new Row([new Cell("Evaluasi Vendor", count + 1)], "vendor-title"),
  new Row([new Cell("Customer", 2), new Cell("Proyek aktif", Math.max(1, count - 1))], "vendor-meta"),
  new Row([new Cell("Uraian"), ...Array.from({ length: count }, (_, index) => new Cell(`Vendor ${index + 1}`, 1, 1, "vendor-unselected"))], "vendor-columns"),
  new Row([new Cell("Harga"), ...Array.from({ length: count }, (_, index) => new Cell(index === 1 ? "" : `${index + 1}.000,25`))]),
  new Row([new Cell("TOTAL"), ...Array.from({ length: count }, (_, index) => new Cell(`Hasil rumus ${index + 1}`))], "vendor-total"),
  new Row([new Cell("Notes"), ...Array.from({ length: count }, (_, index) => new Cell(`Catatan vendor ${index + 1}`))], "vendor-notes"),
]);

for (const count of [1, 3, 4, 7, 10, 100]) {
  test(`${count} vendors print exactly once, at most three per page`, () => {
    const source = fixture(count);
    const original = JSON.stringify(source);
    const tables = vendorTables(dom(source), Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(tables.length, Math.ceil(count / 3));
    const names: string[] = [];
    for (const [index, table] of tables.entries()) {
      const groupSize = Math.min(3, count - index * 3);
      const rows = Array.from(table.rows);
      assert.equal(rows[0]!.cells[0]!.colSpan, groupSize + 1);
      assert.equal(rows[1]!.cells[1]!.textContent, "Proyek aktif");
      assert.equal(rows[1]!.cells[0]!.colSpan, 1);
      assert.equal(rows[1]!.cells[1]!.colSpan, groupSize);
      const headers = Array.from(rows[2]!.cells).slice(1);
      assert.equal(headers.length, groupSize);
      names.push(...headers.map(cell => cell.textContent!));
      for (const [offset, cell] of headers.entries()) {
        assert.equal(cell.className, "");
        assert.equal(rows[4]!.cells[offset + 1]!.textContent, `Hasil rumus ${index * 3 + offset + 1}`);
        assert.equal(rows[5]!.cells[offset + 1]!.textContent, `Catatan vendor ${index * 3 + offset + 1}`);
      }
    }
    assert.deepEqual(names, Array.from({ length: count }, (_, index) => `Vendor ${index + 1}`));
    if (count >= 2) assert.equal(tables[0]!.rows[3]!.cells[2]!.textContent, "");
    assert.equal(JSON.stringify(source), original, "printing must leave the source worksheet intact");
  });
}

test("reordered vendors and column gaps preserve the displayed worksheet order", () => {
  const source = fixture(7);
  source.rows[2]!.cells[1]!.textContent = "Vendor dipindahkan ke depan";
  const pages = vendorTables(dom(source), [1, 2, 5, 7]);
  assert.deepEqual(pages.map(page => Array.from(page.rows[2]!.cells).map(cell => cell.textContent)), [
    ["Uraian", "Vendor dipindahkan ke depan", "Vendor 2", "Vendor 5"], ["Uraian", "Vendor 7"],
  ]);
});

test("horizontal and vertical merges keep their projected spans", () => {
  const source = new Table([
    new Row([new Cell("Uraian", 1, 2), new Cell("Gabungan", 2), new Cell("Vendor 3"), new Cell("Vendor 4")]),
    new Row([new Cell("A"), new Cell("B"), new Cell("C"), new Cell("D")]),
  ]);
  const pages = vendorTables(dom(source), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(pages[0]!.rows[0]!.cells).map(cell => [cell.textContent, cell.colSpan, cell.rowSpan]), [
    ["Uraian", 1, 2], ["Gabungan", 2, 1], ["Vendor 3", 1, 1],
  ]);
  assert.deepEqual(Array.from(pages[1]!.rows[1]!.cells).map(cell => cell.textContent), ["D"]);
});

test("invalid or missing vendor columns fail instead of silently skipping a vendor", () => {
  for (const indexes of [[], [0], [1, 1], [1.5], [-1], [1, 8]]) {
    assert.throws(() => vendorTables(dom(fixture(7)), indexes), /kolom vendor|Kolom vendor/);
  }
});
