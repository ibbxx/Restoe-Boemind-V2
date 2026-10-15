import { it } from "node:test";
import assert from "node:assert/strict";
import { emptyWorkbook, appendField, pinOfferComponent, reviseFormula, nextOfferRevisionNumber } from "../src/domain/workflow.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { addVendor, addOffer, appendOfferRevision, selectOfferRevision, updateCellInput } from "../src/domain/commands.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";

it("creates empty independent analyses and keeps HPP manual when pinning a negotiated revision", () => {
  let s = emptyWorkbook("Synthetic project", "Analysis A");
  const other = emptyWorkbook(s.project.name, "Analysis B", s.projectId);
  assert.notEqual(s.analysisId, other.analysisId);
  assert.equal(s.selectedOfferRevisionId, null);
  assert.equal(s.policy.status, "UNCONFIGURED");
  assert.throws(() => emptyWorkbook(" ", "A"));
  const vendor = id<"vendor">(), offer = id<"offer">(), revision = id<"offer-revision">(), value = id<"offer-value">();
  s = addVendor(s, { id: vendor, analysisId: s.analysisId, name: "Synthetic A" });
  s = addOffer(s, { id: offer, analysisId: s.analysisId, vendorId: vendor, label: "Offer A" });
  s = appendOfferRevision(s, { id: revision, offerId: offer, revisionNumber: 1, values: [{ id: value, label: "Base", input: { kind: "NUMERIC_TEXT", text: "20000" } }] });
  s = selectOfferRevision(s, revision);
  const added = appendField(s, "KONVERSI_JAGAD", "INU", "S", { kind: "UNSET" });
  s = added.snapshot;
  const before = canonicalJson(s), actor = id<"user">();
  assert.throws(() => pinOfferComponent(s, value, s.profiles.INU.hppBase.cellId, "IDR/L", actor, "test"), /HPP/);
  const pinned = pinOfferComponent(s, value, added.cellId, "IDR/L", actor, "Synthetic mapping");
  assert.equal(canonicalJson(s), before);
  assert.equal(pinned.snapshot.profiles.INU.hppBase.cellId, s.profiles.INU.hppBase.cellId);
  assert.deepEqual(pinned.snapshot.profiles.SOLAR_BAWAH, s.profiles.SOLAR_BAWAH);
  const next = appendOfferRevision(pinned.snapshot, { id: id<"offer-revision">(), offerId: offer, revisionNumber: 2,
    values: [{ id: id<"offer-value">(), label: "Base", input: { kind: "NUMERIC_TEXT", text: "19000" } }] });
  assert.equal(next.selectedOfferRevisionId, revision);
  assert.deepEqual(next.mappings, pinned.snapshot.mappings);
  assert.equal(nextOfferRevisionNumber(offer, [s, next]), 3, "Restore must not reuse a number reserved in saved history.");
  assert.equal(next.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).find(c => c.id === pinned.sourceCellId)?.source.kind, "INPUT");
});

it("propagates synthetic AHS loss/profit using the engine and rejects cross-profile references", () => {
  let s = emptyWorkbook("Synthetic", "A");
  const hpp = s.profiles.INU.hppBase.cellId;
  s = updateCellInput(s, "INU", hpp, { kind: "NUMERIC_TEXT", text: "20000" });
  const sale = appendField(s, "AHS", "INU", "Sale", { kind: "NUMERIC_TEXT", text: "26000" });
  const volume = appendField(sale.snapshot, "AHS", "INU", "Volume", { kind: "NUMERIC_TEXT", text: "100" });
  const profit = appendField(volume.snapshot, "AHS", "INU", "Synthetic profit", { kind: "UNSET" }, `(@{${sale.cellId}}-@{${hpp}})*@{${volume.cellId}}`);
  const policyVersionId = id<"policy">();
  const config = { version: "synthetic-only", policyVersionId, decimal: { scale: 4, rounding: "HALF_UP" as const, roundAt: "EVERY_OPERATION" as const },
    units: [hpp, sale.cellId, volume.cellId, profit.cellId, s.profiles.SOLAR_BAWAH.hppBase.cellId].map(cellId => ({ cellId, symbol: "1", dimensions: {} })),
    aggregates: [], selectionDependentCellIds: [] };
  const engine = new FormulaEngine(config);
  const initial = engine.evaluate(profit.snapshot);
  assert.equal(initial.results.find(r => r.cellId === profit.cellId)?.status, "VALUE");
  assert.equal((initial.results.find(r => r.cellId === profit.cellId) as { value: string }).value, "600000");
  const originalFormula = profit.snapshot.formulas[0]!;
  const revised = reviseFormula(profit.snapshot, originalFormula.id, `(@{${sale.cellId}}-@{${hpp}})*@{${volume.cellId}}-10`);
  assert.notEqual(revised.formulas[0]!.versionId, originalFormula.versionId);
  assert.equal((engine.evaluate(revised).results.find(r => r.cellId === profit.cellId) as { value: string }).value, "599990");
  const changed = updateCellInput(profit.snapshot, "INU", hpp, { kind: "NUMERIC_TEXT", text: "28000" });
  assert.equal((engine.evaluate(changed).results.find(r => r.cellId === profit.cellId) as { value: string }).value, "-200000");
  assert.equal((initial.results.find(r => r.cellId === profit.cellId) as { value: string }).value, "600000");
  assert.throws(() => appendField(changed, "AHS", "SOLAR_BAWAH", "Invalid", { kind: "UNSET" }, `@{${hpp}}`), /profile/);
});
