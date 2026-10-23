import type { DynamicWorkbook, WorkbookSnapshot } from "./contracts.ts";
import { array, object, requireCondition, text } from "./validation.ts";
import { parseStableId } from "./ids.ts";
import { parseProfile } from "./profiles.ts";
import { captureConfiguration } from "../engine/graph.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import { DecimalArithmetic } from "../engine/decimal.ts";

export function parseDynamicWorkbook(value: unknown): DynamicWorkbook {
  const w = object(value, ["template", "sourceHash", "configuration", "solver", "tables", "cells", "bindings", "offers", "selections"]);
  requireCondition(w.template === "AHAS-v1" && /^[0-9a-f]{64}$/.test(text(w.sourceHash)), "Unknown template/source.");
  const configuration = w.configuration === null ? null : captureConfiguration(w.configuration as EngineConfiguration);
  const solver = w.solver === null ? null : object(w.solver, ["minimum", "maximum", "step"]);
  if (solver) {
    const d = new DecimalArithmetic(configuration?.decimal ?? { scale: 12, rounding: "HALF_UP", roundAt: "EVERY_OPERATION" });
    for (const key of ["minimum", "maximum", "step"]) {
      const raw = text(solver[key], true);
      requireCondition(/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw), "Parameter solver harus desimal nonnegatif.");
      requireCondition(d.parse(raw) >= 0n && (raw.split(".")[1]?.replace(/0+$/, "").length ?? 0) <= d.policy.scale, "Presisi parameter solver melebihi kebijakan.");
    }
    requireCondition(d.parse(text(solver.step)) > 0n && d.parse(text(solver.maximum)) >= d.parse(text(solver.minimum)), "Step/batas pencarian tidak valid.");
  }
  const selections = object(w.selections, ["INU", "SOLAR_BAWAH"]);
  return {
    template: "AHAS-v1", sourceHash: text(w.sourceHash), configuration,
    solver: solver ? { minimum: text(solver.minimum), maximum: text(solver.maximum), step: text(solver.step) } : null,
    selections: { INU: selections.INU === null ? null : parseStableId<"offer">(selections.INU), SOLAR_BAWAH: selections.SOLAR_BAWAH === null ? null : parseStableId<"offer">(selections.SOLAR_BAWAH) },
    tables: array(w.tables).map(raw => {
      const t = object(raw, ["tableId", "profile", "rowHeights", "columnWidths"]);
      function sizes(raw: unknown, maximum: number) { return array(raw).map(raw => {
        const s = object(raw, ["id", "size"]);
        requireCondition(typeof s.size === "number" && Number.isFinite(s.size) && s.size >= 18 && s.size <= maximum, "Ukuran tabel tidak valid.");
        return { id: parseStableId(s.id), size: s.size as number };
      }); }
      return { tableId: parseStableId<"table">(t.tableId), profile: t.profile === "SHARED" ? "SHARED" : parseProfile(t.profile),
        rowHeights: sizes(t.rowHeights, 800) as DynamicWorkbook["tables"][number]["rowHeights"],
        columnWidths: sizes(t.columnWidths, 1200) as DynamicWorkbook["tables"][number]["columnWidths"] };
    }),
    cells: array(w.cells).map(parseCellPresentation),
    bindings: array(w.bindings).map(raw => {
      const b = object(raw, ["profile", "key", "cellId"]);
      return { profile: parseProfile(b.profile), key: text(b.key, true), cellId: parseStableId<"cell">(b.cellId) };
    }),
    offers: array(w.offers).map(raw => {
      const o = object(raw, ["columnId", "baseCellId", "nameCellId", "offerId", "pattern"]);
      requireCondition(["C", "D", "E"].includes(text(o.pattern)), "Unknown vendor pattern.");
      return { baseCellId: parseStableId<"cell">(o.baseCellId), nameCellId: parseStableId<"cell">(o.nameCellId), columnId: parseStableId<"column">(o.columnId), offerId: parseStableId<"offer">(o.offerId), pattern: o.pattern as "C" | "D" | "E" };
    }),
  };
}

export function validateDynamicReferences(s: WorkbookSnapshot) {
  const w = s.workbook;
  if (!w) return;
  const tables = s.worksheets.flatMap(w => w.tables), cells = new Map(tables.flatMap(t => t.cells).map(c => [c.id, c]));
  const unique = (keys: readonly string[]) => requireCondition(new Set(keys).size === keys.length, "Duplicate presentation/binding.");
  requireCondition(w.tables.length === tables.length && w.cells.length === cells.size, "Incomplete presentation; explicit mapping required.");
  unique(w.tables.map(t => t.tableId)); unique(w.cells.map(c => c.cellId)); unique(w.bindings.map(b => b.profile + ":" + b.key));
  unique(w.offers.map(o => o.columnId)); unique(w.offers.map(o => o.offerId));
  for (const t of w.tables) {
    const table = tables.find(v => v.id === t.tableId);
    requireCondition(table && table.cells.every(c => c.scope === t.profile), "Invalid table presentation scope.");
    requireCondition(t.rowHeights.length === table.rows.length && t.columnWidths.length === table.columns.length, "Incomplete dimensions.");
    unique(t.rowHeights.map(r => r.id)); unique(t.columnWidths.map(c => c.id));
    requireCondition(t.rowHeights.every(r => table.rowOrder.includes(r.id)) && t.columnWidths.every(c => table.columnOrder.includes(c.id)), "Unknown size target.");
  }
  requireCondition(w.cells.every(c => cells.has(c.cellId)) && w.bindings.every(b => cells.get(b.cellId)?.scope === b.profile), "Unknown cell presentation/binding.");
  for (const o of w.offers) requireCondition(tables.some(t => t.columnOrder.includes(o.columnId) && t.cells.every(c => c.scope === "SHARED") && t.cells.some(c => c.id === o.baseCellId && c.columnId === o.columnId) && t.cells.some(c => c.id === o.nameCellId && c.columnId === o.columnId)) &&
    s.analysis.offers.some(r => r.id === o.offerId), "Invalid offer column binding.");
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) requireCondition(w.selections[profile] === null || w.offers.some(o => o.offerId === w.selections[profile]), "Invalid profile selection.");
  requireCondition(s.selectedOfferId === w.selections[s.activeProfile], "Active selection mismatch.");
  if (w.configuration) {
    requireCondition(s.policy.status === "CONFIGURED" && s.policy.versionId === w.configuration.policyVersionId, "Configuration policy mismatch.");
    requireCondition(w.configuration.units.every(u => cells.has(u.cellId)) && w.configuration.aggregates.every(a => a.memberCellIds.every(id => cells.has(id))) && w.configuration.selectionDependentCellIds.every(id => cells.has(id)), "Configuration target missing.");
  }
}

export function parseCellPresentation(raw: unknown): DynamicWorkbook["cells"][number] {
  const c = object(raw, ["cellId", "address", "kind", "tone", "bold", "align", "unit"]);
  requireCondition(["LABEL", "INPUT", "RESULT", "BLANK"].includes(text(c.kind)) && ["plain", "yellow", "green", "red", "gray"].includes(text(c.tone)) &&
    ["left", "center", "right"].includes(text(c.align)) && ["text", "1", "IDR/L", "L", "IDR"].includes(text(c.unit)) && typeof c.bold === "boolean", "Invalid cell presentation.");
  return { ...c, cellId: parseStableId<"cell">(c.cellId), address: text(c.address) } as unknown as DynamicWorkbook["cells"][number];
}
