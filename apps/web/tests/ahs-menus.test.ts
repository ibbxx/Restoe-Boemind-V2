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
import { addAhsItem, ahsGroups, ahsRoleCell } from "../src/domain/ahs-groups.ts";
import { setCellFormula } from "../src/domain/structure.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import { canvasCellAddresses } from "../src/domain/canvas-address.ts";
import { readFileSync } from "node:fs";

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
const { LoadingIndicator } = await import("../src/ui/loading-indicator.tsx");

test("workspace retains one full-screen animated loader with the original blur", () => {
  const html = renderToStaticMarkup(createElement(LoadingIndicator, { active: true, label: "Menyimpan perubahan…" }));
  assert(html.includes('class="app-loading"'));
  assert(html.includes("<canvas"));
  assert(html.includes("Menyimpan perubahan…"));
  assert(!html.includes("app-loading-inline"));
  const source = readFileSync(new URL("../src/ui/procurement-workspace.tsx", import.meta.url), "utf8");
  assert.equal(source.match(/<LoadingIndicator\b/g)?.length, 1);
  assert(source.includes('<LoadingIndicator active={busy || preparingPrint} label={loadingLabel} />'));
  assert(!source.includes("worksheet-operation-status"));
  assert(!source.includes("workspace-loading"));
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.app-loading \{[^}]*position: fixed;[^}]*backdrop-filter: blur\(6px\)/);
});

test("menu icon exposes both animation states and a custom duration", () => {
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(createElement(MenuToggleIcon, { open, duration: 250, "aria-hidden": true }));
    assert(html.includes(`data-open="${open}"`));
    assert(html.includes("transition-duration:250ms"));
  }
});

for (const layout of ["template", "legacy"] as const) for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
  test(`${layout}/${profile}: saving locks edits and calculation blocks print only`, () => {
    const base = layout === "template" ? createProcurementWorkbook("Project", "Analysis") : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
    const snapshot = changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(base))), profile);
    const configuration = snapshot.workbook?.configuration ?? legacyConfiguration(snapshot, null);
    const saving = renderToStaticMarkup(createElement(WorksheetSurface, {
      snapshot, configuration, run: null, disabled: true, saving: true, onSave() {},
    }));
    assert.match(saving, /class="sheet-viewport" aria-label="Lembar procurement" tabindex="0"/);
    assert.match(saving, /aria-busy="true" disabled="">Menyimpan…<\/button>/);
    assert.match(saving, /<input[^>]*class="sheet-input"[^>]*disabled=""/);
    assert(!saving.includes('class="app-loading"'), "the surface must not duplicate the workspace loader");
    const calculating = renderToStaticMarkup(createElement(WorksheetSurface, {
      snapshot, configuration, run: null, disabled: false, calculating: true,
    }));
    assert(calculating.includes('data-calculating="true"'));
    assert.match(calculating, /class="print-button"[^>]*disabled=""/);
    assert.match(calculating, /<input[^>]*class="sheet-input"[^>]*>/);
    assert(!/<input[^>]*class="sheet-input"[^>]*disabled=""/.test(calculating), "calculation must not lock editable cells");
  });

  test(`${layout}/${profile}: one global AHS menu controls every section`, () => {
    const base = layout === "template" ? createProcurementWorkbook("Project", "Analysis") : prepareLegacySheet(emptyWorkbook("Project", "Analysis"));
    let snapshot = changeSheetProfile(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(base))), profile);
    for (const [address, label] of [["L9", "TOTAL PENDAPATAN"], ["L14", "TOTAL BIAYA"], ["L34", "LABA KOTOR"]]) {
      snapshot = setCellFormula(snapshot, ahsRoleCell(snapshot, profile, address!, label!)!.id, "1234567890123.45");
    }
    snapshot = addAhsItem(snapshot, null, "Uraian tambahan", "Kelompok tambahan");
    const group = ahsGroups(snapshot).at(-1)!;
    snapshot = setCellFormula(snapshot, group.labelCellId!, '"Kelompok dari rumus"');
    snapshot = setCellFormula(snapshot, group.items[0]!.labelCellId!, '"Uraian dari rumus"');
    const builtin = ahsGroups(snapshot)[0]!;
    snapshot = setCellFormula(snapshot, builtin.labelCellId!, '"Kelompok bawaan dari rumus"');
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
    const ahs = html.slice(html.indexOf('aria-label="Analisis Harga Satuan AHS"'));
    const addresses = canvasCellAddresses(snapshot);
    for (const match of html.matchAll(/data-cell-id="([^"]+)" data-cell-code="([^"]+)"/g)) {
      assert.match(match[2]!, /^[A-Z]+[1-9]\d*$/);
      assert.equal(match[2], addresses.get(match[1]!));
    }
    for (const label of ["Kelompok dari rumus", "Uraian dari rumus", "Kelompok bawaan dari rumus"]) {
      assert(ahs.includes(`class="cell-print-value">${label}</span>`), `${label}: result must be rendered for the table and print`);
    }
    assert(ahs.includes('class="sheet-input" aria-label="Lembar AHS · HPP · Harga Dasar"') === false, "HPP must remain a readout");
    assert.equal(new Set([...html.matchAll(/aria-labelledby="(ahs-[^"]+-action-title)"/g)].map(match => match[1])).size, 1);
  });
}
