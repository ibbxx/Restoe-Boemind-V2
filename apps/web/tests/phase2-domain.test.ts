import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activateProfile, addOffer, addVendor, appendOfferRevision, reorderTable, selectOfferRevision, updateCellInput } from "../src/domain/commands.ts";
import { captureSnapshot, createDraft, createPreview, deserializeSnapshot, serializeSnapshot } from "../src/domain/snapshots.ts";
import { parseSnapshot } from "../src/domain/validation.ts";
import { fixture, id } from "./phase2-fixture.ts";
import type { Mutable } from "./phase2-fixture.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";

type Mutation = (s: Mutable<WorkbookSnapshot>) => void;
const invalidCases: readonly [string, Mutation][] = [
  ["unsupported schema", s => Object.assign(s, { schemaVersion: 99 })],
  ["missing field", s => Reflect.deleteProperty(s, "profiles")],
  ["extra field", s => Object.assign(s, { silentDefault: 0 })],
  ["hidden extra field", s => { Object.defineProperty(s, "silentDefault", { value: 0 }); }],
  ["sparse array", s => { Reflect.deleteProperty(s.analysis.vendors, "0"); }],
  ["hidden array field", s => { Object.defineProperty(s.analysis.vendors, "silentDefault", { value: 0 }); }],
  ["invalid ID", s => Object.assign(s, { id: "A1" })],
  ["duplicate entity ID", s => { s.analysis.vendors.push(s.analysis.vendors[0]!); }],
  ["project scope", s => { s.project.id = id<"project">(); }],
  ["vendor scope", s => { s.analysis.vendors[0]!.analysisId = id<"analysis">(); }],
  ["offer project scope", s => { s.analysis.offers[0]!.analysisId = id<"analysis">(); }],
  ["missing vendor", s => { s.analysis.offers[0]!.vendorId = id<"vendor">(); }],
  ["missing offer", s => { s.analysis.offerRevisions[0]!.offerId = id<"offer">(); }],
  ["fractional revision number", s => { s.analysis.offerRevisions[0]!.revisionNumber = 1.5; }],
  ["duplicate revision number", s => {
    s.analysis.offerRevisions.push({ ...s.analysis.offerRevisions[0]!, id: id<"offer-revision">(), values: [] });
  }],
  ["missing selected revision", s => { s.selectedOfferRevisionId = id<"offer-revision">(); }],
  ["unknown profile", s => Object.assign(s, { activeProfile: "SOLAR" })],
  ["policy with a cell ID", s => Object.assign(s, { policy: { status: "CONFIGURED", versionId: s.profiles.INU.hppBase.cellId } })],
  ["duplicate row order", s => { s.worksheets[2]!.tables[0]!.rowOrder.fill(s.worksheets[2]!.tables[0]!.rowOrder[0]!); }],
  ["missing row order member", s => { s.worksheets[2]!.tables[0]!.rowOrder.pop(); }],
  ["missing column", s => { s.worksheets[2]!.tables[0]!.cells[0]!.columnId = id<"column">(); }],
  ["wrong cell table", s => { s.worksheets[2]!.tables[0]!.cells[0]!.tableId = id<"table">(); }],
  ["duplicate cell coordinate", s => {
    const t = s.worksheets[2]!.tables[0]!;
    t.cells[1]!.rowId = t.cells[0]!.rowId;
  }],
  ["missing formula", s => { s.formulas.pop(); }],
  ["wrong formula target", s => { s.formulas[0]!.targetCellId = s.profiles.INU.hppBase.cellId; }],
  ["missing declared reference", s => { s.formulas[0]!.referenceCellIds.push(id<"cell">()); }],
  ["cross-profile declared reference", s => { s.formulas[0]!.referenceCellIds.push(s.profiles.SOLAR_BAWAH.hppBase.cellId); }],
  ["duplicate declared reference", s => { s.formulas[0]!.referenceCellIds.push(s.formulas[0]!.referenceCellIds[0]!); }],
  ["incomplete profile membership", s => { s.profiles.INU.cellIds.pop(); }],
  ["cross-profile HPP", s => { s.profiles.INU.hppBase.cellId = s.profiles.SOLAR_BAWAH.hppBase.cellId; }],
  ["calculated HPP", s => { s.profiles.INU.hppBase.cellId = s.formulas[0]!.targetCellId; }],
  ["auto-bound HPP origin", s => Object.assign(s.profiles.INU.hppBase, { origin: "FORMULA" })],
  ["HPP outside AHS", s => { s.worksheets[2]!.stage = "KONVERSI_JAGAD"; }],
  ["missing HPP run context", s => { s.profiles.INU.hppBase.contextRunId = id<"run">(); }],
  ["non-text raw input", s => Object.assign(s.analysis.offerRevisions[0]!.values[0]!.input, { text: 123 })],
];

describe("snapshot runtime validation", () => {
  for (const [name, mutate] of invalidCases) {
    it("rejects " + name, () => {
      const s = fixture();
      mutate(s);
      assert.throws(() => captureSnapshot(s), TypeError);
    });
  }
  for (const value of [null, undefined, 0, [], "snapshot"]) {
    it("rejects a non-snapshot boundary value " + JSON.stringify(value), () => {
      assert.throws(() => parseSnapshot(value), TypeError);
    });
  }
});

it("snapshots are detached and deeply frozen, including nested raw inputs", () => {
  const draft = fixture();
  const saved = captureSnapshot(draft);
  const serialized = serializeSnapshot(saved);
  draft.analysis.vendors[0]!.name = "Changed later";
  draft.worksheets[2]!.tables[0]!.cells[0]!.source = { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "later" } };
  draft.formulas[0]!.expression = "Later expression";
  assert.equal(serializeSnapshot(saved), serialized);
  assert.throws(() => Object.assign(saved.analysis.vendors[0]!, { name: "Cannot write" }), TypeError);
  assert.equal(Object.isFrozen(saved.formulas[0]!.referenceCellIds), true);
  assert.equal(Reflect.set(saved.analysis.vendors[0]!, "name", "Cannot write"), false);
});

it("serialization is canonical and replay preserves arrays and raw empty/zero values", () => {
  const s = fixture();
  s.analysis.offerRevisions[0]!.values[0]!.input = { kind: "NUMERIC_TEXT", text: "0" };
  const differentlyOrderedKeys = Object.fromEntries(Object.entries(s).reverse());
  const serialized = serializeSnapshot(s);
  assert.equal(serializeSnapshot(differentlyOrderedKeys), serialized);
  const replay = deserializeSnapshot(serialized);
  assert.equal(serializeSnapshot(replay), serialized);
  assert.deepEqual(replay, s);
  assert.throws(() => deserializeSnapshot('{"schemaVersion":2}'), TypeError);
  assert.throws(() => deserializeSnapshot("not JSON"), SyntaxError);
});

it("manual project vendors and offer revisions never replace a selected revision", () => {
  const s = fixture();
  const vendorId = id<"vendor">();
  const offerId = id<"offer">();
  let next = addVendor(s, { id: vendorId, analysisId: s.analysisId, name: "Another manual vendor" });
  next = addOffer(next, { id: offerId, analysisId: s.analysisId, vendorId, label: "Another offer" });
  const newRevision = { id: id<"offer-revision">(), offerId: s.analysis.offers[0]!.id, revisionNumber: 2, values: [] };
  next = appendOfferRevision(next, newRevision);
  assert.equal(next.selectedOfferRevisionId, s.selectedOfferRevisionId);
  assert.deepEqual(next.profiles, s.profiles);
  assert.deepEqual(next.worksheets, s.worksheets);
  assert.equal(selectOfferRevision(next, newRevision.id).selectedOfferRevisionId, newRevision.id);
  assert.equal(selectOfferRevision(next, null).selectedOfferRevisionId, null);
  assert.throws(() => appendOfferRevision(next, { ...newRevision, id: id<"offer-revision">() }), TypeError);
  assert.throws(() => selectOfferRevision(next, id<"offer-revision">()), TypeError);
});

it("profile edits and switches preserve the other profile, shared data and manual HPP", () => {
  const s = fixture();
  const solarBefore = serializeSnapshot(s);
  const inputId = s.worksheets[2]!.tables[0]!.cells[1]!.id;
  const edited = updateCellInput(s, "INU", inputId, { kind: "NUMERIC_TEXT", text: "changed raw input" });
  assert.deepEqual(edited.worksheets[2]!.tables[1], s.worksheets[2]!.tables[1]);
  assert.deepEqual(edited.profiles.SOLAR_BAWAH, s.profiles.SOLAR_BAWAH);
  assert.deepEqual(edited.worksheets[2]!.tables[0]!.cells[0], s.worksheets[2]!.tables[0]!.cells[0]);
  assert.deepEqual(activateProfile(edited, "SOLAR_BAWAH").profiles, edited.profiles);
  assert.deepEqual(activateProfile(activateProfile(edited, "SOLAR_BAWAH"), "INU").worksheets, edited.worksheets);
  assert.equal(serializeSnapshot(s), solarBefore);
  assert.throws(() => updateCellInput(s, "INU", s.profiles.SOLAR_BAWAH.hppBase.cellId, { kind: "UNSET" }), TypeError);
  assert.throws(() => updateCellInput(s, "INU", s.formulas[0]!.targetCellId, { kind: "UNSET" }), TypeError);
  const shared = s.worksheets[0]!.tables[0]!.cells[0]!.id;
  assert.deepEqual(updateCellInput(s, "SHARED", shared, { kind: "NUMERIC_TEXT", text: "new offer input" }).profiles, s.profiles);
  const changedHpp = updateCellInput(s, "INU", s.profiles.INU.hppBase.cellId, { kind: "NUMERIC_TEXT", text: "manual" });
  assert.equal(changedHpp.profiles.INU.hppBase.origin, "MANUAL");
});

it("reordering changes display order without changing identities, selection or declared references", () => {
  const s = fixture();
  const t = s.worksheets[2]!.tables[0]!;
  const reordered = reorderTable(s, t.id, { rows: [...t.rowOrder].reverse(), columns: [...t.columnOrder].reverse() });
  const after = reordered.worksheets[2]!.tables[0]!;
  assert.deepEqual(after.cells, t.cells);
  assert.deepEqual(after.rows, t.rows);
  assert.deepEqual(after.columns, t.columns);
  assert.deepEqual(reordered.formulas, s.formulas);
  assert.equal(reordered.selectedOfferRevisionId, s.selectedOfferRevisionId);
  assert.deepEqual(after.rowOrder, [...t.rowOrder].reverse());
  assert.deepEqual(after.columnOrder, [...t.columnOrder].reverse());
  assert.throws(() => reorderTable(s, t.id, { rows: [], columns: t.columnOrder }), TypeError);
});

it("a local draft has an explicit base revision and is separate from saved state", () => {
  const s = fixture();
  const base = id<"revision">();
  const draft = createDraft(s, base);
  s.project.name = "Edited outside draft";
  assert.equal(draft.kind, "LOCAL_DRAFT");
  assert.equal(draft.baseRevisionId, base);
  assert.notEqual(draft.snapshot.project.name, s.project.name);
  const preview = createPreview(draft.snapshot, base);
  assert.equal(preview.kind, "PREVIEW");
  assert.equal(preview.run, null);
  assert.deepEqual(preview.snapshot, draft.snapshot);
});
