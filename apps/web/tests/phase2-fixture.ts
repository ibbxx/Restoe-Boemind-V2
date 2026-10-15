import type { EntityKind } from "../src/domain/ids.ts";
import { parseStableId } from "../src/domain/ids.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";

let sequence = 1;
export function id<K extends EntityKind>() {
  return parseStableId<K>("00000000-0000-4000-8000-" + String(sequence++).padStart(12, "0"));
}

export type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T : { -readonly [K in keyof T]: Mutable<T[K]> };

// Structural test data only; these texts are not approved business fixtures.
export function fixture(): Mutable<WorkbookSnapshot> {
  const projectId = id<"project">();
  const analysisId = id<"analysis">();
  const vendorId = id<"vendor">();
  const offerId = id<"offer">();
  const revisionId = id<"offer-revision">();
  const sharedTableId = id<"table">();
  const sharedRow = id<"row">();
  const sharedColumn = id<"column">();
  const sharedCell = id<"cell">();
  const snapshots = (["INU", "SOLAR_BAWAH"] as const).map(profile => {
    const tableId = id<"table">();
    const rows = [id<"row">(), id<"row">()];
    const columns = [id<"column">(), id<"column">()];
    const hpp = id<"cell">();
    const input = id<"cell">();
    const output = id<"cell">();
    const formulaId = id<"formula">();
    return { profile, hpp, formulaId,
      table: { id: tableId, rows: rows.map(id => ({ id, label: "Test row" })),
        columns: columns.map(id => ({ id, label: "Test column" })), rowOrder: rows, columnOrder: columns,
        cells: [
          { id: hpp, tableId, rowId: rows[0]!, columnId: columns[0]!, scope: profile,
            source: { kind: "INPUT" as const, input: { kind: "UNSET" as const } } },
          { id: input, tableId, rowId: rows[1]!, columnId: columns[0]!, scope: profile,
            source: { kind: "INPUT" as const, input: { kind: "NUMERIC_TEXT" as const, text: "raw-test-input" } } },
          { id: output, tableId, rowId: rows[1]!, columnId: columns[1]!, scope: profile,
            source: { kind: "FORMULA" as const, formulaId } },
        ] },
      formula: { id: formulaId, versionId: id<"formula-version">(), targetCellId: output,
        expression: "TEST_EXPRESSION_NOT_EVALUATED", referenceCellIds: [input, sharedCell],
        sourceKind: "OPERATIONAL_OVERRIDE" as const, activation: "DRAFT" as const, provenance: null },
    };
  });
  const inu = snapshots[0]!;
  const solar = snapshots[1]!;
  return {
    schemaVersion: 2, id: id<"snapshot">(), projectId, analysisId, mappings: [],
    project: { id: projectId, name: "Structural test project" },
    analysis: { analysis: { id: analysisId, projectId, name: "Structural test analysis" },
      vendors: [{ id: vendorId, analysisId, name: "Manual analysis vendor" }],
      offers: [{ id: offerId, analysisId, vendorId, label: "Manual offer" }],
      offerRevisions: [{ id: revisionId, offerId, revisionNumber: 1,
        values: [{ id: id<"offer-value">(), label: "Raw test value", input: { kind: "NUMERIC_TEXT", text: "test-only" } }] }] },
    selectedOfferRevisionId: revisionId, activeProfile: "INU",
    profiles: {
      INU: { reviewContext: null, hppBase: { origin: "MANUAL", cellId: inu.hpp, contextRunId: null },
        cellIds: inu.table.cells.map(c => c.id), formulaIds: [inu.formulaId] },
      SOLAR_BAWAH: { reviewContext: null, hppBase: { origin: "MANUAL", cellId: solar.hpp, contextRunId: null },
        cellIds: solar.table.cells.map(c => c.id), formulaIds: [solar.formulaId] },
    },
    worksheets: [
      { id: id<"worksheet">(), stage: "EVALUASI_VENDOR", label: "Vendor", tables: [
        { id: sharedTableId, rows: [{ id: sharedRow, label: "Offer" }], columns: [{ id: sharedColumn, label: "Input" }],
          rowOrder: [sharedRow], columnOrder: [sharedColumn], cells: [
            { id: sharedCell, tableId: sharedTableId, rowId: sharedRow, columnId: sharedColumn, scope: "SHARED",
              source: { kind: "INPUT", input: { kind: "UNSET" } } },
          ] },
      ] },
      { id: id<"worksheet">(), stage: "KONVERSI_JAGAD", label: "Conversion", tables: [] },
      { id: id<"worksheet">(), stage: "AHS", label: "AHS", tables: [inu.table, solar.table] },
    ], formulas: [inu.formula, solar.formula], policy: { status: "UNCONFIGURED" }, calculationRunRefs: [],
  };
}
