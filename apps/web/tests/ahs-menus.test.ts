import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { emptyWorkbook } from "../src/domain/workflow.ts";
import { connectAhsHpp, makeAhsSaleInput, prepareLegacySheet, legacyConfiguration } from "../src/domain/legacy-sheet.ts";
import { connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { changeSheetProfile } from "../src/domain/dynamic-workflow.ts";
import { ahsRoleCell } from "../src/domain/ahs-groups.ts";
import { setCellFormula } from "../src/domain/structure.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";

register("data:text/javascript," + encodeURIComponent(`
  import { readFile } from "node:fs/promises";
  import ts from ${JSON.stringify(new URL("../node_modules/typescript/lib/typescript.js", import.meta.url).href)};
  export async function load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: ts.transpileModule(await readFile(new URL(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
    }).outputText };
  }
`), import.meta.url);
const { WorksheetSurface } = await import("../src/ui/worksheet-surface.tsx");
const { MenuToggleIcon } = await import("../src/components/ui/menu-toggle-icon.tsx");

test("menu icon exposes both animation states and a custom duration", () => {
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(createElement(MenuToggleIcon, { open, duration: 250, "aria-hidden": true }));
    assert(html.includes(`data-open="${open}"`));
    assert(html.includes("transition-duration:250ms"));
  }
});

for (const layout of ["template", "legacy"] as const) for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
  test(`${layout}/${profile}: one global AHS menu controls every section`, () => {
    const base = layout === "template" ? createProcurementWorkbook("Project", "Analysis") : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
    let snapshot = changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(base))), profile);
    for (const [address, label] of [["L9", "TOTAL PENDAPATAN"], ["L14", "TOTAL BIAYA"], ["L34", "LABA KOTOR"]]) {
      snapshot = setCellFormula(snapshot, ahsRoleCell(snapshot, profile, address!, label!)!.id, "1234567890123.45");
    }
    const configuration = snapshot.workbook?.configuration ?? legacyConfiguration(snapshot, null);
    const html = renderToStaticMarkup(createElement(WorksheetSurface, {
      snapshot, run: new FormulaEngine(configuration).evaluate(snapshot), configuration, disabled: false,
    }));
    assert(!html.includes("ahs-table-scroll"), "AHS must not reserve a right gutter");
    assert(!html.includes("ahs-section-actions"), "section-level controls must be removed");
    assert.equal(html.match(/class="vendor-table-actions ahs-global-actions"/g)?.length, 1);
    assert.equal(html.match(/aria-label="Aksi AHS"/g)?.length, 2);
    for (const section of ["Informasi Analisis", "Pendapatan", "Biaya", "Laba"]) {
      assert(html.includes(`>${section}</button>`), `${section}: missing section picker`);
    }
    assert(html.includes("Tambah uraian"), "missing add action");
    assert(html.includes("1.234.567.890.123,45"), "long totals must remain intact");
    assert.equal(new Set([...html.matchAll(/aria-labelledby="(ahs-[^"]+-action-title)"/g)].map(match => match[1])).size, 1);
  });
}
