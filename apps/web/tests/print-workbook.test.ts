import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { printWorkbook, vendorTables, workbookPrintTitle } from "../src/ui/print-workbook.ts";

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

test("PDF title follows project, analysis, displayed volume, and material without profile or extension", () => {
  assert.equal(workbookPrintTitle({ projectName: "TONASA", analysisName: "AMIR LAMA BGT", volume: "50.000", material: "Solar" }),
    "PROYEK TONASA - AMIR LAMA BGT - 50.000 L - Solar");
  assert.equal(workbookPrintTitle({ projectName: "TONASA", analysisName: "Analisis", volume: "50.000,5", material: "BBM" }),
    "PROYEK TONASA - Analisis - 50.000,5 L - BBM");
});

test("PDF title omits missing metadata and removes unsafe filename characters", () => {
  assert.equal(workbookPrintTitle({ projectName: " TONASA / A ", analysisName: "Amir: \"B\"\n2026", volume: "", material: " \t " }),
    "PROYEK TONASA A - Amir B 2026");
  assert.equal(workbookPrintTitle({ projectName: "Proyek\\baru", analysisName: "A*?|<>...", volume: "500", material: "Solar\u0000 Bawah" }),
    "PROYEK Proyek baru - A - 500 L - Solar Bawah");
  assert.equal(workbookPrintTitle({ projectName: "TONASA", analysisName: "Analisis", volume: "", material: "Solar" }),
    "PROYEK TONASA - Analisis - Solar");
});

class PrintElement {
  className = "";
  textContent = "";
  style = { transform: "" };
  children: PrintElement[] = [];
  parent?: PrintElement;
  clientWidth = 1000;
  clientHeight = 700;
  scrollWidth = 900;
  scrollHeight = 600;
  offsetTop = 16;
  setAttribute() {}
  append(...children: PrintElement[]) {
    this.children.push(...children);
    for (const child of children) child.parent = this;
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelectorAll(selector: string): PrintElement[] {
    return this.children.flatMap(child => [
      ...(child.className === selector.slice(1) ? [child] : []),
      ...(child instanceof PrintElement ? child.querySelectorAll(selector) : []),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

function printEnvironment(t: TestContext) {
  const body = new PrintElement();
  const afterprint = new Set<() => void>();
  let printCalls = 0;
  let failure: Error | undefined;
  const doc = {
    title: "Dynamic Procurement Workbook", body, fonts: { ready: Promise.resolve() },
    createElement: () => new PrintElement(),
    querySelector: (selector: string) => body.querySelector(selector),
  };
  const win = {
    addEventListener: (name: string, callback: () => void) => { if (name === "afterprint") afterprint.add(callback); },
    removeEventListener: (name: string, callback: () => void) => { if (name === "afterprint") afterprint.delete(callback); },
    print: () => { printCalls++; if (failure) throw failure; },
  };
  for (const [name, value] of Object.entries({ document: doc, window: win })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
  const sheet = {
    querySelector: () => dom(fixture(3)),
    querySelectorAll: () => [dom(fixture(1))],
  } as unknown as HTMLElement;
  return { doc, sheet, afterprint, failPrint: (error: Error) => { failure = error; }, printCalls: () => printCalls,
    closeDialog: () => { for (const listener of afterprint) listener(); } };
}

test("print title remains active until the dialog closes or is cancelled, then repeated print uses fresh metadata", async t => {
  const env = printEnvironment(t);
  const original = env.doc.title;
  for (const title of ["Proyek TONASA - Analisis - 50.000 L - Solar", "Proyek TONASA - Analisis baru - 75.000 L - BBM"]) {
    await printWorkbook(env.sheet, [1, 2, 3], title);
    assert.equal(env.doc.title, title);
    assert.equal(env.doc.body.children.length, 1);
    env.closeDialog();
    assert.equal(env.doc.title, original);
    assert.equal(env.doc.body.children.length, 0);
    assert.equal(env.afterprint.size, 0);
  }
  assert.equal(env.printCalls(), 2);
});

test("print failure restores even an empty title and removes the report", async t => {
  const env = printEnvironment(t);
  env.doc.title = "";
  env.failPrint(new Error("Dialog gagal dibuka"));
  await assert.rejects(printWorkbook(env.sheet, [1, 2, 3], "Proyek TONASA"), /Dialog gagal dibuka/);
  assert.equal(env.doc.title, "");
  assert.equal(env.doc.body.children.length, 0);
  assert.equal(env.afterprint.size, 0);
});

test("preparation failure leaves the original page title unchanged", async t => {
  const env = printEnvironment(t);
  await assert.rejects(printWorkbook(env.sheet, [1, 9], "Proyek TONASA"), /Kolom vendor/);
  assert.equal(env.doc.title, "Dynamic Procurement Workbook");
  assert.equal(env.doc.body.children.length, 0);
  assert.equal(env.printCalls(), 0);
});

test("a second print cannot overwrite the title of an open print dialog", async t => {
  const env = printEnvironment(t);
  await printWorkbook(env.sheet, [1, 2, 3], "Proyek pertama");
  await printWorkbook(env.sheet, [1, 2, 3], "Proyek kedua");
  assert.equal(env.doc.title, "Proyek pertama");
  assert.equal(env.printCalls(), 1);
  assert.equal(env.doc.body.children.length, 1);
  env.closeDialog();
  assert.equal(env.doc.title, "Dynamic Procurement Workbook");
});

test("external prints AHS once without vendor selection or conversion tables", async t => {
  const env = printEnvironment(t);
  const ahs = fixture(1);
  const original = JSON.stringify(ahs);
  const sheet = {
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === ".ahs-sheet" ? [dom(ahs)] : [],
  } as unknown as HTMLElement;
  await printWorkbook(sheet, [], "AHS Eksternal", "EXTERNAL");
  assert.equal(env.printCalls(), 1);
  const host = env.doc.body.children[0]!;
  assert.equal(host.children.length, 1);
  const report = host.children[0]!.children[0]!;
  assert.equal(report.className, "workbook-print-report workbook-print-external");
  assert.equal(report.children.length, 1);
  assert.equal(report.children[0]!.className, "print-table print-ahs");
  assert.equal(JSON.stringify(ahs), original);
  env.closeDialog();
  assert.equal(env.doc.body.children.length, 0);
  await assert.rejects(printWorkbook(sheet, [], "Internal", "INTERNAL"), /belum lengkap/);
});
