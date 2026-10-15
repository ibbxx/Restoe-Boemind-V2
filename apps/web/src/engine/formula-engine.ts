import type { SavedRevision, WorkbookSnapshot } from "../domain/contracts.ts";
import { createStableId, parseStableId } from "../domain/ids.ts";
import { captureSnapshot, canonicalJson, freeze } from "../domain/snapshots.ts";
import { requireCondition } from "../domain/validation.ts";
import { invalidateReviewContexts } from "../domain/freshness.ts";
import { recordReviewContext } from "../domain/commands.ts";
import type { CalculationEngine, EngineConfiguration, EngineRun, NodeResult } from "./contracts.ts";
import { DecimalArithmetic } from "./decimal.ts";
import { evaluateNode } from "./evaluator.ts";
import { affectedNodes, assertConfigurationVersions, captureConfiguration, compileGraph, relevantNodes } from "./graph.ts";

export const ENGINE_VERSION = "phase3-grammar1-fixed-decimal1";
const issuedRuns = new WeakSet<EngineRun>();

export class FormulaEngine implements CalculationEngine {
  readonly version = ENGINE_VERSION;
  readonly configuration: EngineConfiguration;
  #runs = new Map<EngineRun["id"], EngineRun>();
  #published = new Map<string, EngineRun>();

  constructor(configuration: EngineConfiguration) { this.configuration = captureConfiguration(configuration); }

  evaluate(snapshot: WorkbookSnapshot): EngineRun { return this.#calculate(snapshot, null); }

  evaluateRevision(revision: SavedRevision, previous?: EngineRun): EngineRun {
    return this.#calculate(revision.snapshot, parseStableId<"revision">(revision.revisionId), previous);
  }

  recalculate(snapshot: WorkbookSnapshot, previous: EngineRun): EngineRun {
    return this.#calculate(snapshot, null, previous);
  }

  #calculate(value: WorkbookSnapshot, revisionId: EngineRun["manifest"]["revisionId"], previous?: EngineRun): EngineRun {
    const snapshot = captureSnapshot(value);
    const configuration = this.configuration;
    const graph = compileGraph(snapshot, configuration);
    if (previous && issuedRuns.has(previous)) assertConfigurationVersions(previous.manifest.configuration, configuration);
    let affected: ReadonlySet<string> = new Set(graph.nodes.keys());
    const results = new Map<string, NodeResult>();
    // Only reuse immutable results actually issued by an engine in this process.
    if (previous && issuedRuns.has(previous) && previous.engineVersion === this.version && previous.manifest.snapshot.analysisId === snapshot.analysisId &&
      previous.manifest.snapshot.projectId === snapshot.projectId &&
      previous.manifest.configuration.policyVersionId === configuration.policyVersionId &&
      canonicalJson(previous.manifest.configuration.decimal) === canonicalJson(configuration.decimal)) {
      affected = affectedNodes(compileGraph(previous.manifest.snapshot, previous.manifest.configuration), graph);
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
    const policyMatches = snapshot.policy.status === "CONFIGURED" && snapshot.policy.versionId === configuration.policyVersionId;
    const relevant = relevantNodes(snapshot, graph);
    const errors = ordered.filter(r => relevant.has(r.cellId) && !["VALUE", "ZERO", "TEXT"].includes(r.status));
    const run: EngineRun = freeze({
      id: createStableId<"run">(), snapshotId: snapshot.id, engineVersion: this.version,
      policyVersionId: policyMatches ? configuration.policyVersionId : null, status: errors.length ? "ERROR" : "NONFINAL",
      diagnostics: [...(policyMatches ? [] : ["POLICY_UNCONFIGURED_OR_MISMATCH"]),
        "BUSINESS_VALIDATION_REQUIRED", ...(revisionId === null ? ["UNSAVED_PREVIEW"] : []),
      ...errors.map(r => r.cellId + ":" + ("code" in r ? r.code : r.status))],
      results: ordered, evaluatedCellIds,
      manifest: { revisionId, snapshot, configuration, signatures: Object.fromEntries([...graph.nodes].map(([id, n]) => [id, n.signature])) }
    });
    issuedRuns.add(run);
    this.#runs.set(run.id, run);
    return run;
  }

  assessFreshness(run: EngineRun, value: WorkbookSnapshot) {
    const snapshot = captureSnapshot(value);
    requireCondition(run.manifest.snapshot.analysisId === snapshot.analysisId && run.manifest.snapshot.projectId === snapshot.projectId,
      "Run belongs to another analysis/project.");
    const prior = compileGraph(run.manifest.snapshot, run.manifest.configuration);
    const next = compileGraph(snapshot, this.configuration);
    const affected = new Set(affectedNodes(prior, next));
    if (run.engineVersion !== this.version || canonicalJson(run.manifest.configuration.decimal) !== canonicalJson(this.configuration.decimal) ||
      run.manifest.configuration.policyVersionId !== this.configuration.policyVersionId ||
      canonicalJson(run.manifest.snapshot.policy) !== canonicalJson(snapshot.policy)) {
      for (const id of next.nodes.keys()) affected.add(id);
    }
    const oldRelevant = relevantNodes(run.manifest.snapshot, prior);
    const newRelevant = relevantNodes({ ...snapshot, activeProfile: run.manifest.snapshot.activeProfile }, next);
    const staleCellIds = [...affected].filter(id => oldRelevant.has(id) || newRelevant.has(id)).sort();
    return freeze({
      freshness: staleCellIds.length ? "STALE" as const : "CURRENT" as const,
      decisionStatus: staleCellIds.length ? "NEEDS_REVIEW" as const : "DRAFT" as const, staleCellIds
    });
  }

  reviewRun(snapshot: WorkbookSnapshot, run: EngineRun): WorkbookSnapshot {
    requireCondition(issuedRuns.has(run) && run.manifest.revisionId !== null &&
      run.manifest.snapshot.selectedOfferRevisionId === snapshot.selectedOfferRevisionId &&
      run.manifest.snapshot.activeProfile === snapshot.activeProfile && this.assessFreshness(run, snapshot).freshness === "CURRENT",
      "Only a current, revision-bound issued run can be reviewed.");
    const graph = compileGraph(snapshot, this.configuration);
    const relevant = relevantNodes(snapshot, graph);
    const inputCellIds = [...graph.nodes.values()].filter(n => relevant.has(n.cell.id) && n.cell.source.kind === "INPUT").map(n => n.cell.id);
    const profile = snapshot.activeProfile;
    const reference = {
      id: run.id, snapshotId: run.snapshotId, profile, selectedOfferRevisionId: run.manifest.snapshot.selectedOfferRevisionId,
      engineVersion: run.engineVersion, policyVersionId: run.policyVersionId, status: run.status
    };
    const withReference = captureSnapshot({
      ...snapshot,
      calculationRunRefs: [...snapshot.calculationRunRefs.filter(r => r.id !== run.id), reference]
    });
    return recordReviewContext(withReference, profile, {
      inputCellIds, snapshotId: withReference.id, profile,
      selectedOfferRevisionId: snapshot.selectedOfferRevisionId,
      mappingVersionIds: snapshot.mappings.filter(m => relevant.has(m.targetCellId)).map(m => m.versionId),
      runId: run.id, freshness: "CURRENT", decisionStatus: "DRAFT"
    });
  }

  refreshReviewContexts(before: WorkbookSnapshot, after: WorkbookSnapshot, run: EngineRun): WorkbookSnapshot {
    const normalized = invalidateReviewContexts(before, after);
    const assessment = this.assessFreshness(run, after);
    const profiles = { ...normalized.profiles };
    for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
      const context = profiles[profile].reviewContext;
      if (context?.runId === run.id && assessment.freshness === "STALE") profiles[profile] = {
        ...profiles[profile],
        reviewContext: { ...context, freshness: "STALE", decisionStatus: "NEEDS_REVIEW" }
      };
    }
    return captureSnapshot({ ...normalized, profiles });
  }

  canPublish(run: EngineRun, head: SavedRevision): boolean {
    return issuedRuns.has(run) && !(run.manifest.revisionId !== head.revisionId ||
      run.snapshotId !== head.snapshot.id || canonicalJson(run.manifest.snapshot) !== canonicalJson(head.snapshot) ||
      run.engineVersion !== this.version || canonicalJson(run.manifest.configuration) !== canonicalJson(this.configuration));
  }

  // The caller supplies the authoritative repository head at publication, never a client revision claim.
  publish(run: EngineRun, head: SavedRevision): "PUBLISHED_PREVIEW" | "STALE_RUN" {
    if (!this.canPublish(run, head)) return "STALE_RUN";
    this.#published.set(head.snapshot.analysisId + ":" + head.snapshot.activeProfile, run);
    return "PUBLISHED_PREVIEW";
  }

  latest(analysisId: WorkbookSnapshot["analysisId"], profile: WorkbookSnapshot["activeProfile"]): EngineRun | null {
    return this.#published.get(analysisId + ":" + profile) ?? null;
  }

  getRun(runId: EngineRun["id"]): EngineRun | null { return this.#runs.get(parseStableId<"run">(runId)) ?? null; }

  runHistory(analysisId: WorkbookSnapshot["analysisId"]): readonly EngineRun[] {
    const id = parseStableId<"analysis">(analysisId);
    return Object.freeze([...this.#runs.values()].filter(run => run.manifest.snapshot.analysisId === id));
  }
}
