import type { CellSnapshot, WorkbookSnapshot } from "../domain/contracts.ts";
import { parseStableId } from "../domain/ids.ts";
import { canonicalJson, freeze } from "../domain/snapshots.ts";
import { object, array, requireCondition, text } from "../domain/validation.ts";
import type { EngineConfiguration, Unit } from "./contracts.ts";
import { validateDecimalPolicy } from "./decimal.ts";
import { parseFormula, references } from "./parser.ts";
import type { Ast } from "./parser.ts";

export interface GraphNode {
  readonly cell: CellSnapshot;
  readonly ast: Ast | null;
  readonly dependencies: readonly string[];
  readonly writer: string;
  readonly unit: Unit | null;
  readonly signature: string;
  readonly error: { readonly status: "MISSING" | "INVALID" | "ERROR"; readonly code: string; readonly path: readonly string[] } | null;
}
export interface DependencyGraph {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly order: readonly string[];
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

export function captureConfiguration(value: EngineConfiguration): EngineConfiguration {
  const c = object(value, ["version", "policyVersionId", "decimal", "units", "aggregates", "selectionDependentCellIds"]);
  object(c.decimal, ["scale", "rounding", "roundAt"]);
  validateDecimalPolicy(value.decimal);
  text(c.version, true);
  parseStableId<"policy">(c.policyVersionId);
  const units = array(c.units).map(v => {
    const u = object(v, ["cellId", "symbol", "dimensions"]);
    parseStableId<"cell">(u.cellId);
    text(u.symbol, true);
    requireCondition(u.dimensions && typeof u.dimensions === "object" && !Array.isArray(u.dimensions), "Unit dimensions required.");
    for (const [name, power] of Object.entries(u.dimensions)) requireCondition(/^[A-Za-z][A-Za-z0-9_]*$/.test(name) &&
      Number.isInteger(power) && Math.abs(power as number) <= 16 && power !== 0, "Invalid unit dimension.");
    return u.cellId;
  });
  requireCondition(new Set(units).size === units.length, "Duplicate unit metadata.");
  const aggregateIds: string[] = [];
  for (const v of array(c.aggregates)) {
    const a = object(v, ["id", "versionId", "memberCellIds"]);
    aggregateIds.push(parseStableId<"aggregate">(a.id), parseStableId<"aggregate-version">(a.versionId));
    const members = array(a.memberCellIds).map(id => parseStableId<"cell">(id));
    requireCondition(members.length > 0 && new Set(members).size === members.length, "Aggregate needs explicit, unique members.");
  }
  requireCondition(new Set(aggregateIds).size === aggregateIds.length, "Duplicate aggregate identity/version.");
  const selected = array(c.selectionDependentCellIds).map(id => parseStableId<"cell">(id));
  requireCondition(new Set(selected).size === selected.length, "Duplicate selection dependency.");
  return freeze(JSON.parse(canonicalJson(value)) as EngineConfiguration);
}

export function assertConfigurationVersions(before: EngineConfiguration, after: EngineConfiguration) {
  requireCondition(before.policyVersionId !== after.policyVersionId || canonicalJson(before.decimal) === canonicalJson(after.decimal),
    "Decimal policy changes require a new policy version ID.");
  for (const aggregate of after.aggregates) {
    const prior = before.aggregates.find(a => a.versionId === aggregate.versionId);
    requireCondition(!prior || canonicalJson(prior) === canonicalJson(aggregate), "Aggregate membership changes require a new version ID.");
  }
}

export function compileGraph(snapshot: WorkbookSnapshot, configuration: EngineConfiguration): DependencyGraph {
  const cells = snapshot.worksheets.flatMap(w => w.tables).flatMap(t => t.cells);
  requireCondition(cells.length <= 10000, "Graph node limit.");
  const byCell = new Map(cells.map(c => [c.id as string, c]));
  configuration.units.forEach(u => requireCondition(byCell.has(u.cellId), "Unit target does not exist."));
  configuration.selectionDependentCellIds.forEach(id => requireCondition(byCell.has(id), "Selection dependency does not exist."));
  const aggregates = new Map(configuration.aggregates.map(a => [a.id as string, a]));
  const units = new Map(configuration.units.map(u => [u.cellId, u.dimensions]));
  const nodes = new Map<string, GraphNode>();
  for (const cell of cells) {
    let ast: Ast | null = null;
    let dependencies: readonly string[] = [];
    let error: GraphNode["error"] = null;
    let writer: string = cell.source.kind;
    const formulas = snapshot.formulas.filter(f => f.targetCellId === cell.id && f.activation === "ACTIVE");
    const mappings = snapshot.mappings.filter(m => m.targetCellId === cell.id && m.status === "ACTIVE");
    const formula = formulas[0];
    const mapping = mappings[0];
    const manual = cell.source.kind === "INPUT" ? 1 : 0;
    const activeWriters = manual + formulas.length + mappings.length;
    let usedAggregates: readonly unknown[] = [];
    try {
      if (activeWriters > 1) error = { status: "INVALID", code: "WRITER_CONFLICT", path: [cell.id] };
      else if (!activeWriters) error = { status: "INVALID", code: cell.source.kind === "MAPPING" ? "WAITING_MAPPING" : "INACTIVE_FORMULA", path: [cell.id] };
      else if (mapping && (cell.source.kind !== "MAPPING" || cell.source.mappingId !== mapping.id)) {
        error = { status: "INVALID", code: "WRITER_MISMATCH", path: [cell.id] };
      } else if (formula || mapping) {
        writer = formula ? formula.sourceKind + ":" + formula.versionId : "MAPPING:" + mapping!.versionId;
        const expression = formula?.expression ?? mapping!.transformExpression ?? `@{${mapping!.sourceCellId}}`;
        ast = parseFormula(expression);
        const memberships: unknown[] = [];
        dependencies = [...new Set(references(ast, id => {
          const aggregate = aggregates.get(id);
          if (!aggregate) throw new ReferenceError("MISSING_AGGREGATE:" + id);
          memberships.push(aggregate);
          return aggregate.memberCellIds;
        }))].sort();
        usedAggregates = memberships;
        const missing = dependencies.find(id => !byCell.has(id));
        if (missing) error = { status: "MISSING", code: "MISSING_REFERENCE", path: [cell.id, missing] };
        else if (dependencies.some(id => byCell.get(id)!.scope !== "SHARED" && byCell.get(id)!.scope !== cell.scope)) {
          error = { status: "INVALID", code: "SCOPE_MISMATCH", path: [cell.id, ...dependencies] };
        } else if (formula && canonicalJson(dependencies) !== canonicalJson([...formula.referenceCellIds].sort())) {
          error = { status: "INVALID", code: "DECLARED_REFERENCE_MISMATCH", path: [cell.id] };
        } else if (mapping && (!dependencies.includes(mapping.sourceCellId) || mapping.sourceUnit !== mapping.targetUnit ||
          configuration.units.find(u => u.cellId === mapping.sourceCellId)?.symbol !== mapping.sourceUnit ||
          configuration.units.find(u => u.cellId === mapping.targetCellId)?.symbol !== mapping.targetUnit)) {
          // Unequal labels do not establish an approved conversion, even if a numeric expression exists.
          error = { status: "INVALID", code: "UNAPPROVED_MAPPING_TRANSFORM", path: [cell.id, mapping.sourceCellId] };
        }
      }
    } catch (caught) {
      error = { status: caught instanceof ReferenceError ? "MISSING" : "INVALID",
        code: caught instanceof ReferenceError ? "MISSING_AGGREGATE" : "INVALID_FORMULA", path: [cell.id] };
    }
    const selection = configuration.selectionDependentCellIds.includes(cell.id)
      ? snapshot.analysis.offerRevisions.find(r => r.id === snapshot.selectedOfferRevisionId) ?? null : undefined;
    const unit = units.get(cell.id) ?? null;
    const signature = canonicalJson({ cell: { id: cell.id, scope: cell.scope, source: cell.source }, formulas, mappings,
      unit, unitSymbol: configuration.units.find(u => u.cellId === cell.id)?.symbol ?? null,
      aggregates: usedAggregates, selection: selection ?? null, selectionId: selection === undefined ? null : snapshot.selectedOfferRevisionId });
    nodes.set(cell.id, { cell, ast, dependencies, writer, unit, signature, error });
  }
  const dependents = new Map<string, string[]>();
  nodes.forEach(n => n.dependencies.forEach(id => dependents.set(id, [...(dependents.get(id) ?? []), n.cell.id])));
  const order: string[] = [];
  const color = new Map<string, number>();
  // Iterative DFS avoids call-stack limits for long dependency chains.
  for (const id of nodes.keys()) {
    if (color.has(id)) continue;
    const stack = [{ id, next: 0 }];
    color.set(id, 1);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const dependency = nodes.get(frame.id)!.dependencies[frame.next++];
      if (dependency === undefined) { color.set(frame.id, 2); order.push(frame.id); stack.pop(); continue; }
      if (!nodes.has(dependency)) continue;
      if (!color.has(dependency)) { color.set(dependency, 1); stack.push({ id: dependency, next: 0 }); }
      else if (color.get(dependency) === 1) {
        const cycle = stack.slice(stack.findIndex(f => f.id === dependency)).map(f => f.id);
        for (const member of cycle) {
          const node = nodes.get(member)!;
          nodes.set(member, { ...node, error: { status: "ERROR", code: "CIRCULAR_DEPENDENCY", path: [...cycle, dependency] } });
        }
      }
    }
  }
  // Complete SCCs, including members whose back-edge witness was reached through an already visited branch.
  const assigned = new Set<string>();
  for (const id of [...order].reverse()) {
    if (assigned.has(id)) continue;
    const component: string[] = [];
    const stack = [id];
    while (stack.length) {
      const member = stack.pop()!;
      if (assigned.has(member)) continue;
      assigned.add(member); component.push(member);
      stack.push(...(dependents.get(member) ?? []));
    }
    if (component.length > 1 || nodes.get(id)!.dependencies.includes(id)) {
      const witness = component.map(member => nodes.get(member)!.error).find(error => error?.code === "CIRCULAR_DEPENDENCY");
      for (const member of component) nodes.set(member, { ...nodes.get(member)!,
        error: { status: "ERROR", code: "CIRCULAR_DEPENDENCY", path: witness?.path ?? [id, id] } });
    }
  }
  return { nodes, order, dependents };
}

export function affectedNodes(before: DependencyGraph, after: DependencyGraph): ReadonlySet<string> {
  const affected = new Set<string>();
  for (const id of new Set([...before.nodes.keys(), ...after.nodes.keys()])) {
    const a = before.nodes.get(id), b = after.nodes.get(id);
    if (a?.signature !== b?.signature || canonicalJson(a?.error ?? null) !== canonicalJson(b?.error ?? null)) affected.add(id);
  }
  const queue = [...affected];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const dependent of [...(before.dependents.get(id) ?? []), ...(after.dependents.get(id) ?? [])]) {
      if (!affected.has(dependent)) { affected.add(dependent); queue.push(dependent); }
    }
  }
  return affected;
}

export function relevantNodes(snapshot: WorkbookSnapshot, graph: DependencyGraph): ReadonlySet<string> {
  const relevant = new Set<string>();
  const queue: string[] = [...snapshot.profiles[snapshot.activeProfile].cellIds];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    if (relevant.has(id)) continue;
    relevant.add(id);
    queue.push(...(graph.nodes.get(id)?.dependencies ?? []));
  }
  return relevant;
}
