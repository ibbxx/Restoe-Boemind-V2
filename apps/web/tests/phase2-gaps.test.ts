import assert from "node:assert/strict";
import { it } from "node:test";
import type { MappingVersion, ReviewContext, WorkbookSnapshot } from "../src/domain/contracts.ts";
import type { Profile } from "../src/domain/profiles.ts";
import { activateProfile, addOffer, addVendor, appendOfferRevision, recordReviewContext, reorderTable,
  replaceMappingVersion, selectOfferRevision, updateCellInput } from "../src/domain/commands.ts";
import { captureSnapshot, canonicalJson, deserializeSnapshot, serializeSnapshot } from "../src/domain/snapshots.ts";
import { InMemoryRevisionRepository } from "../src/persistence/in-memory-revision-repository.ts";
import { fixture, id } from "./phase2-fixture.ts";
import type { Mutable } from "./phase2-fixture.ts";

function mapping(s: WorkbookSnapshot, profile: Profile = "INU"): Mutable<MappingVersion> {
  return { id: id<"mapping">(), versionId: id<"mapping-version">(), analysisId: s.analysisId, scope: profile,
    sourceCellId: s.worksheets[0]!.tables[0]!.cells[0]!.id,
    targetCellId: s.worksheets[2]!.tables[profile === "INU" ? 0 : 1]!.cells[1]!.id,
    sourceComponent: "TEST_COMPONENT", transformExpression: null, sourceUnit: "TEST_UNIT", targetUnit: "TEST_UNIT",
    status: "DRAFT", provenance: { actorId: id<"user">(), changeEventId: id<"change-event">(), sourceRef: "test source", reason: "test metadata only" } };
}

function reviewed(s: WorkbookSnapshot, profile: Profile, inputCellIds?: ReviewContext["inputCellIds"]) {
  return recordReviewContext(s, profile, { snapshotId: s.id, profile, selectedOfferRevisionId: s.selectedOfferRevisionId,
    inputCellIds: inputCellIds ?? [s.worksheets[2]!.tables[profile === "INU" ? 0 : 1]!.cells[1]!.id],
    mappingVersionIds: s.mappings.filter(m => m.scope === profile || m.scope === "SHARED").map(m => m.versionId),
    runId: null, freshness: "CURRENT", decisionStatus: "CONFIRMED" });
}

function save(repo: InMemoryRevisionRepository, snapshot: WorkbookSnapshot,
  expectedRevisionId = repo.head(snapshot.analysisId)?.revision.revisionId ?? null, mutationId = id<"mutation">()) {
  const outcome = repo.save({ intent: "SAVE_DRAFT", snapshot, expectedRevisionId, mutationId }, actor);
  assert.ok(outcome.status === "SAVED", JSON.stringify(outcome));
  return outcome.revision;
}
const actor = id<"user">();

it("two analyses in one project have independent heads, selections, inputs, retry keys, history and restore", () => {
  const repo = new InMemoryRevisionRepository();
  const a = fixture();
  const b = fixture();
  b.project = { ...a.project };
  b.projectId = a.projectId;
  b.analysis.analysis.projectId = a.projectId;
  const mutationId = id<"mutation">();
  const firstA = save(repo, a, null, mutationId);
  const firstB = save(repo, b, null, mutationId);
  assert.notEqual(firstA.revisionId, firstB.revisionId);
  const bBefore = canonicalJson(repo.history(b.analysisId));
  const secondA = save(repo, selectOfferRevision(a, null));
  assert.equal(secondA.snapshot.selectedOfferRevisionId, null);
  assert.equal(canonicalJson(repo.history(b.analysisId)), bBefore);
  assert.equal(repo.head(b.analysisId)!.revision.revisionId, firstB.revisionId);
  assert.throws(() => repo.get(b.analysisId, firstA.revisionId), TypeError);
  assert.throws(() => repo.replay(b.analysisId, firstA.revisionId), TypeError);
  assert.equal(repo.restore({ analysisId: b.analysisId, sourceRevisionId: firstA.revisionId,
    expectedRevisionId: firstB.revisionId, mutationId: id<"mutation">() }, actor).status, "REJECTED");
  assert.equal(repo.save({ intent: "SAVE_DRAFT", snapshot: b, expectedRevisionId: secondA.revisionId,
    mutationId: id<"mutation">() }, actor).status, "CONFLICT");
  const moved = structuredClone(secondA.snapshot) as Mutable<WorkbookSnapshot>;
  moved.projectId = id<"project">();
  moved.project.id = moved.projectId;
  moved.analysis.analysis.projectId = moved.projectId;
  const rejected = repo.save({ intent: "SAVE_DRAFT", snapshot: moved, expectedRevisionId: secondA.revisionId,
    mutationId: id<"mutation">() }, actor);
  assert.ok(rejected.status === "REJECTED");
  assert.equal(rejected.code, "INVALID_HISTORY_TRANSITION");
  const restored = repo.restore({ analysisId: a.analysisId, sourceRevisionId: firstA.revisionId,
    expectedRevisionId: secondA.revisionId, mutationId: id<"mutation">() }, actor);
  assert.ok(restored.status === "SAVED");
  assert.notEqual(restored.revision.revisionId, firstA.revisionId);
  assert.equal(repo.history(a.analysisId).length, 3);
  assert.equal(canonicalJson(repo.history(b.analysisId)), bBefore);
  const changedB = updateCellInput(firstB.snapshot, "SOLAR_BAWAH", b.profiles.SOLAR_BAWAH.hppBase.cellId,
    { kind: "TEXT", text: "manual B" });
  save(repo, changedB);
  assert.deepEqual(repo.head(a.analysisId)!.revision, restored.revision);
});

it("analysis ownership is validated for candidates, offers and workspace metadata", () => {
  for (const change of [
    (s: Mutable<WorkbookSnapshot>) => { s.analysis.analysis.id = id<"analysis">(); },
    (s: Mutable<WorkbookSnapshot>) => { s.analysis.analysis.projectId = id<"project">(); },
    (s: Mutable<WorkbookSnapshot>) => { s.analysis.vendors[0]!.analysisId = id<"analysis">(); },
    (s: Mutable<WorkbookSnapshot>) => { s.analysis.offers[0]!.analysisId = id<"analysis">(); },
  ]) {
    const s = fixture();
    change(s);
    assert.throws(() => captureSnapshot(s), TypeError);
  }
  const legacy = fixture();
  Object.assign(legacy, { schemaVersion: 1 });
  assert.throws(() => captureSnapshot(legacy), /legacy ownership/);
});

it("mapping metadata round-trips and new versions preserve historical snapshots and replay", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const m = mapping(s);
  const first = save(repo, replaceMappingVersion(s, m));
  const serialized = serializeSnapshot(first.snapshot);
  assert.deepEqual(deserializeSnapshot(serialized).mappings, [m]);
  const secondMapping = { ...m, versionId: id<"mapping-version">(), sourceComponent: "OTHER_TEST_COMPONENT" };
  const second = save(repo, replaceMappingVersion(first.snapshot, secondMapping));
  assert.deepEqual(second.snapshot.mappings, [secondMapping]);
  assert.equal(serializeSnapshot(repo.replay(s.analysisId, first.revisionId)), serialized);
  assert.equal(Reflect.set(first.snapshot.mappings[0]!.provenance, "reason", "rewrite"), false);
  assert.throws(() => replaceMappingVersion(first.snapshot, { ...m, status: "REJECTED" }), /new version/);
  const invalid = structuredClone(second.snapshot) as Mutable<WorkbookSnapshot>;
  invalid.mappings = [{ ...m, sourceComponent: "REWRITE_OLD_VERSION" }];
  const rejected = repo.save({ intent: "SAVE_DRAFT", snapshot: invalid, expectedRevisionId: second.revisionId,
    mutationId: id<"mutation">() }, actor);
  assert.ok(rejected.status === "REJECTED");
  assert.equal(rejected.code, "INVALID_HISTORY_TRANSITION");
  assert.equal(repo.history(s.analysisId).length, 2);
  const restored = repo.restore({ analysisId: s.analysisId, sourceRevisionId: first.revisionId,
    expectedRevisionId: second.revisionId, mutationId: id<"mutation">() }, actor);
  assert.ok(restored.status === "SAVED");
  assert.deepEqual(restored.revision.snapshot.mappings, [m]);
});

const invalidMappings: readonly [string, (m: Mutable<MappingVersion>, s: Mutable<WorkbookSnapshot>) => void][] = [
  ["analysis", m => { m.analysisId = id<"analysis">(); }],
  ["source", m => { m.sourceCellId = id<"cell">(); }],
  ["target", m => { m.targetCellId = id<"cell">(); }],
  ["cross-profile source", (m, s) => { m.sourceCellId = s.profiles.SOLAR_BAWAH.hppBase.cellId; }],
  ["cross-profile target", (m, s) => { m.targetCellId = s.worksheets[2]!.tables[1]!.cells[1]!.id; }],
  ["HPP writer", (m, s) => { m.targetCellId = s.profiles.INU.hppBase.cellId; }],
  ["unit", m => { m.sourceUnit = " "; }],
  ["target unit", m => { m.targetUnit = ""; }],
  ["status", m => { Object.assign(m, { status: "VALID" }); }],
  ["scope", m => { Object.assign(m, { scope: "ALL" }); }],
  ["actor", m => { Object.assign(m.provenance, { actorId: "user" }); }],
  ["event", m => { Object.assign(m.provenance, { changeEventId: "A1" }); }],
  ["unknown field", m => { Object.assign(m, { inferredFactor: 1.11 }); }],
];
for (const [name, mutate] of invalidMappings) {
  it("rejects invalid mapping " + name, () => {
    const s = fixture();
    const m = mapping(s);
    mutate(m, s);
    assert.throws(() => captureSnapshot({ ...s, mappings: [m] }), TypeError);
  });
}

it("duplicate mapping identities and version identities are rejected", () => {
  const s = fixture();
  const m = mapping(s);
  assert.throws(() => captureSnapshot({ ...s, mappings: [m, { ...m, versionId: id<"mapping-version">() }] }), TypeError);
  assert.throws(() => captureSnapshot({ ...s, mappings: [m, { ...mapping(s), versionId: m.versionId }] }), TypeError);
});

it("watched input changes stale only its own reviewed branch and never overwrite manual HPP", () => {
  let s: WorkbookSnapshot = fixture();
  s = updateCellInput(s, "INU", s.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "manual HPP" });
  s = reviewed(reviewed(s, "INU"), "SOLAR_BAWAH");
  const before = serializeSnapshot(s);
  const input = s.profiles.INU.reviewContext!.inputCellIds[0]!;
  const changed = updateCellInput(s, "INU", input, { kind: "TEXT", text: "changed input" });
  assert.equal(changed.profiles.INU.reviewContext!.freshness, "STALE");
  assert.equal(changed.profiles.INU.reviewContext!.decisionStatus, "NEEDS_REVIEW");
  assert.deepEqual(changed.profiles.SOLAR_BAWAH, s.profiles.SOLAR_BAWAH);
  assert.deepEqual(changed.worksheets[2]!.tables[0]!.cells[0], s.worksheets[2]!.tables[0]!.cells[0]);
  assert.equal(serializeSnapshot(s), before);
  const same = updateCellInput(s, "INU", input, { kind: "NUMERIC_TEXT", text: "raw-test-input" });
  assert.deepEqual(same.profiles, s.profiles);
  const switched = activateProfile(activateProfile(changed, "SOLAR_BAWAH"), "INU");
  assert.deepEqual(switched.profiles, changed.profiles);
  const refreshed = reviewed(changed, "INU");
  assert.equal(refreshed.profiles.INU.reviewContext!.freshness, "CURRENT");
  assert.equal(changed.profiles.INU.reviewContext!.freshness, "STALE");
});

it("unwatched shared inputs and reordering do not stale independent contexts", () => {
  let s: WorkbookSnapshot = reviewed(reviewed(fixture(), "INU"), "SOLAR_BAWAH");
  const shared = s.worksheets[0]!.tables[0]!.cells[0]!.id;
  const unrelated = updateCellInput(s, "SHARED", shared, { kind: "TEXT", text: "unwatched" });
  assert.deepEqual(unrelated.profiles, s.profiles);
  s = reviewed(s, "INU", [shared]);
  const changed = updateCellInput(s, "SHARED", shared, { kind: "TEXT", text: "watched by INU" });
  assert.equal(changed.profiles.INU.reviewContext!.freshness, "STALE");
  assert.deepEqual(changed.profiles.SOLAR_BAWAH, s.profiles.SOLAR_BAWAH);
  const table = s.worksheets[2]!.tables[0]!;
  const reordered = reorderTable(s, table.id, { rows: [...table.rowOrder].reverse(), columns: table.columnOrder });
  assert.deepEqual(reordered.profiles, s.profiles);
});

it("selected offer revision changes require review while newer offers never replace the pinned selection", () => {
  const s = reviewed(reviewed(fixture(), "INU"), "SOLAR_BAWAH");
  const revision = { id: id<"offer-revision">(), offerId: s.analysis.offers[0]!.id, revisionNumber: 2, values: [] };
  const appended = appendOfferRevision(s, revision);
  assert.equal(appended.selectedOfferRevisionId, s.selectedOfferRevisionId);
  for (const p of ["INU", "SOLAR_BAWAH"] as const) assert.equal(appended.profiles[p].reviewContext!.freshness, "STALE");
  const selected = selectOfferRevision(appended, revision.id);
  assert.equal(selected.selectedOfferRevisionId, revision.id);
  assert.equal(selected.profiles.INU.reviewContext!.selectedOfferRevisionId, s.selectedOfferRevisionId);
  assert.equal(selected.profiles.INU.reviewContext!.decisionStatus, "NEEDS_REVIEW");
  assert.deepEqual(selectOfferRevision(s, s.selectedOfferRevisionId).profiles, s.profiles);
});

it("an unrelated candidate offer revision leaves pinned contexts current", () => {
  const s = reviewed(reviewed(fixture(), "INU"), "SOLAR_BAWAH");
  const vendor = { id: id<"vendor">(), analysisId: s.analysisId, name: "Unrelated candidate" };
  const offer = { id: id<"offer">(), analysisId: s.analysisId, vendorId: vendor.id, label: "Other offer" };
  const added = appendOfferRevision(addOffer(addVendor(s, vendor), offer),
    { id: id<"offer-revision">(), offerId: offer.id, revisionNumber: 1, values: [] });
  assert.deepEqual(added.profiles, s.profiles);
  assert.equal(added.selectedOfferRevisionId, s.selectedOfferRevisionId);
});

it("a referenced mapping version change stales only its reviewed profile and preserves old context", () => {
  const base = fixture();
  const m = mapping(base);
  const s = reviewed(reviewed(replaceMappingVersion(base, m), "INU"), "SOLAR_BAWAH");
  const changed = replaceMappingVersion(s, { ...m, versionId: id<"mapping-version">(), transformExpression: "UNAPPROVED_TEST_TEXT" });
  assert.equal(changed.profiles.INU.reviewContext!.freshness, "STALE");
  assert.deepEqual(changed.profiles.INU.reviewContext!.mappingVersionIds, [m.versionId]);
  assert.deepEqual(changed.profiles.SOLAR_BAWAH, s.profiles.SOLAR_BAWAH);
  assert.deepEqual(deserializeSnapshot(serializeSnapshot(changed)).profiles, changed.profiles);
  assert.equal(reviewed(changed, "INU").profiles.INU.reviewContext!.freshness, "CURRENT");
  const solarMapping = mapping(s, "SOLAR_BAWAH");
  assert.deepEqual(replaceMappingVersion(s, solarMapping).profiles, s.profiles);
});

it("runtime validation rejects invalid review scopes, references and status combinations", () => {
  const s = reviewed(fixture(), "INU");
  const invalid: readonly ((r: Mutable<ReviewContext>) => void)[] = [
    r => { r.profile = "SOLAR_BAWAH"; },
    r => { r.inputCellIds = [s.profiles.SOLAR_BAWAH.hppBase.cellId]; },
    r => { r.inputCellIds = [id<"cell">()]; },
    r => { r.inputCellIds = [s.formulas[0]!.targetCellId]; },
    r => { r.inputCellIds.push(r.inputCellIds[0]!); },
    r => { r.mappingVersionIds = [id<"mapping-version">()]; },
    r => { r.selectedOfferRevisionId = id<"offer-revision">(); },
    r => { r.runId = id<"run">(); },
    r => { r.freshness = "STALE"; },
  ];
  for (const mutate of invalid) {
    const draft = structuredClone(s) as Mutable<WorkbookSnapshot>;
    mutate(draft.profiles.INU.reviewContext!);
    assert.throws(() => captureSnapshot(draft), TypeError);
  }
  assert.throws(() => recordReviewContext(s, "INU", { ...s.profiles.INU.reviewContext!, snapshotId: id<"snapshot">() }), TypeError);
});

it("save normalizes watched changes even without commands, preserving historical review, HPP and retry outcome", () => {
  const repo = new InMemoryRevisionRepository();
  const s = reviewed(reviewed(fixture(), "INU"), "SOLAR_BAWAH");
  const first = save(repo, s);
  const old = serializeSnapshot(first.snapshot);
  const draft = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>;
  draft.worksheets[2]!.tables[0]!.cells[1]!.source = { kind: "INPUT", input: { kind: "TEXT", text: "direct edit" } };
  const mutation = id<"mutation">();
  const second = save(repo, draft, first.revisionId, mutation);
  assert.equal(second.snapshot.profiles.INU.reviewContext!.freshness, "STALE");
  assert.deepEqual(second.snapshot.profiles.SOLAR_BAWAH, first.snapshot.profiles.SOLAR_BAWAH);
  assert.equal(serializeSnapshot(repo.replay(s.analysisId, first.revisionId)), old);
  assert.deepEqual(save(repo, draft, first.revisionId, mutation), second);
  assert.equal(repo.history(s.analysisId).length, 2);
  assert.deepEqual(second.snapshot.worksheets[2]!.tables[0]!.cells[0], first.snapshot.worksheets[2]!.tables[0]!.cells[0]);
});

it("one commit event describes net input, mapping, offer, selection, structure and profile changes", () => {
  const repo = new InMemoryRevisionRepository();
  const s = fixture();
  const first = save(repo, s);
  let next = updateCellInput(first.snapshot, "INU", s.profiles.INU.hppBase.cellId, { kind: "TEXT", text: "discarded draft" });
  next = updateCellInput(next, "INU", s.profiles.INU.hppBase.cellId, { kind: "TEXT", text: "committed HPP" });
  const m = mapping(next);
  next = replaceMappingVersion(next, m);
  const revision = { id: id<"offer-revision">(), offerId: s.analysis.offers[0]!.id, revisionNumber: 2, values: [] };
  next = selectOfferRevision(appendOfferRevision(next, revision), revision.id);
  next = activateProfile(next, "SOLAR_BAWAH");
  const table = next.worksheets[2]!.tables[0]!;
  next = reorderTable(next, table.id, { rows: [...table.rowOrder].reverse(), columns: table.columnOrder });
  const second = save(repo, next);
  const event = repo.head(s.analysisId)!.changeEvent;
  assert.equal(event.targetAnalysisId, s.analysisId);
  assert.equal(event.targetProjectId, s.projectId);
  assert.equal(event.before, first.snapshot);
  assert.equal(event.after, second.snapshot);
  assert.deepEqual(event.changes.find(c => c.action === "INPUT_CHANGED")!.targetIds, [s.profiles.INU.hppBase.cellId]);
  for (const action of ["MAPPING_CHANGED", "OFFER_CHANGED", "SELECTION_CHANGED", "PROFILE_CHANGED", "STRUCTURE_CHANGED"]) {
    assert.ok(event.changes.some(c => c.action === action));
  }
  assert.equal(JSON.stringify(event).includes("discarded draft"), false);
  assert.equal(repo.history(s.analysisId).length, 2);
  assert.equal(Reflect.set(event.changes[0]!.targetIds, "0", "rewrite"), false);
});

it("explicit review after editing can be saved current, while unchanged stale context cannot silently become current", () => {
  const repo = new InMemoryRevisionRepository();
  const first = save(repo, reviewed(fixture(), "INU"));
  const input = first.snapshot.profiles.INU.reviewContext!.inputCellIds[0]!;
  const edited = updateCellInput(first.snapshot, "INU", input, { kind: "TEXT", text: "new input" });
  const stale = save(repo, edited);
  const silentlyCleared = structuredClone(stale.snapshot) as Mutable<WorkbookSnapshot>;
  silentlyCleared.profiles.INU.reviewContext!.freshness = "CURRENT";
  silentlyCleared.profiles.INU.reviewContext!.decisionStatus = "CONFIRMED";
  assert.equal(save(repo, silentlyCleared).snapshot.profiles.INU.reviewContext!.freshness, "STALE");
  const refreshed = save(repo, reviewed(edited, "INU"));
  assert.equal(refreshed.snapshot.profiles.INU.reviewContext!.freshness, "CURRENT");
  assert.equal(refreshed.snapshot.profiles.INU.reviewContext!.snapshotId, refreshed.snapshot.id);
  const editedAgain = updateCellInput(refreshed.snapshot, "INU", input, { kind: "TEXT", text: "review before save" });
  assert.equal(save(repo, reviewed(editedAgain, "INU")).snapshot.profiles.INU.reviewContext!.freshness, "CURRENT");
});

it("formula changes affect their profile; shared policy affects both; run context changes keep manual HPP", () => {
  const repo = new InMemoryRevisionRepository();
  const first = save(repo, reviewed(reviewed(fixture(), "INU"), "SOLAR_BAWAH"));
  const formulaEdit = structuredClone(first.snapshot) as Mutable<WorkbookSnapshot>;
  formulaEdit.formulas[0]!.versionId = id<"formula-version">();
  formulaEdit.formulas[0]!.expression = "CHANGED_TEST_TEXT_NOT_EVALUATED";
  const second = save(repo, formulaEdit);
  assert.equal(second.snapshot.profiles.INU.reviewContext!.freshness, "STALE");
  assert.deepEqual(second.snapshot.profiles.SOLAR_BAWAH, first.snapshot.profiles.SOLAR_BAWAH);
  assert.ok(repo.head(first.snapshot.analysisId)!.changeEvent.changes.some(c => c.action === "FORMULA_CHANGED"));
  const policyEdit = structuredClone(second.snapshot) as Mutable<WorkbookSnapshot>;
  policyEdit.policy = { status: "CONFIGURED", versionId: id<"policy">() };
  const third = save(repo, policyEdit);
  assert.equal(third.snapshot.profiles.SOLAR_BAWAH.reviewContext!.freshness, "STALE");
  const fresh = save(repo, reviewed(reviewed(third.snapshot, "INU"), "SOLAR_BAWAH"));
  const runEdit = structuredClone(fresh.snapshot) as Mutable<WorkbookSnapshot>;
  const run = { id: id<"run">(), snapshotId: fresh.snapshot.id, profile: "INU" as const,
    selectedOfferRevisionId: fresh.snapshot.selectedOfferRevisionId, engineVersion: "TEST_METADATA_NO_ENGINE",
    policyVersionId: policyEdit.policy.versionId, status: "NOT_EVALUATED" as const };
  runEdit.calculationRunRefs.push(run);
  runEdit.profiles.INU.hppBase.contextRunId = run.id;
  const final = save(repo, runEdit);
  assert.equal(final.snapshot.profiles.INU.reviewContext!.freshness, "STALE");
  assert.deepEqual(final.snapshot.profiles.SOLAR_BAWAH, fresh.snapshot.profiles.SOLAR_BAWAH);
  assert.deepEqual(final.snapshot.worksheets, fresh.snapshot.worksheets);
  assert.equal(final.kind, "SAVED_DRAFT");
  assert.equal(final.run, null);
});

it("cancelled input edits produce no net input change in the single Save event", () => {
  const repo = new InMemoryRevisionRepository();
  const first = save(repo, fixture());
  const hpp = first.snapshot.profiles.INU.hppBase.cellId;
  const edited = updateCellInput(first.snapshot, "INU", hpp, { kind: "TEXT", text: "cancelled" });
  save(repo, updateCellInput(edited, "INU", hpp, { kind: "UNSET" }));
  assert.deepEqual(repo.head(first.snapshot.analysisId)!.changeEvent.changes, []);
});
