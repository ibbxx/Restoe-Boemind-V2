import type { WorkbookSnapshot, CellSource } from "../domain/contracts.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import { canonicalJson, captureSnapshot } from "../domain/snapshots.ts";
import { object, array, requireCondition, text, parseCellInput } from "../domain/validation.ts";
import { parseStableId } from "../domain/ids.ts";
import { captureConfiguration } from "../engine/graph.ts";

type StoredSource = CellSource | { kind: "OFFER_VALUE"; offerId: string; valueId: string };

// Normalized disk representation; the cell editor receives a materialized current view.
export function encodeWorkbook(s: WorkbookSnapshot, configuration: EngineConfiguration | null) {
  const references = new Map<string, { kind: "OFFER_VALUE"; offerId: string; valueId: string }>();
  for (const offer of s.analysis.offers) {
    const column = s.workbook?.offers.find(o => o.offerId === offer.id);
    for (const table of s.worksheets.filter(w => w.stage === "EVALUASI_VENDOR").flatMap(w => w.tables)) for (const cell of table.cells) {
      if (column ? cell.columnId !== column.columnId : !table.rows.some(r => r.id === cell.rowId && r.label.includes(`|vendor:${offer.id}:`))) continue;
      const label = column ? cell.id : table.rows.find(r => r.id === cell.rowId)!.label.split(`|vendor:${offer.id}:`)[1];
      const value = offer.values.find(v => v.label === label);
      if (cell.source.kind !== "INPUT") continue;
      requireCondition(value && canonicalJson(value.input) === canonicalJson(cell.source.input), "Vendor input differs from its active offer.");
      references.set(cell.id, { kind: "OFFER_VALUE", offerId: offer.id, valueId: value.id });
    }
  }
  const { project, projectId, analysisId, analysis, workbook, ...state } = s;
  void project; void projectId; void analysisId;
  const { analysis: metadata, ...inventory } = analysis;
  void metadata;
  const presentation = workbook ? (({ configuration: ignored, ...rest }) => { void ignored; return rest; })(workbook) : undefined;
  return { schemaVersion: 1, state: { ...state, analysis: inventory,
    ...(presentation ? { workbook: presentation } : {}),
    worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
      cells: t.cells.map(c => ({ ...c, source: references.get(c.id) ?? c.source })) })) })) }, configuration };
}

export function decodeWorkbook(value: unknown, metadata: { analysisId: string; projectId: string; analysisName: string; projectName: string }) {
  const data = object(value, ["schemaVersion", "state", "configuration"]);
  requireCondition(data.schemaVersion === 1 && data.state !== null && typeof data.state === "object", "Unsupported current workbook format.");
  const state = data.state as Record<string, unknown>;
  const inventory = object(state.analysis, ["vendors", "offers"]);
  const inputs = new Map<string, unknown>();
  for (const raw of array(inventory.offers)) {
    const offer = object(raw, ["id", "analysisId", "vendorId", "label", "values"]);
    for (const rawValue of array(offer.values)) {
      const v = object(rawValue, ["id", "label", "input"]);
      const key = parseStableId(offer.id) + ":" + parseStableId(v.id);
      requireCondition(!inputs.has(key), "Duplicate offer value reference.");
      inputs.set(key, parseCellInput(v.input));
    }
  }
  const configuration = data.configuration === null ? null : captureConfiguration(data.configuration as EngineConfiguration);
  const worksheets = array(state.worksheets).map(raw => {
    const w = object(raw, ["id", "stage", "label", "tables"]);
    return { ...w, tables: array(w.tables).map(rawTable => {
      const t = object(rawTable, ["id", "rows", "columns", "rowOrder", "columnOrder", "cells", "merges"]);
      return { ...t, cells: array(t.cells).map(rawCell => {
        const c = object(rawCell, ["id", "tableId", "rowId", "columnId", "scope", "source"]);
        const source = c.source as StoredSource;
        if (source?.kind !== "OFFER_VALUE") return c;
        const ref = object(source, ["kind", "offerId", "valueId"]);
        const input = inputs.get(parseStableId(ref.offerId) + ":" + parseStableId(ref.valueId));
        requireCondition(input, "Missing active offer value.");
        return { ...c, source: { kind: "INPUT", input } };
      }) };
    }) };
  });
  const snapshot = captureSnapshot({ ...state, projectId: parseStableId(metadata.projectId), analysisId: parseStableId(metadata.analysisId),
    project: { id: parseStableId(metadata.projectId), name: text(metadata.projectName, true) },
    analysis: { ...inventory, analysis: { id: parseStableId(metadata.analysisId), projectId: parseStableId(metadata.projectId), name: text(metadata.analysisName, true) } },
    worksheets, ...(state.workbook ? { workbook: { ...state.workbook as object, configuration } } : {}) });
  requireCondition(canonicalJson(encodeWorkbook(snapshot, configuration)) === canonicalJson(value), "Noncanonical current workbook data.");
  return { snapshot, configuration };
}
