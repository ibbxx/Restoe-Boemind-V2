import type { WorkbookSnapshot } from "../domain/contracts.ts";
import { createStableId } from "../domain/ids.ts";
import { captureSnapshot, canonicalJson, freeze } from "../domain/snapshots.ts";
import type { CalculationEngine, EngineConfiguration, EngineRun, NodeResult } from "./contracts.ts";
import { DecimalArithmetic } from "./decimal.ts";
import { evaluateNode } from "./evaluator.ts";
import { affectedNodes, assertConfigurationVersions, captureConfiguration, relevantNodes } from "./graph.ts";
import { operationalGraph } from "./inu-solver.ts";

export const ENGINE_VERSION = "phase3-grammar2-fixed-decimal4-inu-cent-precision18-current-offer";
const issuedRuns = new WeakSet<EngineRun>();

export class FormulaEngine implements CalculationEngine {
  readonly version = ENGINE_VERSION;
  readonly configuration: EngineConfiguration;

  constructor(configuration: EngineConfiguration) { this.configuration = captureConfiguration(configuration); }

  evaluate(snapshot: WorkbookSnapshot): EngineRun { return this.#calculate(snapshot); }

  recalculate(snapshot: WorkbookSnapshot, previous: EngineRun): EngineRun {
    return this.#calculate(snapshot, previous);
  }

  #calculate(value: WorkbookSnapshot, previous?: EngineRun): EngineRun {
    const snapshot = captureSnapshot(value);
    const configuration = this.configuration;
    const { graph, solver } = operationalGraph(snapshot, configuration, previous?.engineVersion === this.version ? previous : undefined);
    if (previous && issuedRuns.has(previous)) assertConfigurationVersions(previous.manifest.configuration, configuration);
    let affected: ReadonlySet<string> = new Set(graph.nodes.keys());
    const results = new Map<string, NodeResult>();
    // Only reuse immutable results actually issued by an engine in this process.
    if (previous && issuedRuns.has(previous) && previous.engineVersion === this.version && previous.manifest.snapshot.analysisId === snapshot.analysisId &&
      previous.manifest.snapshot.projectId === snapshot.projectId &&
      previous.manifest.configuration.policyVersionId === configuration.policyVersionId &&
      canonicalJson(previous.manifest.configuration.decimal) === canonicalJson(configuration.decimal)) {
      affected = affectedNodes(operationalGraph(previous.manifest.snapshot, previous.manifest.configuration).graph, graph);
      previous.results.forEach(r => { if (graph.nodes.has(r.cellId) && !affected.has(r.cellId)) results.set(r.cellId, r); });
    }
    const decimal = new DecimalArithmetic(configuration.decimal);
    const aggregates = new Map(configuration.aggregates.map(a => [a.id as string, a.memberCellIds]));
    // Preseed cycle errors so downstream branches cannot accidentally consume a partial cycle value.
    graph.nodes.forEach(n => {
      if (n.error?.code === "CIRCULAR_DEPENDENCY") results.set(n.cell.id,
        { cellId: n.cell.id, writer: n.writer, dependencies: n.dependencies, ...n.error });
    });
    const evaluatedCellIds: string[] = [];
    for (const id of graph.order) {
      if (!affected.has(id) && results.has(id)) continue;
      const node = graph.nodes.get(id)!;
      results.set(id, evaluateNode(node, results, decimal, aggregates));
      evaluatedCellIds.push(id);
    }
    const ordered = [...results.values()].sort((a, b) => a.cellId.localeCompare(b.cellId));
    const provisionalResults = new Map<string, NodeResult>();
    const assumptions = new Map<string, readonly string[]>();
    const numericCells = new Set<string>(snapshot.workbook?.cells.filter(c => c.unit !== "text").map(c => c.cellId));
    graph.nodes.forEach(n => {
      if (n.error?.code === "CIRCULAR_DEPENDENCY") provisionalResults.set(n.cell.id,
        { cellId: n.cell.id, writer: n.writer, dependencies: n.dependencies, ...n.error });
    });
    for (const id of graph.order) {
      const node = graph.nodes.get(id)!;
      const source = node.cell.source.kind === "INPUT" ? node.cell.source.input : null;
      const assumeZero = source?.kind === "UNSET" && (snapshot.workbook ? numericCells.has(id) : node.unit !== null);
      const result = evaluateNode(node, provisionalResults, decimal, aggregates, assumeZero,
        new Set(node.dependencies.filter(dep => assumptions.get(dep)?.length)));
      provisionalResults.set(id, result);
      assumptions.set(id, result.status === "VALUE" || result.status === "ZERO"
        ? [...new Set([...(assumeZero && result.status === "ZERO" ? [id] : []),
          ...node.dependencies.flatMap(dep => assumptions.get(dep) ?? [])])].sort() : []);
    }
    const provisionalOrdered = [...provisionalResults.values()].sort((a, b) => a.cellId.localeCompare(b.cellId));
    const policyMatches = snapshot.policy.status === "CONFIGURED" && snapshot.policy.versionId === configuration.policyVersionId;
    const relevant = relevantNodes(snapshot, graph);
    const errors = ordered.filter(r => relevant.has(r.cellId) && !["VALUE", "ZERO", "TEXT"].includes(r.status));
    const run: EngineRun = freeze({
      ...(solver ? { solver } : {}),
      id: createStableId<"run">(), snapshotId: snapshot.id, engineVersion: this.version,
      policyVersionId: policyMatches ? configuration.policyVersionId : null, status: errors.length ? "ERROR" : "NONFINAL",
      diagnostics: [...(policyMatches ? [] : ["POLICY_UNCONFIGURED_OR_MISMATCH"]),
        "BUSINESS_VALIDATION_REQUIRED", "TRANSIENT_PREVIEW",
      ...errors.map(r => r.cellId + ":" + ("code" in r ? r.code : r.status))],
      results: ordered, evaluatedCellIds,
      provisional: { status: provisionalOrdered.some(r => relevant.has(r.cellId) && !["VALUE", "ZERO", "TEXT"].includes(r.status)) ? "ERROR" : "NONFINAL",
        results: provisionalOrdered, assumedZeroCellIds: [...new Set([...assumptions.values()].flat())].sort(),
        assumptionsByCellId: Object.fromEntries(assumptions) },
      manifest: { snapshot, configuration, signatures: Object.fromEntries([...graph.nodes].map(([id, n]) => [id, n.signature])) }
    });
    issuedRuns.add(run);
    return run;
  }
}
