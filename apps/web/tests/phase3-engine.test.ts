import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFormula, references } from "../src/engine/parser.ts";
import { DecimalArithmetic } from "../src/engine/decimal.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import type { EngineConfiguration, EngineRun, NodeResult } from "../src/engine/contracts.ts";
import { fixture, id } from "./phase2-fixture.ts";
import type { Mutable } from "./phase2-fixture.ts";
import type { SavedRevision, WorkbookSnapshot } from "../src/domain/contracts.ts";
import { captureSnapshot, canonicalJson, serializeSnapshot, deserializeSnapshot } from "../src/domain/snapshots.ts";
import { updateCellInput, reorderTable } from "../src/domain/commands.ts";
import { invalidateReviewContexts } from "../src/domain/freshness.ts";
import { InMemoryRevisionRepository } from "../src/persistence/in-memory-revision-repository.ts";

function setup(expression = "1 + 2 * 3") {
  const snapshot = fixture();
  for (const cell of snapshot.worksheets.flatMap(w => w.tables).flatMap(t => t.cells)) {
    if (cell.source.kind === "INPUT") cell.source.input = { kind: "NUMERIC_TEXT", text: "2" };
  }
  for (const formula of snapshot.formulas) {
    formula.activation = "ACTIVE";
    formula.expression = expression;
    formula.referenceCellIds = [];
  }
  const configuration: Mutable<EngineConfiguration> = {
    version: "test-configuration-1", policyVersionId: id<"policy">(),
    decimal: { scale: 8, rounding: "HALF_EVEN", roundAt: "EVERY_OPERATION" },
    units: snapshot.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).map(c => ({ cellId: c.id, symbol: "test-unit", dimensions: {} })),
    aggregates: [], selectionDependentCellIds: [],
  };
  snapshot.policy = { status: "CONFIGURED", versionId: configuration.policyVersionId };
  const target = snapshot.formulas[0]!.targetCellId;
  const input = snapshot.worksheets[2]!.tables[0]!.cells[1]!.id;
  const shared = snapshot.worksheets[0]!.tables[0]!.cells[0]!.id;
  return { snapshot, configuration, target, input, shared };
}

function output(run: EngineRun, cellId: string): NodeResult {
  const result = run.results.find(r => r.cellId === cellId);
  assert.ok(result); return result;
}
function value(run: EngineRun, cellId: string): string {
  const result = output(run, cellId);
  assert.ok(result.status === "VALUE" || result.status === "ZERO", JSON.stringify(result));
  return result.value;
}
function code(run: EngineRun, cellId: string) {
  const result = output(run, cellId);
  assert.ok("code" in result, JSON.stringify(result)); return result.code;
}
function saved(repository: InMemoryRevisionRepository, snapshot: WorkbookSnapshot): SavedRevision {
  const outcome = repository.save({ intent: "SAVE_DRAFT", expectedRevisionId: repository.head(snapshot.analysisId)?.revision.revisionId ?? null,
    mutationId: id<"mutation">(), snapshot }, id<"user">());
  assert.equal(outcome.status, "SAVED");
  if (outcome.status !== "SAVED") throw new Error(JSON.stringify(outcome));
  return outcome.revision;
}

describe("restricted parser and explicit decimal arithmetic", () => {
  for (const [expression, expected] of [
    ["1 + 2 * 3", "7"], ["(1+2)*3", "9"], ["8/2/2", "2"], ["7-3-2", "2"],
    ["-2 * -3 + +1", "7"], ["11% * 200", "22"], ["(10+1)%", "0.11"],
    ["SUM(1,2,3*4)", "15"], ["SUM(SUM(1, 2), 3)", "6"], [".1+.2", "0.3"],
    ["2-2", "0"], ["100000000000000000000.1 + .2", "100000000000000000000.3"],
  ]) it(expression!, () => {
    const { snapshot, configuration, target } = setup(expression);
    assert.equal(value(new FormulaEngine(configuration).evaluate(snapshot), target), expected);
  });
  for (const expression of ["", "=1+2", "1e3", "Math.random()", "eval(1)", "SUM()", "SUM(1,)",
    "1;process.exit()", "A1+1", "1**2", "1%%", "1 2", "1+", "SUM(1:2)", "@{not-uuid}", "2(3)", "1==1"]) {
    it("rejects " + expression, () => assert.throws(() => parseFormula(expression), SyntaxError));
  }
  it("enforces length and nesting budgets", () => {
    assert.throws(() => parseFormula("(".repeat(129) + "1" + ")".repeat(129)));
    assert.throws(() => parseFormula("1".repeat(16385)));
  });
  it("resolves only stable IDs, retaining explicit aggregate references", () => {
    const cell = id<"cell">(), aggregate = id<"aggregate">();
    assert.deepEqual(references(parseFormula(`SUM(@{${cell}},#{${aggregate}})`), key => {
      assert.equal(key, aggregate); return [cell];
    }), [cell, cell]);
  });
  for (const [rounding, positive, negative] of [
    ["HALF_EVEN", "1.22", "-1.22"], ["HALF_UP", "1.23", "-1.23"], ["DOWN", "1.22", "-1.22"],
  ] as const) it("rounds ties explicitly using " + rounding, () => {
    const decimal = new DecimalArithmetic({ scale: 2, rounding, roundAt: "EVERY_OPERATION" });
    assert.equal(decimal.format(decimal.parse("1.225")), positive);
    assert.equal(decimal.format(decimal.parse("-1.225")), negative);
    assert.equal(decimal.format(decimal.parse("10.00")), "10");
    assert.equal(decimal.format(decimal.apply("/", decimal.parse("1"), decimal.parse("3"))), "0.33");
  });
  it("rejects unconfigured or invalid numeric policy instead of supplying money defaults", () => {
    const { configuration } = setup();
    assert.throws(() => new FormulaEngine({ ...configuration, decimal: { ...configuration.decimal, scale: -1 } }));
    assert.throws(() => new FormulaEngine({ ...configuration, decimal: undefined } as unknown as EngineConfiguration));
  });
});

describe("resolver, status, unit, scope and writers", () => {
  it("resolves references before dependent evaluation", () => {
    const { snapshot, configuration, target, input } = setup();
    snapshot.formulas[0]!.expression = `@{${input}} * 10%`;
    snapshot.formulas[0]!.referenceCellIds = [input];
    assert.equal(value(new FormulaEngine(configuration).evaluate(snapshot), target), "0.2");
  });
  it("distinguishes EMPTY, ZERO, INVALID numeric input and MISSING references", () => {
    const { snapshot, configuration, target, input } = setup();
    const cell = snapshot.worksheets[2]!.tables[0]!.cells[1]!;
    cell.source = { kind: "INPUT", input: { kind: "UNSET" } };
    const engine = new FormulaEngine(configuration);
    assert.equal(output(engine.evaluate(snapshot), input).status, "EMPTY");
    cell.source = { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "0" } };
    assert.equal(output(engine.evaluate(snapshot), input).status, "ZERO");
    cell.source.input = { kind: "NUMERIC_TEXT", text: "1,000" };
    assert.equal(output(engine.evaluate(snapshot), input).status, "INVALID");
    snapshot.formulas[0]!.expression = `@{${id<"cell">()}}`;
    assert.equal(output(engine.evaluate(snapshot), target).status, "MISSING");
  });
  it("preserves text for direct references but rejects arithmetic on text", () => {
    const { snapshot, configuration, target, input } = setup();
    snapshot.worksheets[2]!.tables[0]!.cells[1]!.source = { kind: "INPUT", input: { kind: "TEXT", text: "Vendor A" } };
    snapshot.formulas[0]!.expression = `@{${input}}`;
    snapshot.formulas[0]!.referenceCellIds = [input];
    const engine = new FormulaEngine(configuration);
    assert.equal(output(engine.evaluate(snapshot), target).status, "TEXT");
    snapshot.formulas[0]!.expression += "+1";
    assert.equal(code(engine.evaluate(snapshot), target), "TYPE_MISMATCH");
    snapshot.formulas[0]!.expression = `SUM(@{${input}})`;
    assert.equal(code(engine.evaluate(snapshot), target), "TYPE_MISMATCH");
  });
  it("propagates division errors and leaves independent branches usable", () => {
    const { snapshot, configuration, target } = setup("1/0");
    const shared = snapshot.worksheets[0]!.tables[0]!.cells[0]!;
    const formula = { ...snapshot.formulas[0]!, id: id<"formula">(), versionId: id<"formula-version">(), targetCellId: shared.id };
    shared.source = { kind: "FORMULA", formulaId: formula.id };
    snapshot.formulas.push(formula);
    snapshot.formulas[0]!.expression = `@{${shared.id}}+2`;
    snapshot.formulas[0]!.referenceCellIds = [shared.id];
    snapshot.formulas[1]!.expression = "3";
    const run = new FormulaEngine(configuration).evaluate(snapshot);
    assert.equal(code(run, shared.id), "DIVISION_BY_ZERO");
    assert.equal(code(run, target), "DEPENDENCY_DIVISION_BY_ZERO");
    assert.equal(value(run, snapshot.formulas[1]!.targetCellId), "3");
  });
  it("detects shared-node cycles and dependency paths", () => {
    const { snapshot, configuration, target, input } = setup();
    snapshot.formulas[0]!.expression = `@{${input}}`;
    snapshot.formulas[0]!.referenceCellIds = [input];
    const extra = { ...snapshot.formulas[0]!, id: id<"formula">(), versionId: id<"formula-version">(), targetCellId: input,
      expression: `@{${target}}`, referenceCellIds: [target] };
    snapshot.worksheets[2]!.tables[0]!.cells[1]!.source = { kind: "FORMULA", formulaId: extra.id };
    snapshot.formulas.push(extra); snapshot.profiles.INU.formulaIds.push(extra.id);
    const run = new FormulaEngine(configuration).evaluate(snapshot);
    assert.equal(code(run, target), "CIRCULAR_DEPENDENCY");
    assert.equal(code(run, input), "CIRCULAR_DEPENDENCY");
    assert.ok("path" in output(run, input));
  });
  it("detects a self cycle", () => {
    const { snapshot, configuration, target } = setup();
    snapshot.formulas[0]!.expression = `@{${target}}`;
    snapshot.formulas[0]!.referenceCellIds = [target];
    assert.equal(code(new FormulaEngine(configuration).evaluate(snapshot), target), "CIRCULAR_DEPENDENCY");
  });
  it("marks every member of an intertwined SCC, including a branch reached after another branch finished", () => {
    const { snapshot, configuration } = setup();
    const table = snapshot.worksheets[0]!.tables[0]!;
    const nodeIds = Array.from({ length: 4 }, () => id<"cell">());
    const edges = [[1, 3], [2], [0], [1]];
    for (const [index, cellId] of nodeIds.entries()) {
      const rowId = id<"row">(), formulaId = id<"formula">();
      table.rows.push({ id: rowId, label: "test SCC" }); table.rowOrder.push(rowId);
      table.cells.push({ id: cellId, tableId: table.id, rowId, columnId: table.columns[0]!.id, scope: "SHARED",
        source: { kind: "FORMULA", formulaId } });
      const references = edges[index]!.map(n => nodeIds[n]!);
      snapshot.formulas.push({ id: formulaId, versionId: id<"formula-version">(), targetCellId: cellId,
        expression: references.map(id => `@{${id}}`).join("+"), referenceCellIds: references,
        sourceKind: "OPERATIONAL_OVERRIDE", activation: "ACTIVE", provenance: null });
      configuration.units.push({ cellId, symbol: "test-unit", dimensions: {} });
    }
    const run = new FormulaEngine(configuration).evaluate(snapshot);
    nodeIds.forEach(cellId => assert.equal(code(run, cellId), "CIRCULAR_DEPENDENCY"));
  });
  it("rejects undeclared/cross-profile references and missing aggregates", () => {
    const { snapshot, configuration, target, input } = setup();
    const engine = new FormulaEngine(configuration);
    snapshot.formulas[0]!.expression = `@{${input}}`;
    assert.equal(code(engine.evaluate(snapshot), target), "DECLARED_REFERENCE_MISMATCH");
    snapshot.formulas[0]!.expression = `@{${snapshot.profiles.SOLAR_BAWAH.hppBase.cellId}}`;
    assert.equal(code(engine.evaluate(snapshot), target), "SCOPE_MISMATCH");
    snapshot.formulas[0]!.expression = `SUM(#{${id<"aggregate">()}})`;
    assert.equal(code(engine.evaluate(snapshot), target), "MISSING_AGGREGATE");
  });
  it("checks dimensional algebra without converting physical units", () => {
    const { snapshot, configuration, target, input, shared } = setup();
    snapshot.formulas[0]!.expression = `@{${input}} * @{${shared}}`;
    snapshot.formulas[0]!.referenceCellIds = [input, shared];
    configuration.units.find(u => u.cellId === input)!.dimensions = { IDR: 1, litre: -1 };
    configuration.units.find(u => u.cellId === shared)!.dimensions = { litre: 1 };
    configuration.units.find(u => u.cellId === target)!.dimensions = { IDR: 1 };
    assert.equal(value(new FormulaEngine(configuration).evaluate(snapshot), target), "4");
    snapshot.formulas[0]!.expression = `@{${input}} + @{${shared}}`;
    assert.equal(code(new FormulaEngine(configuration).evaluate(snapshot), target), "UNIT_MISMATCH");
    configuration.units = configuration.units.filter(u => u.cellId !== input);
    assert.equal(code(new FormulaEngine(configuration).evaluate(snapshot), input), "UNCONFIGURED_UNIT");
  });
});

describe("mapping, aggregate membership and incremental recalculation", () => {
  it("evaluates an explicitly selected mapping writer and preserves its version on roundtrip", () => {
    const { snapshot, configuration, input, shared } = setup();
    const mapping = { id: id<"mapping">(), versionId: id<"mapping-version">(), analysisId: snapshot.analysisId,
      scope: "INU" as const, sourceCellId: shared, targetCellId: input, sourceComponent: "test identity",
      transformExpression: null, sourceUnit: "test-unit", targetUnit: "test-unit", status: "ACTIVE" as const,
      provenance: { actorId: id<"user">(), changeEventId: id<"change-event">(), sourceRef: null, reason: "test" } };
    snapshot.mappings.push(mapping);
    const engine = new FormulaEngine(configuration);
    assert.equal(code(engine.evaluate(snapshot), input), "WRITER_CONFLICT");
    snapshot.worksheets[2]!.tables[0]!.cells[1]!.source = { kind: "MAPPING", mappingId: mapping.id };
    const original = captureSnapshot(snapshot);
    const originalMappingVersion = mapping.versionId;
    assert.equal(value(engine.evaluate(deserializeSnapshot(serializeSnapshot(original))), input), "2");
    snapshot.mappings[0]!.versionId = id<"mapping-version">();
    snapshot.mappings[0]!.targetUnit = "other-unit";
    assert.equal(code(engine.evaluate(snapshot), input), "UNAPPROVED_MAPPING_TRANSFORM");
    assert.equal(original.mappings[0]!.versionId, originalMappingVersion);
  });
  it("reorder and unrelated inputs do not change aggregate membership; membership edits recalculate", () => {
    const { snapshot, configuration, target, input, shared } = setup();
    const aggregate = { id: id<"aggregate">(), versionId: id<"aggregate-version">(), memberCellIds: [input, shared] };
    configuration.aggregates.push(aggregate);
    snapshot.formulas[0]!.expression = `SUM(#{${aggregate.id}})`;
    snapshot.formulas[0]!.referenceCellIds = [input, shared];
    const engine = new FormulaEngine(configuration);
    const initial = engine.evaluate(snapshot);
    assert.equal(value(initial, target), "4");
    const table = snapshot.worksheets[2]!.tables[0]!;
    const reordered = reorderTable(snapshot, table.id, { rows: [...table.rowOrder].reverse(), columns: table.columnOrder });
    const run = engine.recalculate(reordered, initial);
    assert.deepEqual(run.results, initial.results);
    assert.deepEqual(run.evaluatedCellIds, []);
    aggregate.memberCellIds = [shared]; aggregate.versionId = id<"aggregate-version">();
    snapshot.formulas[0]!.referenceCellIds = [shared];
    const changed = new FormulaEngine(configuration).evaluate(snapshot);
    assert.equal(value(changed, target), "2");
    assert.equal(value(initial, target), "4");
    assert.equal(engine.assessFreshness(initial, reordered).freshness, "CURRENT");
    assert.equal(new FormulaEngine(configuration).assessFreshness(initial, snapshot).freshness, "STALE");
  });
  it("full and incremental results/statuses match for input/error transitions without touching Solar", () => {
    const { snapshot, configuration, target, input } = setup();
    snapshot.formulas[0]!.expression = `10/@{${input}}`;
    snapshot.formulas[0]!.referenceCellIds = [input];
    const engine = new FormulaEngine(configuration);
    let state: WorkbookSnapshot = snapshot;
    let prior = engine.evaluate(state);
    for (const inputValue of ["5", "0", "bad", "-2", "0.00000001", "4"]) {
      state = updateCellInput(state, "INU", input, { kind: "NUMERIC_TEXT", text: inputValue });
      const incremental = engine.recalculate(state, prior), full = engine.evaluate(state);
      assert.deepEqual(incremental.results, full.results);
      assert.equal(incremental.status, full.status);
      assert.deepEqual(incremental.diagnostics, full.diagnostics);
      assert.deepEqual(new Set(incremental.evaluatedCellIds), new Set([input, target]));
      assert.equal(incremental.results.find(r => r.cellId === snapshot.profiles.SOLAR_BAWAH.hppBase.cellId),
        prior.results.find(r => r.cellId === snapshot.profiles.SOLAR_BAWAH.hppBase.cellId));
      prior = incremental;
    }
  });
  it("rejects duplicate, empty or missing aggregate memberships without silently summing zero", () => {
    const { configuration, input } = setup();
    configuration.aggregates = [{ id: id<"aggregate">(), versionId: id<"aggregate-version">(), memberCellIds: [input, input] }];
    assert.throws(() => new FormulaEngine(configuration));
    configuration.aggregates[0]!.memberCellIds = [];
    assert.throws(() => new FormulaEngine(configuration));
  });
  it("incrementally applies a new aggregate version and retains unrelated result objects", () => {
    const { snapshot, configuration, target, input, shared } = setup();
    const aggregate = { id: id<"aggregate">(), versionId: id<"aggregate-version">(), memberCellIds: [input, shared] };
    configuration.aggregates.push(aggregate);
    snapshot.formulas[0]!.expression = `SUM(#{${aggregate.id}})`;
    snapshot.formulas[0]!.referenceCellIds = [input, shared];
    const prior = new FormulaEngine(configuration).evaluate(snapshot);
    const changed = structuredClone(snapshot);
    changed.id = id<"snapshot">();
    changed.formulas[0]!.versionId = id<"formula-version">();
    changed.formulas[0]!.referenceCellIds = [shared];
    configuration.aggregates[0]!.memberCellIds = [shared];
    configuration.aggregates[0]!.versionId = id<"aggregate-version">();
    configuration.version = "test-configuration-2";
    const engine = new FormulaEngine(configuration), incremental = engine.recalculate(changed, prior);
    assert.deepEqual(incremental.results, engine.evaluate(changed).results);
    assert.deepEqual(incremental.evaluatedCellIds, [target]);
    assert.equal(value(incremental, target), "2");
    assert.equal(prior.manifest.configuration.aggregates[0]!.memberCellIds.length, 2);
  });
  it("missing aggregate members stay MISSING and cannot be coerced to zero", () => {
    const { snapshot, configuration, target } = setup();
    const aggregate = { id: id<"aggregate">(), versionId: id<"aggregate-version">(), memberCellIds: [id<"cell">()] };
    configuration.aggregates.push(aggregate);
    snapshot.formulas[0]!.expression = `SUM(#{${aggregate.id}})`;
    assert.equal(output(new FormulaEngine(configuration).evaluate(snapshot), target).status, "MISSING");
  });
  it("EMPTY propagates through SUM and retains a distinct code from explicit zero", () => {
    const { snapshot, configuration, target, input } = setup();
    snapshot.formulas[0]!.expression = `SUM(@{${input}}, 1)`;
    snapshot.formulas[0]!.referenceCellIds = [input];
    snapshot.worksheets[2]!.tables[0]!.cells[1]!.source = { kind: "INPUT", input: { kind: "UNSET" } };
    const engine = new FormulaEngine(configuration), prior = engine.evaluate(snapshot);
    assert.equal(output(prior, target).status, "EMPTY");
    const zero = updateCellInput(snapshot, "INU", input, { kind: "NUMERIC_TEXT", text: "0" });
    assert.equal(value(engine.recalculate(zero, prior), target), "1");
    assert.deepEqual(engine.recalculate(zero, prior).results, engine.evaluate(zero).results);
  });
  it("changes numeric policy explicitly and falls back to a full recalculation", () => {
    const { snapshot, configuration, target } = setup("1/3");
    const prior = new FormulaEngine(configuration).evaluate(snapshot);
    configuration.decimal.scale = 2;
    configuration.policyVersionId = id<"policy">();
    snapshot.policy = { status: "CONFIGURED", versionId: configuration.policyVersionId };
    const engine = new FormulaEngine(configuration), incremental = engine.recalculate(snapshot, prior);
    assert.equal(value(incremental, target), "0.33");
    assert.equal(incremental.evaluatedCellIds.length, configuration.units.length);
    assert.deepEqual(incremental.results, engine.evaluate(snapshot).results);
    assert.equal(engine.assessFreshness(prior, snapshot).freshness, "STALE");
  });
  it("refuses to reuse policy or aggregate version IDs for changed payloads", () => {
    const { snapshot, configuration, input } = setup();
    configuration.aggregates.push({ id: id<"aggregate">(), versionId: id<"aggregate-version">(), memberCellIds: [input] });
    const run = new FormulaEngine(configuration).evaluate(snapshot);
    const policyEdit = structuredClone(configuration);
    policyEdit.decimal.scale = 2;
    assert.throws(() => new FormulaEngine(policyEdit).recalculate(snapshot, run), /new policy version/);
    const membershipEdit = structuredClone(configuration);
    membershipEdit.aggregates[0]!.memberCellIds = [snapshot.profiles.INU.hppBase.cellId];
    assert.throws(() => new FormulaEngine(membershipEdit).recalculate(snapshot, run), /new version ID/);
  });
  it("mapping version changes invalidate only the explicit target and descendants", () => {
    const { snapshot, configuration, input, shared, target } = setup();
    const mapping = { id: id<"mapping">(), versionId: id<"mapping-version">(), analysisId: snapshot.analysisId, scope: "INU" as const,
      sourceCellId: shared, targetCellId: input, sourceComponent: "test", transformExpression: null, sourceUnit: "test-unit", targetUnit: "test-unit",
      status: "ACTIVE" as const, provenance: { actorId: id<"user">(), changeEventId: id<"change-event">(), sourceRef: null, reason: null } };
    snapshot.mappings.push(mapping);
    snapshot.worksheets[2]!.tables[0]!.cells[1]!.source = { kind: "MAPPING", mappingId: mapping.id };
    snapshot.formulas[0]!.expression = `@{${input}}*2`; snapshot.formulas[0]!.referenceCellIds = [input];
    const engine = new FormulaEngine(configuration), prior = engine.evaluate(snapshot);
    const edited = structuredClone(snapshot);
    edited.mappings[0]!.versionId = id<"mapping-version">();
    edited.mappings[0]!.transformExpression = `@{${shared}}*3`;
    const incremental = engine.recalculate(edited, prior);
    assert.deepEqual(incremental.results, engine.evaluate(edited).results);
    assert.deepEqual(new Set(incremental.evaluatedCellIds), new Set([input, target]));
    assert.equal(value(incremental, target), "12");
    assert.deepEqual(new Set(engine.assessFreshness(prior, edited).staleCellIds), new Set([input, target]));
  });
});

describe("run manifest, freshness and history guards", () => {
  it("binds runs to exact immutable revision and rejects a late run without replacing latest", () => {
    const { snapshot, configuration, input } = setup();
    const repository = new InMemoryRevisionRepository();
    const first = saved(repository, snapshot);
    const engine = new FormulaEngine(configuration);
    const run1 = engine.evaluateRevision(first);
    assert.equal(run1.manifest.revisionId, first.revisionId);
    assert.equal(run1.snapshotId, first.snapshot.id);
    assert.deepEqual(run1.manifest.snapshot.formulas, first.snapshot.formulas);
    assert.ok(Object.isFrozen(run1.manifest.configuration));
    assert.equal(engine.publish(run1, first), "PUBLISHED_PREVIEW");
    const second = saved(repository, updateCellInput(first.snapshot, "INU", input, { kind: "NUMERIC_TEXT", text: "9" }));
    const run2 = engine.evaluateRevision(second, run1);
    assert.equal(engine.publish(run2, second), "PUBLISHED_PREVIEW");
    assert.equal(engine.publish(run1, second), "STALE_RUN");
    assert.equal(engine.latest(snapshot.analysisId, "INU"), run2);
    assert.equal(engine.getRun(run1.id), run1);
    assert.deepEqual(engine.runHistory(snapshot.analysisId), [run1, run2]);
    assert.ok(Object.isFrozen(engine.runHistory(snapshot.analysisId)));
    assert.equal(engine.publish({ ...run2 }, second), "STALE_RUN");
    assert.equal(canonicalJson(first.snapshot), canonicalJson(run1.manifest.snapshot));
  });
  it("keeps previews nonfinal and refuses confirmation without approved business policy", () => {
    const { snapshot, configuration } = setup();
    const engine = new FormulaEngine(configuration);
    assert.equal(engine.evaluate(snapshot).status, "NONFINAL");
    snapshot.policy = { status: "UNCONFIGURED" };
    assert.ok(engine.evaluate(snapshot).diagnostics.includes("POLICY_UNCONFIGURED_OR_MISMATCH"));
    const repository = new InMemoryRevisionRepository();
    const rejected = repository.save({ intent: "CONFIRM_RESULT", snapshot, mutationId: id<"mutation">(), expectedRevisionId: null }, id<"user">());
    assert.equal(rejected.status, "REJECTED");
  });
  it("invalidates transitively through a shared formula while preserving manual HPP and independent profiles", () => {
    const { snapshot, configuration, target, shared } = setup();
    const upstream = snapshot.worksheets[0]!.tables[0]!.cells[0]!;
    const extra = { ...snapshot.formulas[0]!, id: id<"formula">(), versionId: id<"formula-version">(), targetCellId: shared,
      expression: "2", referenceCellIds: [] };
    upstream.source = { kind: "FORMULA", formulaId: extra.id };
    snapshot.formulas.push(extra);
    snapshot.formulas[0]!.expression = `@{${shared}}*2`;
    snapshot.formulas[0]!.referenceCellIds = [shared];
    snapshot.profiles.INU.reviewContext = { snapshotId: snapshot.id, profile: "INU", selectedOfferRevisionId: snapshot.selectedOfferRevisionId,
      mappingVersionIds: [], inputCellIds: [], runId: null, freshness: "CURRENT", decisionStatus: "CONFIRMED" };
    const engine = new FormulaEngine(configuration), initial = engine.evaluate(snapshot);
    const changed = structuredClone(snapshot);
    changed.id = id<"snapshot">();
    changed.formulas[2]!.expression = "3"; changed.formulas[2]!.versionId = id<"formula-version">();
    const stale = invalidateReviewContexts(snapshot, changed);
    assert.equal(stale.profiles.INU.reviewContext!.freshness, "STALE");
    assert.deepEqual(stale.profiles.INU.hppBase, snapshot.profiles.INU.hppBase);
    const assessment = engine.assessFreshness(initial, changed);
    assert.deepEqual(new Set(assessment.staleCellIds), new Set([shared, target]));
    const incremental = engine.recalculate(changed, initial);
    assert.deepEqual(incremental.results, engine.evaluate(changed).results);
    assert.equal(value(incremental, target), "6");
  });
  it("tracks explicitly selected-offer dependencies, never a newer unselected revision", () => {
    const { snapshot, configuration, target } = setup();
    configuration.selectionDependentCellIds = [target];
    const engine = new FormulaEngine(configuration), initial = engine.evaluate(snapshot);
    const later = structuredClone(snapshot);
    later.analysis.offerRevisions.push({ ...later.analysis.offerRevisions[0]!, id: id<"offer-revision">(), revisionNumber: 2,
      values: later.analysis.offerRevisions[0]!.values.map(v => ({ ...v, id: id<"offer-value">() })) });
    assert.equal(engine.assessFreshness(initial, later).freshness, "CURRENT");
    later.selectedOfferRevisionId = later.analysis.offerRevisions[1]!.id;
    assert.equal(engine.assessFreshness(initial, later).freshness, "STALE");
    assert.equal(snapshot.selectedOfferRevisionId, initial.manifest.snapshot.selectedOfferRevisionId);
  });
  it("records graph-derived review inputs and persists stale review without modifying historical run or HPP", () => {
    const { snapshot, configuration, target, input } = setup();
    snapshot.formulas[0]!.expression = `@{${input}}*2`;
    snapshot.formulas[0]!.referenceCellIds = [input];
    const repository = new InMemoryRevisionRepository(), first = saved(repository, snapshot);
    const engine = new FormulaEngine(configuration), run = engine.evaluateRevision(first);
    const reviewed = engine.reviewRun(first.snapshot, run);
    assert.ok(reviewed.profiles.INU.reviewContext!.inputCellIds.includes(input));
    assert.equal(reviewed.profiles.INU.reviewContext!.runId, run.id);
    const second = saved(repository, reviewed);
    const changed = updateCellInput(second.snapshot, "INU", input, { kind: "NUMERIC_TEXT", text: "3" });
    const stale = engine.refreshReviewContexts(second.snapshot, changed, run);
    assert.equal(stale.profiles.INU.reviewContext!.decisionStatus, "NEEDS_REVIEW");
    assert.deepEqual(stale.profiles.INU.hppBase, first.snapshot.profiles.INU.hppBase);
    assert.equal(value(run, target), "4");
    assert.equal(saved(repository, stale).snapshot.profiles.INU.reviewContext!.freshness, "STALE");
  });
  it("keeps unrelated shared and INU changes out of Solar run freshness", () => {
    const { snapshot, configuration, input, shared } = setup();
    snapshot.activeProfile = "SOLAR_BAWAH";
    const engine = new FormulaEngine(configuration), run = engine.evaluate(snapshot);
    const changed = updateCellInput(snapshot, "INU", input, { kind: "NUMERIC_TEXT", text: "3" });
    assert.equal(engine.assessFreshness(run, changed).freshness, "CURRENT");
    const sharedChanged = updateCellInput(changed, "SHARED", shared, { kind: "NUMERIC_TEXT", text: "4" });
    assert.equal(engine.assessFreshness(run, sharedChanged).freshness, "CURRENT");
  });
  it("reproduces a historical run from its serialized manifest and original numeric policy", () => {
    const { snapshot, configuration, target } = setup("1/3");
    const repository = new InMemoryRevisionRepository(), revision = saved(repository, snapshot);
    const run = new FormulaEngine(configuration).evaluateRevision(revision);
    const historical = JSON.parse(JSON.stringify(run)) as EngineRun;
    configuration.decimal.scale = 2;
    const replayed = new FormulaEngine(historical.manifest.configuration).evaluateRevision({ ...revision,
      snapshot: historical.manifest.snapshot });
    assert.equal(value(replayed, target), "0.33333333");
    assert.deepEqual(replayed.results, run.results);
    assert.equal(replayed.manifest.revisionId, revision.revisionId);
  });
  it("a formula edit can create and then resolve a cycle with full/incremental parity", () => {
    const { snapshot, configuration, target } = setup();
    const engine = new FormulaEngine(configuration), initial = engine.evaluate(snapshot);
    const cycled = structuredClone(snapshot);
    cycled.formulas[0]!.expression = `@{${target}}`;
    cycled.formulas[0]!.referenceCellIds = [target];
    cycled.formulas[0]!.versionId = id<"formula-version">();
    const run = engine.recalculate(cycled, initial);
    assert.equal(code(run, target), "CIRCULAR_DEPENDENCY");
    assert.deepEqual(run.results, engine.evaluate(cycled).results);
    assert.deepEqual(engine.recalculate(snapshot, run).results, initial.results);
  });
});
