import assert from "node:assert/strict";
import { it } from "node:test";
import { InMemoryRevisionRepository } from "../src/persistence/in-memory-revision-repository.ts";
import { canonicalJson, serializeSnapshot } from "../src/domain/snapshots.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import type { SaveRequest, SaveOutcome } from "../src/application/contracts.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { fixture, id } from "./phase2-fixture.ts";

function request(snapshot: WorkbookSnapshot, expectedRevisionId: SaveRequest["expectedRevisionId"] = null): SaveRequest {
  return { intent: "SAVE_DRAFT", expectedRevisionId, mutationId: id<"mutation">(), snapshot };
}

function saved(outcome: SaveOutcome) {
  assert.equal(outcome.status, "SAVED");
  assert.ok(outcome.status === "SAVED");
  return outcome.revision;
}

it("save freezes history and detaches every exposed payload from the mutable draft", () => {
  const repo = new InMemoryRevisionRepository();
  const draft = fixture();
  const actor = id<"user">();
  const req = request(draft);
  const revision = saved(repo.save(req, actor));
  const before = canonicalJson(repo.history(draft.analysisId));
  draft.project.name = "Changed after save";
  draft.analysis.offerRevisions[0]!.values[0]!.input = { kind: "TEXT", text: "Changed" };
  assert.equal(canonicalJson(repo.history(draft.analysisId)), before);
  assert.notEqual(revision.snapshot.id, draft.id);
  assert.equal(revision.parentRevisionId, null);
  assert.equal(revision.kind, "SAVED_DRAFT");
  assert.equal(revision.run, null);
  assert.equal(repo.head(draft.analysisId)?.actorId, actor);
  assert.equal(repo.head(draft.analysisId)?.mutationId, req.mutationId);
  assert.equal(repo.get(draft.analysisId, revision.revisionId).revision, revision);
  assert.throws(() => (repo.history(draft.analysisId) as unknown[]).pop(), TypeError);
  assert.equal(Reflect.set(revision.snapshot.project, "name", "History rewrite"), false);
});

it("two proposed saves from one base yield a structured conflict and keep the successful history", async () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  const a = updateCellInput(s, "INU", s.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "draft A" });
  const b = updateCellInput(s, "INU", s.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "draft B" });
  const results = await Promise.all([Promise.resolve().then(() => repo.save(request(a, first.revisionId), actor)),
    Promise.resolve().then(() => repo.save(request(b, first.revisionId), actor))]);
  const winner = saved(results[0]!);
  assert.deepEqual(results[1], { status: "CONFLICT", code: "STALE_REVISION",
    expectedRevisionId: first.revisionId, currentRevisionId: winner.revisionId });
  assert.equal(repo.head(s.analysisId)?.revision.revisionId, winner.revisionId);
  assert.equal(repo.history(s.analysisId).length, 2);
  assert.equal(winner.parentRevisionId, first.revisionId);
  assert.deepEqual(repo.save({ ...request(b, first.revisionId), intent: "CONFIRM_RESULT" }, actor), results[1]);
});

it("a stale initial/unknown revision is rejected even when the project has no head", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const expectedRevisionId = id<"revision">();
  assert.deepEqual(repo.save(request(s, expectedRevisionId), id<"user">()), {
    status: "CONFLICT", code: "STALE_REVISION", expectedRevisionId, currentRevisionId: null,
  });
  assert.equal(repo.history(s.analysisId).length, 0);
});

it("retries return the original revision even after the head advances; mutation reuse is explicit", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const req = request(s);
  const original = repo.save(req, actor);
  const first = saved(original);
  saved(repo.save(request(s, first.revisionId), actor));
  assert.deepEqual(repo.save(req, actor), original);
  assert.equal(repo.history(s.analysisId).length, 2);
  assert.equal(repo.save(req, id<"user">()).status, "REJECTED");
  const changed = structuredClone(s);
  changed.project.name = "Different payload";
  assert.deepEqual(repo.save({ ...req, snapshot: changed }, actor), {
    status: "REJECTED", code: "IDEMPOTENCY_CONFLICT", reason: "Mutation ID was already used with another payload or actor.",
  });
  assert.equal(repo.history(s.analysisId).length, 2);
});

it("bad input and unavailable confirmation never leave partial history", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  const before = canonicalJson(repo.history(s.analysisId));
  const invalid = structuredClone(s);
  invalid.analysis.vendors[0]!.analysisId = id<"analysis">();
  for (const input of [null, {}, { ...request(invalid, first.revisionId) },
    { ...request(s, first.revisionId), clientActorId: actor }, { ...request(s, first.revisionId), expectedRevisionId: "row-1" }]) {
    const outcome = repo.save(input, actor);
    assert.equal(outcome.status, "REJECTED");
    assert.ok(outcome.status === "REJECTED");
    assert.equal(outcome.code, "INVALID_REQUEST");
  }
  const confirm = repo.save({ ...request(s, first.revisionId), intent: "CONFIRM_RESULT" }, actor);
  assert.ok(confirm.status === "REJECTED");
  assert.equal(confirm.code, "CONFIRMATION_UNAVAILABLE");
  assert.equal(repo.save(request(s, first.revisionId), "not a user ID").status, "REJECTED");
  assert.equal(canonicalJson(repo.history(s.analysisId)), before);
});

it("existing offer revisions cannot be rewritten by a later save", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  s.analysis.offerRevisions[0]!.values[0]!.input = { kind: "NUMERIC_TEXT", text: "silently changed old offer" };
  const outcome = repo.save(request(s, first.revisionId), actor);
  assert.ok(outcome.status === "REJECTED");
  assert.equal(outcome.code, "INVALID_HISTORY_TRANSITION");
  assert.equal(repo.history(s.analysisId).length, 1);
});

it("changing a saved formula requires a new version ID, without rewriting the historical version", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  s.formulas[0]!.expression = "CHANGED_UNEVALUATED_TEST_EXPRESSION";
  const rejected = repo.save(request(s, first.revisionId), actor);
  assert.ok(rejected.status === "REJECTED");
  assert.equal(rejected.code, "INVALID_HISTORY_TRANSITION");
  s.formulas[0]!.versionId = id<"formula-version">();
  saved(repo.save(request(s, first.revisionId), actor));
  assert.equal(repo.get(s.analysisId, first.revisionId).revision.snapshot.formulas[0]!.expression,
    first.snapshot.formulas[0]!.expression);
  assert.equal(repo.history(s.analysisId).length, 2);
});

it("restore appends a new draft revision with provenance and leaves both historical states intact", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  const oldState = serializeSnapshot(first.snapshot);
  const newer = updateCellInput(first.snapshot, "INU", first.snapshot.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "later manual HPP" });
  const second = saved(repo.save(request(newer, first.revisionId), actor));
  const historyBefore = canonicalJson(repo.history(s.analysisId));
  const restoreRequest = { analysisId: s.analysisId, sourceRevisionId: first.revisionId,
    expectedRevisionId: second.revisionId, mutationId: id<"mutation">() };
  const restored = saved(repo.restore(restoreRequest, actor));
  assert.equal(restored.kind, "SAVED_DRAFT");
  assert.notEqual(restored.revisionId, first.revisionId);
  assert.notEqual(restored.snapshot.id, first.snapshot.id);
  assert.equal(restored.parentRevisionId, second.revisionId);
  assert.deepEqual(restored.restoredFrom, { revisionId: first.revisionId, snapshotId: first.snapshot.id });
  assert.deepEqual({ ...restored.snapshot, id: first.snapshot.id }, first.snapshot);
  assert.equal(canonicalJson(repo.history(s.analysisId).slice(0, 2)), historyBefore);
  assert.equal(serializeSnapshot(repo.replay(s.analysisId, first.revisionId)), oldState);
  assert.equal(serializeSnapshot(repo.replay(s.analysisId, first.revisionId)), oldState);
  assert.deepEqual(repo.restore(restoreRequest, actor), { status: "SAVED", revision: restored });
  assert.equal(repo.history(s.analysisId).length, 3);
  assert.equal(repo.restore({ ...restoreRequest, mutationId: id<"mutation">() }, actor).status, "CONFLICT");
});

it("replay preserves historical policy and formula definitions after current configuration changes", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  s.policy = { status: "CONFIGURED", versionId: id<"policy">() };
  s.formulas[0]!.versionId = id<"formula-version">();
  s.formulas[0]!.expression = "NEW_UNEVALUATED_TEST_EXPRESSION";
  saved(repo.save(request(s, first.revisionId), actor));
  const replay = repo.replay(s.analysisId, first.revisionId);
  assert.equal(replay.policy.status, "UNCONFIGURED");
  assert.equal(replay.formulas[0]!.expression, first.snapshot.formulas[0]!.expression);
  assert.equal(serializeSnapshot(replay), serializeSnapshot(first.snapshot));
});

it("run references retain historical context but cannot validate or confirm arithmetic", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  const run = { id: id<"run">(), snapshotId: first.snapshot.id, profile: "INU" as const,
    selectedOfferRevisionId: s.selectedOfferRevisionId, engineVersion: "historical-test-metadata",
    policyVersionId: null, status: "NOT_EVALUATED" as const };
  s.calculationRunRefs.push(run);
  s.profiles.INU.hppBase.contextRunId = run.id;
  const second = saved(repo.save(request(s, first.revisionId), actor));
  assert.deepEqual(second.snapshot.calculationRunRefs[0], run);
  const mutated = structuredClone(s);
  mutated.calculationRunRefs[0]!.engineVersion = "rewritten history";
  assert.equal(repo.save(request(mutated, second.revisionId), actor).status, "REJECTED");
  const missingSnapshot = structuredClone(s);
  missingSnapshot.calculationRunRefs.push({ ...run, id: id<"run">(), snapshotId: id<"snapshot">() });
  assert.equal(repo.save(request(missingSnapshot, second.revisionId), actor).status, "REJECTED");
  const crossProfile = structuredClone(s);
  crossProfile.profiles.SOLAR_BAWAH.hppBase.contextRunId = run.id;
  assert.equal(repo.save(request(crossProfile, second.revisionId), actor).status, "REJECTED");
  assert.equal(repo.history(s.analysisId).length, 2);
});

it("history lookup and restore are project-scoped; malformed restore cannot mutate state", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const first = saved(repo.save(request(s), actor));
  const otherAnalysis = id<"analysis">();
  assert.equal(repo.head(otherAnalysis), null);
  assert.throws(() => repo.get(otherAnalysis, first.revisionId), TypeError);
  assert.throws(() => repo.replay(s.analysisId, id<"revision">()), TypeError);
  assert.equal(repo.restore({ analysisId: otherAnalysis, sourceRevisionId: first.revisionId,
    expectedRevisionId: null, mutationId: id<"mutation">() }, actor).status, "REJECTED");
  assert.equal(repo.restore({}, actor).status, "REJECTED");
  assert.equal(repo.history(s.analysisId).length, 1);
  const current = repo.head(s.analysisId)!.revision;
  assert.equal(Reflect.set(current, "savedAt", "Changed"), false);
});

it("commits an immutable event with actor, time, target, action and before/after for save and restore", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const actor = id<"user">();
  const initialRequest = request(s);
  const first = saved(repo.save(initialRequest, actor));
  const initialEvent = repo.head(s.analysisId)!.changeEvent;
  assert.equal(initialEvent.before, null);
  assert.equal(initialEvent.reason, null);
  assert.equal(initialEvent.action, "SAVE_DRAFT");
  assert.equal(initialEvent.actorId, actor);
  assert.equal(initialEvent.targetProjectId, s.projectId);
  assert.equal(initialEvent.revisionBeforeId, null);
  assert.equal(initialEvent.revisionAfterId, first.revisionId);
  assert.equal(initialEvent.after, first.snapshot);
  assert.equal(initialEvent.occurredAt, first.savedAt);
  assert.equal(new Date(initialEvent.occurredAt).toISOString(), initialEvent.occurredAt);

  const changed = updateCellInput(first.snapshot, "INU", s.profiles.INU.hppBase.cellId,
    { kind: "NUMERIC_TEXT", text: "manual updated HPP" });
  const secondRequest = { ...request(changed, first.revisionId), reason: "Reviewed conversion context" };
  const second = saved(repo.save(secondRequest, actor));
  const secondEvent = repo.head(s.analysisId)!.changeEvent;
  assert.equal(secondEvent.before, first.snapshot);
  assert.equal(secondEvent.after, second.snapshot);
  assert.equal(secondEvent.reason, secondRequest.reason);
  assert.notEqual(secondEvent.id, initialEvent.id);
  assert.equal(secondEvent.revisionBeforeId, first.revisionId);
  assert.equal(secondEvent.revisionAfterId, second.revisionId);
  const historyBefore = canonicalJson(repo.history(s.analysisId));
  saved(repo.save(secondRequest, actor));
  assert.equal(canonicalJson(repo.history(s.analysisId)), historyBefore);
  const reused = repo.save({ ...secondRequest, reason: "Different reason" }, actor);
  assert.ok(reused.status === "REJECTED");
  assert.equal(reused.code, "IDEMPOTENCY_CONFLICT");
  for (const reason of [null, undefined, "", "  ", 123]) {
    const rejected = repo.save({ ...request(changed, second.revisionId), reason }, actor);
    assert.ok(rejected.status === "REJECTED");
    assert.equal(rejected.code, "INVALID_REQUEST");
  }
  repo.save(request(changed, first.revisionId), actor);
  assert.equal(canonicalJson(repo.history(s.analysisId)), historyBefore);

  const restoreRequest = { analysisId: s.analysisId, sourceRevisionId: first.revisionId,
    expectedRevisionId: second.revisionId, mutationId: id<"mutation">(), reason: "Restore reviewed historical state" };
  const restored = saved(repo.restore(restoreRequest, actor));
  const event = repo.head(s.analysisId)!.changeEvent;
  assert.equal(event.action, "RESTORE");
  assert.equal(event.before, second.snapshot);
  assert.equal(event.after, restored.snapshot);
  assert.equal(event.reason, restoreRequest.reason);
  assert.equal(event.revisionBeforeId, second.revisionId);
  assert.equal(event.revisionAfterId, restored.revisionId);
  assert.equal(event.occurredAt, restored.savedAt);
  assert.equal(Reflect.set(event, "reason", "rewrite"), false);
  assert.equal(Reflect.set(event.before!.project, "name", "rewrite"), false);
  saved(repo.restore(restoreRequest, actor));
  assert.equal(repo.history(s.analysisId).length, 3);
  const rejected = repo.restore({ ...restoreRequest, reason: "Another reason" }, actor);
  assert.ok(rejected.status === "REJECTED");
  assert.equal(rejected.code, "IDEMPOTENCY_CONFLICT");
});
