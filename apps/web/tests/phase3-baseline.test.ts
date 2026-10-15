import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseFormula, references } from "../src/engine/parser.ts";
import { id } from "./phase2-fixture.ts";

// Read-only structural oracle. Cache/independent_eval columns are deliberately not arithmetic expectations.
function csv(text: string): Record<string, string>[] {
  const rows: string[][] = [[]];
  let field = "", quoted = false;
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      rows.at(-1)!.push(field); field = "";
      if (c === "\n") rows.push([]);
    } else field += c;
  }
  assert.equal(quoted, false);
  if (field) rows.at(-1)!.push(field);
  const headers = rows.shift()!;
  return rows.filter(r => r.length > 0).map(row => {
    assert.equal(row.length, headers.length);
    return Object.fromEntries(headers.map((header, i) => [header, row[i]!]));
  });
}
function column(text: string) { return [...text].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); }
function letters(n: number): string { return n ? letters(Math.floor((n - 1) / 26)) + String.fromCharCode(65 + (n - 1) % 26) : ""; }
function address(text: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(text);
  assert.ok(match); return { column: column(match[1]!), row: Number(match[2]) };
}
function translate(expression: string, from: string, to: string) {
  const a = address(from), b = address(to);
  return expression.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (_, fixedColumn: string, col: string, fixedRow: string, row: string) =>
    fixedColumn + letters(column(col) + (fixedColumn ? 0 : b.column - a.column)) + fixedRow +
    (Number(row) + (fixedRow ? 0 : b.row - a.row)));
}
function decodeXml(text: string) { return text.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&"); }

it("verifies hash, 166 actual shared-expanded formulas and 358 edges against v0.3 before parsing stable-ID expressions", () => {
  const workbook = new URL("../../../AHAS Sistem.xlsx", import.meta.url);
  assert.equal(createHash("sha256").update(readFileSync(workbook)).digest("hex"),
    "efe4f10792453d8407bb47539b7f7aea015332faf6cabdbeb22a530a9e5e1abc");
  const base = new URL("../../../BUNDLE_BASELINE_FORMULA_AUDIT_v0.3/", import.meta.url);
  const inventory = csv(readFileSync(new URL("AUDIT_FORMULA_BASELINE_v0.3.csv", base), "utf8"));
  const edgeFixture = csv(readFileSync(new URL("AUDIT_DEPENDENSI_FORMULA_v0.3.csv", base), "utf8"));
  assert.equal(inventory.length, 166);
  assert.equal(edgeFixture.length, 358);
  const edges = new Set<string>();
  let formulaCount = 0;
  for (const [sheetIndex, sheet] of ["AHAS INU", "AHAS Solar bawah"].entries()) {
    const xml = execFileSync("unzip", ["-p", fileURLToPath(workbook), `xl/worksheets/sheet${sheetIndex + 1}.xml`], { encoding: "utf8" });
    const entries = [...xml.matchAll(/<c\b(?![^>]*\/>)[^>]*\br="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/c>/g)]
      .flatMap(cell => {
        const f = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(cell[2]!);
        return f ? [{ cell: cell[1]!, attributes: f[1]!, expression: decodeXml(f[2] ?? "") }] : [];
      });
    assert.equal(entries.length, sheetIndex === 0 ? 86 : 80);
    const anchors = new Map(entries.filter(e => e.expression && /\bt="shared"/.test(e.attributes))
      .map(e => [/\bsi="(\d+)"/.exec(e.attributes)![1]!, e]));
    const ids = new Map<string, string>();
    const cellId = (cell: string) => {
      cell = cell.replace(/\$/g, "");
      if (!ids.has(cell)) ids.set(cell, id<"cell">());
      return ids.get(cell)!;
    };
    for (const entry of entries) {
      const si = /\bsi="(\d+)"/.exec(entry.attributes)?.[1];
      const anchor = si ? anchors.get(si) : undefined;
      const expression = entry.expression || (anchor ? translate(anchor.expression, anchor.cell, entry.cell) : "");
      assert.ok(expression);
      const audited = inventory.find(row => row.sheet === sheet && row.cell === entry.cell);
      assert.ok(audited, sheet + "!" + entry.cell);
      assert.equal(expression.toUpperCase(), audited.formula!.toUpperCase());
      const memberships = new Map<string, readonly string[]>();
      const normalized = expression.toUpperCase().replace(/\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/g,
        (_, c1: string, r1: string, c2: string, r2: string) => {
          const members: string[] = [];
          for (let r = Number(r1); r <= Number(r2); r++) for (let c = column(c1); c <= column(c2); c++) members.push(cellId(letters(c) + r));
          const aggregate = id<"aggregate">(); memberships.set(aggregate, members);
          return `#{${aggregate}}`;
        }).replace(/\$?[A-Z]+\$?\d+/g, token => `@{${cellId(token)}}`);
      const dependencies = new Set(references(parseFormula(normalized), key => {
        const members = memberships.get(key); assert.ok(members); return members;
      }));
      const auditedAddresses = audited.direct_refs ? audited.direct_refs.split(";") : [];
      assert.deepEqual(dependencies, new Set(auditedAddresses.map(cellId)));
      for (const dependency of auditedAddresses) edges.add([sheet, entry.cell, dependency].join(":"));
      formulaCount++;
    }
  }
  assert.equal(formulaCount, 166);
  assert.equal(edges.size, 358);
  assert.deepEqual(edges, new Set(edgeFixture.map(row => [row.sheet, row.formula_cell, row.dependency_cell].join(":"))));
});
