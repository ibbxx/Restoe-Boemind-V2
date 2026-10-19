import type { CellInput, OfferRevision, WorkbookSnapshot } from "./contracts.ts";
import { createStableId as id } from "./ids.ts";
import type { StableId } from "./ids.ts";
import { canonicalJson } from "./snapshots.ts";
import { changeWorkbook } from "./workflow.ts";
import type { EngineConfiguration, NodeResult } from "../engine/contracts.ts";
import { compileGraph } from "../engine/graph.ts";
import { evaluateNode } from "../engine/evaluator.ts";
import { DecimalArithmetic } from "../engine/decimal.ts";

type OfferValue = OfferRevision["values"][number];

// Keep current vendor values; selection follows the same vendor as its inputs change.
export function refreshCurrentOffers(s: WorkbookSnapshot, configuration: EngineConfiguration | null): WorkbookSnapshot {
  if (!configuration) return s;
  const tables = s.worksheets.filter(w => w.stage === "EVALUASI_VENDOR").flatMap(w => w.tables);
  const graph = compileGraph(s, configuration), needed = new Set<string>();
  const pending = tables.flatMap(t => t.cells.map(c => c.id as string));
  while (pending.length) {
    const cellId = pending.pop()!;
    if (needed.has(cellId)) continue;
    needed.add(cellId);
    pending.push(...graph.nodes.get(cellId)?.dependencies ?? []);
  }
  const results = new Map<string, NodeResult>(), decimal = new DecimalArithmetic(configuration.decimal);
  const aggregates = new Map(configuration.aggregates.map(a => [a.id as string, a.memberCellIds]));
  const numericCells = new Set(s.workbook?.cells.filter(c => c.unit !== "text").map(c => c.cellId));
  const assumed = new Set<string>();
  for (const cellId of graph.order) if (needed.has(cellId)) {
    const node = graph.nodes.get(cellId)!;
    const source = node.pinnedInput ?? (node.cell.source.kind === "INPUT" ? node.cell.source.input : null);
    const assumeZero = source?.kind === "UNSET" && (s.workbook ? numericCells.has(node.cell.id) : node.unit !== null);
    const assumedDependencies = new Set(node.dependencies.filter(id => assumed.has(id)));
    const result = evaluateNode(node, results, decimal, aggregates, assumeZero, assumedDependencies);
    results.set(cellId, result);
    if ((result.status === "VALUE" || result.status === "ZERO") && (assumeZero || assumedDependencies.size)) assumed.add(cellId);
  }
  const formulas = new Map(s.formulas.filter(f => f.activation === "ACTIVE").map(f => [f.targetCellId, f]));
  const revisions: OfferRevision[] = [];
  const names = new Map<string, string>(), heads = new Map<StableId<"offer">, StableId<"offer-revision">>();
  const comparable = (values: readonly OfferValue[]) => canonicalJson(values.map(v => ({ label: v.label, input: v.input })).sort((a, b) => a.label.localeCompare(b.label)));
  for (const offer of s.analysis.offers) {
    const column = s.workbook?.offers.find(o => o.offerId === offer.id);
    const previous = s.analysis.offerRevisions.filter(r => r.offerId === offer.id).reduce<OfferRevision | undefined>(
      (latest, r) => !latest || r.revisionNumber > latest.revisionNumber ? r : latest, undefined);
    const valueId = (label: string) => previous?.values.find(v => v.label === label)?.id ?? id<"offer-value">();
    const values: OfferValue[] = [];
    for (const table of tables) for (const cell of table.cells) {
      const row = table.rows.find(r => r.id === cell.rowId)?.label ?? "";
      const marker = `|vendor:${offer.id}:`;
      if (column ? cell.columnId !== column.columnId : !row.includes(marker)) continue;
      const label = column ? cell.id : row.slice(row.indexOf(marker) + marker.length);
      const result = results.get(cell.id);
      const input: CellInput = cell.source.kind === "INPUT" ? cell.source.input : result && "value" in result
        ? { kind: "NUMERIC_TEXT", text: result.value } : result?.status === "TEXT" ? { kind: "TEXT", text: result.text } : { kind: "UNSET" };
      values.push({ id: valueId(label), label, input });
      const formula = formulas.get(cell.id);
      if (formula) values.push({ id: valueId(`formula:${label}`), label: `formula:${label}`, input: { kind: "TEXT", text: formula.expression } });
      if ((column ? cell.id === column.nameCellId : label === "Nama vendor") && input.kind === "TEXT" && input.text.trim()) names.set(offer.vendorId, input.text.trim());
    }
    if (!values.length) {
      if (previous) { revisions.push(previous); heads.set(offer.id, previous.id); }
      continue;
    }
    if (previous && comparable(previous.values) === comparable(values)) { revisions.push(previous); heads.set(offer.id, previous.id); continue; }
    const revisionId = previous?.id ?? id<"offer-revision">();
    revisions.push({ id: revisionId, offerId: offer.id, revisionNumber: previous?.revisionNumber ?? 1, values });
    heads.set(offer.id, revisionId);
  }
  const renamed = s.analysis.vendors.some(v => names.has(v.id) && names.get(v.id) !== v.name);
  const latest = (revisionId: StableId<"offer-revision"> | null) => {
    const offerId = s.analysis.offerRevisions.find(revision => revision.id === revisionId)?.offerId;
    return offerId ? heads.get(offerId) ?? revisionId : revisionId;
  };
  const current = revisions;
  if (!renamed && canonicalJson(current) === canonicalJson(s.analysis.offerRevisions) && latest(s.selectedOfferRevisionId) === s.selectedOfferRevisionId &&
    (!s.workbook || Object.values(s.workbook.selections).every(revisionId => latest(revisionId) === revisionId))) return s;
  return changeWorkbook(s, {
    selectedOfferRevisionId: latest(s.selectedOfferRevisionId),
    analysis: { ...s.analysis, offerRevisions: current, vendors: s.analysis.vendors.map(v => names.has(v.id) ? { ...v, name: names.get(v.id)! } : v) },
    ...(s.workbook ? { workbook: { ...s.workbook, offers: s.workbook.offers.map(o => heads.has(o.offerId) ? { ...o, revisionId: heads.get(o.offerId)! } : o),
      selections: { INU: latest(s.workbook.selections.INU), SOLAR_BAWAH: latest(s.workbook.selections.SOLAR_BAWAH) } } } : {}),
  });
}
