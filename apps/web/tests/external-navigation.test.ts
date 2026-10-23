import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { EngineRun } from "../src/engine/contracts.ts";

const source = ts.createSourceFile("workspace.tsx", readFileSync(new URL("../src/ui/procurement-workspace.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function definition(name: string) {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(source) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source); assert(found, name);
  return (ts.isVariableDeclaration(found) ? "const " : "") + found.getText(source);
}
type Result = { run: EngineRun | null; error?: string };
const run = (snapshotId: string) => ({ snapshotId }) as EngineRun;
type Draft = { id: string; analysisId: string; activeProfile: "INU" | "SOLAR_BAWAH"; worksheets: { stage: string }[];
  externalAhs?: { sourceFingerprints?: Record<string, string> } };
type Confirmation = { onConfirm: () => void | Promise<void>; onSecondary?: () => void | Promise<void> };
function workspace() {
  const snapshotRef = { current: { id: "draft-1", analysisId: "analysis-1", activeProfile: "SOLAR_BAWAH", worksheets: [] } as Draft };
  const pendingExternal = { current: null as { resume?: (result: Result) => void } | null };
  const state = { view: "INTERNAL", preparing: false, copies: 0, refreshes: 0, saves: 0, edits: 0, errors: [] as string[], confirmation: null as Confirmation | null };
  const context = {
    busy: false, dirty: false, worksheetView: "INTERNAL", snapshotRef, pendingExternal, previewRef: { current: null as EngineRun | null },
    calculationErrorRef: { current: null as { snapshotId: string; error: string } | null },
    savedSnapshotRef: { current: null as Draft | null }, saveActionRef: { current: null as (() => Promise<void>) | null },
    configurationRef: { current: {} }, workspaceEpoch: { current: 1 }, lastActor: { current: "actor-1" },
    calculatedPreview: null as { snapshotId: string; error: string } | null,
    document: { activeElement: null, querySelector: () => null }, HTMLInputElement: class {},
    useCallback: (callback: () => void) => callback,
    PROFILES: ["INU", "SOLAR_BAWAH"],
    startTransition: (callback: () => void) => callback(),
    setPreparingExternal: (value: boolean) => { state.preparing = value; },
    setWorksheetView: (value: string) => { state.view = value; context.worksheetView = value; },
    setBusy: (value: boolean) => { context.busy = value; }, setSaving: () => {},
    setConfirmation: (value: Confirmation) => { state.confirmation = value; }, canonicalJson: JSON.stringify,
    setError: (value: string) => { if (value) state.errors.push(value); },
    setExternalNotice: () => {}, setMessage: () => {},
    internalAhsFingerprint: async () => "a".repeat(64),
    createExternalAhs: (snapshot: Draft, _config: unknown, result: EngineRun, fingerprints: Record<string, string>) => {
      assert.equal(result.snapshotId, snapshot.id);
      state.copies++;
      return { snapshot: { ...snapshot, id: "external-draft", worksheets: [{ stage: "AHS_EXTERNAL" }], externalAhs: { sourceFingerprints: fingerprints } }, configuration: {}, incomplete: 0 };
    },
    refreshExternalAhs: (snapshot: Draft, _config: unknown, result: EngineRun, fingerprint: string) => {
      assert.equal(result.snapshotId, snapshot.id); state.refreshes++;
      return { snapshot: { ...snapshot, id: "refreshed", externalAhs: { sourceFingerprints: { ...snapshot.externalAhs?.sourceFingerprints, [snapshot.activeProfile]: fingerprint } } }, configuration: {}, incomplete: 0 };
    },
    edit: (snapshot: Draft) => { snapshotRef.current = snapshot; context.previewRef.current = run(snapshot.id); context.dirty = true; state.edits++; },
    api: () => { assert.fail("Switching pages must not call the API"); },
    fetch: () => { assert.fail("Switching pages must not fetch"); },
  };
  context.saveActionRef.current = async () => { state.saves++; context.savedSnapshotRef.current = snapshotRef.current; context.dirty = false; };
  const code = ts.transpileModule(["cancelExternalPreparation", "commitWorksheetEdit", "confirmLeaving", "switchWorksheetView"].map(definition).join(";\n") + ";\nswitchWorksheetView", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const switchView = runInNewContext(code, context) as (view: "INTERNAL" | "EXTERNAL") => Promise<void>;
  const deliver = (result: Result) => { assert(pendingExternal.current?.resume); pendingExternal.current.resume(result); };
  const confirmation = () => { assert(state.confirmation); return state.confirmation; };
  return { context, state, switchView, deliver, confirmation };
}

test("first external navigation waits for the latest draft, deduplicates clicks, and reopening preserves the copy", async () => {
  const w = workspace();
  const pending = w.switchView("EXTERNAL");
  const request = w.context.pendingExternal.current;
  assert(w.state.preparing);
  await w.switchView("EXTERNAL");
  assert.strictEqual(w.context.pendingExternal.current, request);
  w.context.snapshotRef.current = { ...w.context.snapshotRef.current, id: "draft-2" };
  w.deliver({ run: run("draft-1") });
  await Promise.resolve();
  assert.equal(w.state.copies, 0);
  w.deliver({ run: run("draft-2") });
  await pending;
  assert.equal(w.state.copies, 1);
  assert.equal(w.state.edits, 1);
  assert.equal(w.state.view, "EXTERNAL");
  assert.equal(w.state.preparing, false);
  await w.switchView("INTERNAL");
  assert(w.confirmation().onSecondary);
  await w.confirmation().onSecondary!();
  w.state.confirmation = null;
  await w.switchView("EXTERNAL");
  assert.equal(w.state.copies, 1);
  assert.deepEqual(w.state.errors, []);
});

test("choosing Internal cancels preparation without changing the draft", async () => {
  const w = workspace();
  const original = w.context.snapshotRef.current;
  const pending = w.switchView("EXTERNAL");
  await w.switchView("INTERNAL");
  await pending;
  assert.strictEqual(w.context.snapshotRef.current, original);
  assert.equal(w.state.copies, 0);
  assert.equal(w.state.view, "INTERNAL");
  assert.equal(w.state.preparing, false);
});

for (const change of ["epoch", "actor", "analysis"] as const) {
  test(`a late calculation cannot create External after changing ${change}`, async () => {
    const w = workspace();
    const pending = w.switchView("EXTERNAL");
    if (change === "epoch") w.context.workspaceEpoch.current++;
    if (change === "actor") w.context.lastActor.current = "actor-2";
    if (change === "analysis") w.context.snapshotRef.current = { ...w.context.snapshotRef.current, analysisId: "analysis-2" };
    w.deliver({ run: run("draft-1") });
    await pending;
    assert.equal(w.state.copies, 0);
    assert.equal(w.state.view, "INTERNAL");
    assert.equal(w.state.preparing, false);
    assert.deepEqual(w.state.errors, []);
  });
}

test("a failed calculation keeps Internal open and allows retry", async () => {
  const w = workspace();
  const pending = w.switchView("EXTERNAL");
  w.deliver({ run: null, error: "Perhitungan gagal" });
  await pending;
  assert.equal(w.state.view, "INTERNAL");
  assert.equal(w.state.preparing, false);
  assert.equal(w.state.copies, 0);
  assert.deepEqual(w.state.errors, ["Perhitungan gagal"]);
  const retry = w.switchView("EXTERNAL");
  w.deliver({ run: run("draft-1") });
  await retry;
  assert.equal(w.state.copies, 1);
  assert.equal(w.state.view, "EXTERNAL");
});

test("changed Internal prompts before replacing External and declining preserves its draft", async () => {
  const w = workspace();
  w.context.previewRef.current = run("draft-1");
  await w.switchView("EXTERNAL");
  await w.switchView("INTERNAL");
  await w.confirmation().onSecondary!();
  w.state.confirmation = null;
  w.context.internalAhsFingerprint = async () => "b".repeat(64);
  await w.switchView("EXTERNAL");
  assert.equal(w.state.view, "INTERNAL");
  assert.equal(w.state.refreshes, 0);
  assert(w.confirmation().onSecondary);
  const unchanged = w.context.snapshotRef.current;
  await w.confirmation().onSecondary!();
  assert.strictEqual(w.context.snapshotRef.current, unchanged);
  assert.equal(w.state.view, "EXTERNAL");
  await w.switchView("INTERNAL");
  await w.confirmation().onSecondary!();
  await w.switchView("EXTERNAL");
  await w.confirmation().onConfirm();
  assert.equal(w.state.refreshes, 1);
  assert.equal(w.context.snapshotRef.current.externalAhs?.sourceFingerprints?.SOLAR_BAWAH, "b".repeat(64));
  assert.equal(w.state.saves, 0);
});

test("returning to Internal saves only on request and a failed Save preserves the external draft", async () => {
  const w = workspace();
  w.context.previewRef.current = run("draft-1");
  await w.switchView("EXTERNAL");
  await w.switchView("INTERNAL");
  assert.equal(w.state.view, "EXTERNAL");
  w.context.saveActionRef.current = async () => { throw new Error("STALE_VERSION"); };
  const draft = w.context.snapshotRef.current;
  await assert.rejects(async () => w.confirmation().onConfirm(), /STALE_VERSION/);
  assert.strictEqual(w.context.snapshotRef.current, draft);
  assert.equal(w.state.view, "EXTERNAL");
  assert.equal(w.context.busy, false);
  w.context.saveActionRef.current = async () => { w.state.saves++; w.context.savedSnapshotRef.current = draft; w.context.dirty = false; };
  await w.confirmation().onConfirm();
  assert.equal(w.state.saves, 1);
  assert.equal(w.state.view, "INTERNAL");
});

test("a calculation error arriving during fingerprinting cannot leave preparation stuck", async () => {
  const w = workspace();
  let finish: (() => void) | undefined;
  w.context.previewRef.current = run("draft-1");
  w.context.internalAhsFingerprint = () => new Promise<string>(resolve => { finish = () => resolve("a".repeat(64)); });
  // One profile is enough to exercise the asynchronous fingerprint boundary.
  w.context.PROFILES = ["SOLAR_BAWAH"];
  const pending = w.switchView("EXTERNAL");
  w.context.snapshotRef.current = { ...w.context.snapshotRef.current, id: "draft-2" };
  w.context.calculationErrorRef.current = { snapshotId: "draft-2", error: "Konfigurasi tidak valid" };
  assert(finish); finish();
  await pending;
  assert.equal(w.state.preparing, false);
  assert.equal(w.state.copies, 0);
  assert.deepEqual(w.state.errors, ["Konfigurasi tidak valid"]);
});
