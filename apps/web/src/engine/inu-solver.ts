import type { WorkbookSnapshot } from "../domain/contracts.ts";
import type { EngineConfiguration, EngineRun, NodeResult } from "./contracts.ts";
import type { DependencyGraph, GraphNode } from "./graph.ts";
import { compileGraph } from "./graph.ts";
import { DecimalArithmetic } from "./decimal.ts";
import { evaluateNode } from "./evaluator.ts";
import { canonicalJson } from "../domain/snapshots.ts";
import type { Ast } from "./parser.ts";

export interface SolverResult {
  readonly status: "SOLVED" | "UNCONFIGURED" | "INCOMPLETE" | "NO_SOLUTION" | "SEARCH_LIMIT";
  readonly cost: string | null;
  readonly profit: string | null;
  readonly evaluated: number;
  readonly method: "MONOTONE" | "ENUMERATION";
}

// Conservative proof: competing increasing branches are unknown, never guessed monotone from samples.
function monotone(node: GraphNode, graph: DependencyGraph, variable: string, visited = new Set<string>()): boolean {
  type Trend = -1 | 0 | 1 | null;
  const combine = (a: Trend, b: Trend): Trend => a === null || b === null ? null : a === 0 ? b : b === 0 || a === b ? a : null;
  const reverse = (a: Trend): Trend => a === null ? null : a === 0 ? 0 : a === 1 ? -1 : 1;
  function cellTrend(id: string, path: Set<string>): Trend {
    if (id === variable) return 1;
    if (path.has(id)) return null;
    const n = graph.nodes.get(id); if (!n || n.error) return null;
    return n.ast ? visit(n.ast, new Set(path).add(id)) : 0;
  }
  function literal(ast: Ast): { numerator: bigint; denominator: bigint } | null {
    if (ast.kind === "number") {
      const [whole, fraction = ""] = ast.text.split(".");
      return { numerator: BigInt((whole || "0") + fraction), denominator: 10n ** BigInt(fraction.length) };
    }
    if (ast.kind === "unary") {
      const value = literal(ast.operand);
      if (!value) return null;
      return { numerator: ast.operator === "-" ? -value.numerator : value.numerator,
        denominator: ast.operator === "%" ? value.denominator * 100n : value.denominator };
    }
    return null;
  }
  function expand(ast: Ast, path = new Set<string>()): Ast {
    if (ast.kind !== "reference" || ast.id === variable || path.has(ast.id)) return ast;
    const expression = graph.nodes.get(ast.id)?.ast;
    return expression ? expand(expression, new Set(path).add(ast.id)) : ast;
  }
  function withoutConstantOffsets(ast: Ast, path: Set<string>): Ast {
    const expanded = expand(ast);
    return expanded.kind === "binary" && (expanded.operator === "+" || expanded.operator === "-") && visit(expanded.right, path) === 0
      ? withoutConstantOffsets(expanded.left, path) : expanded;
  }
  const sameExpression = (a: Ast, b: Ast) => a === b || (a.kind === "reference" && b.kind === "reference" && a.id === b.id);
  function visit(ast: Ast, path: Set<string>): Trend {
    if (ast.kind === "number") return 0;
    if (ast.kind === "reference") return cellTrend(ast.id, path);
    if (ast.kind === "unary") { const v = visit(ast.operand, path); return ast.operator === "-" ? reverse(v) : v; }
    if (ast.kind === "sum") return ast.args.reduce<Trend>((v, a) => combine(v, visit(a, path)), 0);
    if (ast.kind !== "binary") return null;
    const a = visit(ast.left, path), b = visit(ast.right, path);
    if (ast.operator === "+") return combine(a, b);
    if (ast.operator === "-") {
      const deduction = expand(ast.right);
      if (a === 1 && deduction.kind === "binary" && deduction.operator === "*") {
        const rate = literal(deduction.right);
        // x minus a rounded fraction of x stays nondecreasing on the decimal lattice.
        if (rate && rate.numerator >= 0n && rate.numerator <= rate.denominator &&
          sameExpression(withoutConstantOffsets(ast.left, path), expand(deduction.left))) return 1;
      }
      return combine(a, reverse(b));
    }
    if (a === 0 && b === 0) return 0;
    const scale = literal(ast.right);
    if (scale && scale.numerator > 0n) return a;
    return null;
  }
  return cellTrend(node.cell.id, visited) === 1;
}

export function operationalGraph(snapshot: WorkbookSnapshot, configuration: EngineConfiguration, previous?: EngineRun): { graph: DependencyGraph; solver?: SolverResult } {
  const graph = compileGraph(snapshot, configuration), w = snapshot.workbook;
  if (snapshot.activeProfile !== "INU") return { graph };
  const legacyCell = (label: string) => snapshot.worksheets.find(s => s.stage === "KONVERSI_JAGAD")?.tables
    .flatMap(t => t.cells.filter(c => c.scope === "INU" && t.rows.some(r => r.id === c.rowId && r.label === label))).at(0)?.id;
  const costId = w ? w.bindings.find(b => b.profile === "INU" && b.key === "cost")?.cellId : legacyCell("Biaya · Harga Dasar");
  const mueId = w ? w.bindings.find(b => b.profile === "INU" && b.key === "mue")?.cellId : legacyCell("Profit MUE");
  const supplierId = w ? w.bindings.find(b => b.profile === "INU" && b.key === "supplier")?.cellId : legacyCell("Harga INU · Harga Dasar");
  if (!costId || !mueId) return { graph };
  const costNode = graph.nodes.get(costId)!, target = graph.nodes.get(mueId)!;
  const decimal = new DecimalArithmetic(configuration.decimal), aggregates = new Map(configuration.aggregates.map(a => [a.id as string, a.memberCellIds]));
  const ancestors = new Set<string>();
  function collect(id: string) { if (ancestors.has(id)) return; ancestors.add(id); graph.nodes.get(id)?.dependencies.forEach(collect); }
  collect(mueId);
  const order = graph.order.filter(id => ancestors.has(id));
  function withSolverResult(result: SolverResult) {
    const nodes = new Map(graph.nodes);
    nodes.set(costId!, { ...costNode, cell: { ...costNode.cell, source: { kind: "INPUT", input: result.cost === null ? { kind: "UNSET" } : { kind: "NUMERIC_TEXT", text: result.cost } } },
      writer: "INU_SOLVER", ast: null,
      signature: JSON.stringify({ result, settings: w?.solver ?? "AUTOMATIC", ancestors: order.map(id => graph.nodes.get(id)!.signature) }),
      error: result.status === "SOLVED" ? null : { status: "EMPTY", code: "SOLVER_" + result.status, path: [costId!] } });
    return { graph: { ...graph, nodes }, solver: result };
  }
  if (previous?.solver && previous.manifest.snapshot.analysisId === snapshot.analysisId &&
    previous.manifest.snapshot.activeProfile === "INU" &&
    previous.manifest.configuration.policyVersionId === configuration.policyVersionId &&
    canonicalJson(previous.manifest.configuration.decimal) === canonicalJson(configuration.decimal) &&
    JSON.stringify(previous.manifest.snapshot.workbook?.solver) === JSON.stringify(w?.solver) &&
    [...ancestors].every(id => previous.manifest.signatures[id] === graph.nodes.get(id)?.signature)) {
    return withSolverResult(previous.solver);
  }
  const required = new Set<string>();
  function requireSupplier(id: string) {
    if (required.has(id)) return;
    required.add(id);
    const node = graph.nodes.get(id);
    if (!node?.pinnedInput) node?.dependencies.forEach(requireSupplier);
  }
  if (supplierId) requireSupplier(supplierId);
  let evaluated = 0;
  const evaluate = (value: bigint) => {
    evaluated++;
    const results = new Map<string, NodeResult>();
    for (const id of order) {
      const node = graph.nodes.get(id)!;
      results.set(id, id === costId ? { cellId: costId, dependencies: [], writer: "INU_SOLVER", status: value === 0n ? "ZERO" : "VALUE", value: decimal.format(value), unit: costNode.unit ?? {} }
        : evaluateNode(node, results, decimal, aggregates, !required.has(id) && node.unit !== null));
    }
    const result = results.get(mueId); return result && "value" in result ? decimal.parse(result.value) : null;
  };
  const increasing = monotone(target, graph, costId);
  let result: SolverResult = { status: "UNCONFIGURED", cost: null, profit: null, evaluated, method: increasing ? "MONOTONE" : "ENUMERATION" };
  // The active profile selection is the UI's canonical choice. Older dynamic
  // snapshots may only have workbook.selections populated, so keep that as a
  // compatibility fallback instead of making INU appear incomplete.
  const selected = snapshot.selectedOfferRevisionId ?? w?.selections.INU ?? null;
  const lower = decimal.parse("50"), upper = decimal.parse("51");
  let limits = w?.solver ? { minimum: decimal.parse(w.solver.minimum), maximum: decimal.parse(w.solver.maximum), step: decimal.parse(w.solver.step) } : null;
  if (!limits && selected && increasing) {
    const atZero = evaluate(0n);
    if (atZero === null) result = { ...result, status: "INCOMPLETE" };
    else {
      let minimum = atZero < lower ? 0n : -1n, maximum = atZero < lower ? 1n : 0n;
      result = { ...result, status: "SEARCH_LIMIT" };
      // Expand a numeric bracket instead of inventing business minimum/maximum prices.
      for (let attempt = 0; attempt < 512; attempt++) {
        const profit = evaluate(atZero < lower ? maximum : minimum);
        if (profit === null) { result = { ...result, status: "INCOMPLETE" }; break; }
        if (atZero < lower ? profit >= lower : profit < lower) {
          limits = { minimum, maximum, step: 1n }; break;
        }
        if (atZero < lower) maximum *= 2n; else minimum *= 2n;
      }
    }
  }
  if (limits && selected) {
    const { minimum, maximum, step } = limits;
    const count = (maximum - minimum) / step + 1n;
    let best: { cost: bigint; profit: bigint } | null = null;
    let status: SolverResult["status"] = "NO_SOLUTION";
    if (increasing) {
      let lo = 0n, hi = count - 1n;
      while (lo <= hi) {
        const index = (lo + hi) / 2n, cost = minimum + index * step, profit = evaluate(cost);
        if (profit === null) { status = "INCOMPLETE"; break; }
        if (profit >= lower) { if (profit < upper) best = { cost, profit }; hi = index - 1n; } else lo = index + 1n;
      }
    } else if (count > 100000n) status = "SEARCH_LIMIT";
    else {
      for (let index = 0n; index < count; index++) {
        const cost = minimum + index * step, profit = evaluate(cost);
        if (profit === null) { status = "INCOMPLETE"; break; }
        if (profit >= lower && profit < upper && (!best || profit < best.profit)) best = { cost, profit };
        if (best?.profit === lower) break;
      }
    }
    result = { status: best && status !== "INCOMPLETE" ? "SOLVED" : status, cost: best && status !== "INCOMPLETE" ? decimal.format(best.cost) : null,
      profit: best && status !== "INCOMPLETE" ? decimal.format(best.profit) : null, evaluated, method: result.method };
  } else if (!selected) result = { ...result, status: "INCOMPLETE" };
  result = { ...result, evaluated };
  return withSolverResult(result);
}
