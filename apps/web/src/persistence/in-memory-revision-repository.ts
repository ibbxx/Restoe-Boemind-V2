import type { SaveOutcome } from "../application/contracts.ts";
import type { RestoreProvenance, WorkbookSnapshot } from "../domain/contracts.ts";
import { createStableId, parseStableId } from "../domain/ids.ts";
import type { StableId } from "../domain/ids.ts";
import { canonicalJson, captureSnapshot, deserializeSnapshot, freeze, serializeSnapshot } from "../domain/snapshots.ts";
import { DomainValidationError, nullableId, object, requireCondition, text } from "../domain/validation.ts";
import type { RevisionRepository, StoredRevision } from "./contracts.ts";
import { describeChanges } from "../domain/change-events.ts";
import { invalidateReviewContexts } from "../domain/freshness.ts";

type CommitContext = {
  expectedRevisionId: StableId<"revision"> | null;
  mutationId: StableId<"mutation">;
  actorId: StableId<"user">;
  signature: string;
  restoredFrom: RestoreProvenance | null;
  reason: string | null;
};

// Process-local transition planner; PostgreSQL adapter supplies durable transactions and access isolation.
export class InMemoryRevisionRepository implements RevisionRepository {
  #histories = new Map<StableId<"analysis">, readonly StoredRevision[]>();
  #mutations = new Map<string, { signature: string; outcome: SaveOutcome }>();

  // PostgreSQL uses the same transition rules against its locked, persisted history.
  constructor(history: readonly StoredRevision[] = []) {
    for (const stored of history) {
      const captured = freeze(structuredClone(stored));
      this.#histories.set(captured.analysisId, Object.freeze([...this.history(captured.analysisId), captured]));
    }
  }

  head(analysisId: unknown): StoredRevision | null {
    return this.history(analysisId).at(-1) ?? null;
  }

  history(analysisId: unknown): readonly StoredRevision[] {
    return this.#histories.get(parseStableId<"analysis">(analysisId)) ?? Object.freeze([]);
  }

  get(analysisId: unknown, revisionId: unknown): StoredRevision {
    const id = parseStableId<"revision">(revisionId);
    const stored = this.history(analysisId).find(r => r.revision.revisionId === id);
    requireCondition(stored, "Revision does not exist in this analysis.");
    return stored;
  }

  // State replay uses the historical payload, never today's policy or an evaluator.
  replay(analysisId: unknown, revisionId: unknown): WorkbookSnapshot {
    return deserializeSnapshot(serializeSnapshot(this.get(analysisId, revisionId).revision.snapshot));
  }

  save(request: unknown, actorId: unknown): SaveOutcome {
    try {
      const r = requestWithReason(request, ["intent", "expectedRevisionId", "mutationId", "snapshot"]);
      requireCondition(r.intent === "SAVE_DRAFT" || r.intent === "CONFIRM_RESULT", "Unknown save intent.");
      const snapshot = captureSnapshot(r.snapshot);
      const context: CommitContext = {
        expectedRevisionId: nullableId<"revision">(r.expectedRevisionId), mutationId: parseStableId<"mutation">(r.mutationId),
        actorId: parseStableId<"user">(actorId), signature: "", restoredFrom: null, reason: r.reason,
      };
      context.signature = canonicalJson({ intent: r.intent, expectedRevisionId: context.expectedRevisionId,
        snapshot, actorId: context.actorId, reason: context.reason });
      const retry = this.#retry(snapshot.analysisId, context);
      if (retry) return retry;
      if (r.intent === "CONFIRM_RESULT") return this.#conflict(snapshot.analysisId, context.expectedRevisionId) ?? freeze({ status: "REJECTED", code: "CONFIRMATION_UNAVAILABLE",
        reason: "No approved business-finalization policy is configured; calculation previews cannot be confirmed." });
      return this.#commit(snapshot, context);
    } catch (error) {
      return invalidRequest(error);
    }
  }

  restore(request: unknown, actorId: unknown): SaveOutcome {
    try {
      const r = requestWithReason(request, ["analysisId", "sourceRevisionId", "expectedRevisionId", "mutationId"]);
      const analysisId = parseStableId<"analysis">(r.analysisId);
      const sourceRevisionId = parseStableId<"revision">(r.sourceRevisionId);
      const context: CommitContext = {
        expectedRevisionId: nullableId<"revision">(r.expectedRevisionId), mutationId: parseStableId<"mutation">(r.mutationId),
        actorId: parseStableId<"user">(actorId), signature: "", restoredFrom: null, reason: r.reason,
      };
      context.signature = canonicalJson({ operation: "RESTORE", analysisId, sourceRevisionId,
        expectedRevisionId: context.expectedRevisionId, actorId: context.actorId, reason: context.reason });
      const retry = this.#retry(analysisId, context);
      if (retry) return retry;
      const source = this.get(analysisId, sourceRevisionId).revision;
      context.restoredFrom = { revisionId: source.revisionId, snapshotId: source.snapshot.id };
      return this.#commit(source.snapshot, context);
    } catch (error) {
      return invalidRequest(error);
    }
  }

  #retry(analysisId: StableId<"analysis">, context: CommitContext): SaveOutcome | null {
    const prior = this.#mutations.get(analysisId + ":" + context.mutationId);
    if (!prior) return null;
    return prior.signature === context.signature ? prior.outcome : freeze({ status: "REJECTED",
      code: "IDEMPOTENCY_CONFLICT", reason: "Mutation ID was already used with another payload or actor." });
  }

  #commit(snapshot: WorkbookSnapshot, context: CommitContext): SaveOutcome {
    const conflict = this.#conflict(snapshot.analysisId, context.expectedRevisionId);
    if (conflict) return conflict;
    const currentRevisionId = this.head(snapshot.analysisId)?.revision.revisionId ?? null;

    const history = this.history(snapshot.analysisId);
    if (history.some(h => h.projectId !== snapshot.projectId)) return freeze({ status: "REJECTED", code: "INVALID_HISTORY_TRANSITION",
      reason: "An analysis cannot be moved to another project by saving a snapshot." });
    const offerHistory = history.flatMap(h => h.revision.snapshot.analysis.offerRevisions);
    const knownOffers = new Map(offerHistory.map(r => [r.id, canonicalJson(r)]));
    const knownOfferNumbers = new Map(offerHistory.map(r => [r.offerId + ":" + r.revisionNumber, r.id]));
    if (snapshot.analysis.offerRevisions.some(r => {
      const priorId = knownOfferNumbers.get(r.offerId + ":" + r.revisionNumber);
      return priorId !== undefined && priorId !== r.id;
    })) return freeze({ status: "REJECTED", code: "INVALID_HISTORY_TRANSITION",
      reason: "An offer revision number is permanently reserved for its original revision ID." });
    const knownRuns = new Map(history.flatMap(h => h.revision.snapshot.calculationRunRefs).map(r => [r.id, canonicalJson(r)]));
    const knownFormulas = new Map(history.flatMap(h => h.revision.snapshot.formulas).map(f => [f.versionId, canonicalJson(f)]));
    const knownMappings = new Map(history.flatMap(h => h.revision.snapshot.mappings).map(m => [m.versionId, canonicalJson(m)]));
    const changedOffer = snapshot.analysis.offerRevisions.some(r => knownOffers.has(r.id) && knownOffers.get(r.id) !== canonicalJson(r));
    const changedRun = snapshot.calculationRunRefs.some(r => knownRuns.has(r.id) && knownRuns.get(r.id) !== canonicalJson(r));
    const changedFormulaVersion = snapshot.formulas.some(f => knownFormulas.has(f.versionId) && knownFormulas.get(f.versionId) !== canonicalJson(f));
    const changedMapping = snapshot.mappings.some(m => knownMappings.has(m.versionId) && knownMappings.get(m.versionId) !== canonicalJson(m));
    if (changedOffer || changedRun || changedFormulaVersion || changedMapping) return freeze({ status: "REJECTED", code: "INVALID_HISTORY_TRANSITION",
      reason: "An existing offer revision, formula version, mapping version or calculation run reference cannot be rewritten." });

    const invalidRunContext = snapshot.calculationRunRefs.some(run => {
      const source = history.find(h => h.revision.snapshot.id === run.snapshotId)?.revision.snapshot;
      return !source || run.selectedOfferRevisionId !== source.selectedOfferRevisionId ||
        run.policyVersionId !== (source.policy.status === "CONFIGURED" ? source.policy.versionId : null);
    });
    if (invalidRunContext) return freeze({ status: "REJECTED", code: "INVALID_HISTORY_TRANSITION",
      reason: "Run references require an existing historical snapshot and its exact selection/policy context." });

    const before = history.at(-1)?.revision.snapshot ?? null;
    const normalized = before ? invalidateReviewContexts(before, snapshot) : snapshot;
    const snapshotId = createStableId<"snapshot">();
    const profiles = { ...normalized.profiles };
    for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
      const review = profiles[profile].reviewContext;
      if (review?.freshness === "CURRENT" && !history.some(h => h.revision.snapshot.id === review.snapshotId)) {
        profiles[profile] = { ...profiles[profile], reviewContext: { ...review, snapshotId } };
      }
    }
    const savedSnapshot = captureSnapshot({ ...normalized, profiles, id: snapshotId });
    const revisionId = createStableId<"revision">();
    const savedAt = new Date().toISOString();
    const stored: StoredRevision = freeze({ projectId: snapshot.projectId, analysisId: snapshot.analysisId, actorId: context.actorId, mutationId: context.mutationId,
      revision: { kind: "SAVED_DRAFT", revisionId, snapshot: savedSnapshot, run: null,
        parentRevisionId: currentRevisionId, savedAt, restoredFrom: context.restoredFrom },
      changeEvent: { id: createStableId<"change-event">(), actorId: context.actorId, occurredAt: savedAt,
        targetProjectId: snapshot.projectId, targetAnalysisId: snapshot.analysisId,
        changes: describeChanges(before, savedSnapshot), action: context.restoredFrom ? "RESTORE" : "SAVE_DRAFT",
        revisionBeforeId: currentRevisionId, revisionAfterId: revisionId,
        before, after: savedSnapshot, reason: context.reason } });
    const outcome: SaveOutcome = freeze({ status: "SAVED", revision: stored.revision });
    // No await or external side effect between validation and the process-local commit.
    this.#histories.set(snapshot.analysisId, freeze([...history, stored]));
    this.#mutations.set(snapshot.analysisId + ":" + context.mutationId, { signature: context.signature, outcome });
    return outcome;
  }

  #conflict(analysisId: StableId<"analysis">, expectedRevisionId: StableId<"revision"> | null): SaveOutcome | null {
    const currentRevisionId = this.head(analysisId)?.revision.revisionId ?? null;
    return expectedRevisionId === currentRevisionId ? null : freeze({ status: "CONFLICT", code: "STALE_REVISION",
      expectedRevisionId, currentRevisionId });
  }
}

export function requestWithReason(request: unknown, keys: readonly string[]): Record<string, unknown> & { reason: string | null } {
  const hasReason = request !== null && typeof request === "object" && Object.hasOwn(request, "reason");
  const r = object(request, hasReason ? [...keys, "reason"] : keys);
  return { ...r, reason: hasReason ? text(r.reason, true) : null };
}

function invalidRequest(error: unknown): SaveOutcome {
  if (!(error instanceof DomainValidationError || error instanceof TypeError)) throw error;
  return freeze({ status: "REJECTED", code: "INVALID_REQUEST", reason: error.message });
}
