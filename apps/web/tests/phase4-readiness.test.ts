import assert from "node:assert/strict";
import { it } from "node:test";
import type { SaveRequest, SaveOutcome } from "../src/application/contracts.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { appendOfferRevision } from "../src/domain/commands.ts";
import { captureSnapshot, canonicalJson, deserializeSnapshot, serializeSnapshot } from "../src/domain/snapshots.ts";
import { InMemoryRevisionRepository } from "../src/persistence/in-memory-revision-repository.ts";
import { fixture, id } from "./phase2-fixture.ts";
import type { Mutable } from "./phase2-fixture.ts";

function request(snapshot: WorkbookSnapshot, expectedRevisionId: SaveRequest["expectedRevisionId"] = null): SaveRequest {
  return { intent: "SAVE_DRAFT", snapshot, expectedRevisionId, mutationId: id<"mutation">() };
}
function saved(outcome: SaveOutcome) {
  assert.ok(outcome.status === "SAVED", JSON.stringify(outcome));
  return outcome.revision;
}

it("offer revision numbers round-trip throughout the positive safe-integer range", () => {
  for (const value of [1, 2147483647, 2147483648, Number.MAX_SAFE_INTEGER]) {
    const snapshot = fixture(); snapshot.analysis.offerRevisions[0]!.revisionNumber = value;
    assert.equal(deserializeSnapshot(serializeSnapshot(snapshot)).analysis.offerRevisions[0]!.revisionNumber, value);
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const snapshot = fixture(); snapshot.analysis.offerRevisions[0]!.revisionNumber = value;
    assert.throws(() => captureSnapshot(snapshot), /positive safe integer/);
  }
});

it("offer numbers remain reserved across saved history, removal, rehydration and restore", () => {
  const actor = id<"user">(), repo = new InMemoryRevisionRepository(), snapshot = fixture();
  const firstRequest = request(snapshot), first = saved(repo.save(firstRequest, actor));
  const original = first.snapshot.analysis.offerRevisions[0]!;
  assert.throws(() => appendOfferRevision(first.snapshot, { ...original, id: id<"offer-revision">() }), /newer revision number/);

  const replacement = structuredClone(snapshot);
  replacement.analysis.offerRevisions[0]!.id = id<"offer-revision">();
  replacement.selectedOfferRevisionId = replacement.analysis.offerRevisions[0]!.id;
  const unchanged = canonicalJson(repo.history(snapshot.analysisId));
  const rejected = repo.save(request(replacement, first.revisionId), actor);
  assert.ok(rejected.status === "REJECTED"); assert.equal(rejected.code, "INVALID_HISTORY_TRANSITION");
  assert.equal(canonicalJson(repo.history(snapshot.analysisId)), unchanged);

  const removed = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>;
  removed.analysis.offerRevisions = []; removed.selectedOfferRevisionId = null;
  const second = saved(repo.save(request(removed, first.revisionId), actor));
  const hydrated = new InMemoryRevisionRepository(repo.history(snapshot.analysisId));
  const rejectedAfterReload = hydrated.save(request(replacement, second.revisionId), actor);
  assert.ok(rejectedAfterReload.status === "REJECTED"); assert.equal(rejectedAfterReload.code, "INVALID_HISTORY_TRANSITION");
  assert.equal(hydrated.history(snapshot.analysisId).length, 2);

  const restored = saved(repo.restore({ analysisId: snapshot.analysisId, sourceRevisionId: first.revisionId,
    expectedRevisionId: second.revisionId, mutationId: id<"mutation">() }, actor));
  assert.equal(restored.snapshot.analysis.offerRevisions[0]!.id, original.id);
  assert.deepEqual(repo.replay(snapshot.analysisId, first.revisionId), first.snapshot);
  assert.deepEqual(repo.save(firstRequest, actor), { status: "SAVED", revision: first });
});

it("offer number reservations are per offer, not a global sequence", () => {
  const actor = id<"user">(), repo = new InMemoryRevisionRepository(), snapshot = fixture();
  const first = saved(repo.save(request(snapshot), actor));
  const next = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>, offerId = id<"offer">();
  next.analysis.offers.push({ ...next.analysis.offers[0]!, id: offerId });
  next.analysis.offerRevisions.push({ id: id<"offer-revision">(), offerId, revisionNumber: 1, values: [] });
  const second = saved(repo.save(request(next, first.revisionId), actor));
  assert.equal(second.snapshot.selectedOfferRevisionId, first.snapshot.selectedOfferRevisionId);
  assert.equal(second.snapshot.analysis.offerRevisions.length, 2);
});
