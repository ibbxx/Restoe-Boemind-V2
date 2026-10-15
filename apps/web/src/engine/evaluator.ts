import type { NodeResult, Unit } from "./contracts.ts";
import { canonicalJson } from "../domain/snapshots.ts";
import { DecimalArithmetic } from "./decimal.ts";
import type { Ast } from "./parser.ts";
import type { GraphNode } from "./graph.ts";

type Value =
  | { readonly kind: "number"; readonly number: bigint; readonly unit: Unit }
  | { readonly kind: "text"; readonly text: string };

class EvaluationFailure extends Error {
  readonly status: "EMPTY" | "MISSING" | "INVALID" | "ERROR";
  readonly path: readonly string[];
  constructor(status: EvaluationFailure["status"], code: string, path: readonly string[] = []) {
    super(code); this.status = status; this.path = path;
  }
}

export function sameUnit(a: Unit, b: Unit): boolean { return canonicalJson(a) === canonicalJson(b); }

function productUnit(a: Unit, b: Unit, divide: boolean): Unit {
  const result: Record<string, number> = Object.assign(Object.create(null), a);
  for (const [key, power] of Object.entries(b)) {
    result[key] = (result[key] ?? 0) + (divide ? -power : power);
    if (!result[key]) delete result[key];
    else if (Math.abs(result[key]!) > 16) throw new EvaluationFailure("INVALID", "UNIT_LIMIT");
  }
  return result;
}

export function evaluateNode(node: GraphNode, results: ReadonlyMap<string, NodeResult>, decimal: DecimalArithmetic,
  aggregates: ReadonlyMap<string, readonly string[]>): NodeResult {
  const base = { cellId: node.cell.id, writer: node.writer, dependencies: node.dependencies };
  if (node.error) return { ...base, ...node.error };
  function reference(id: string): Value {
    const result = results.get(id);
    if (!result) throw new EvaluationFailure("MISSING", "MISSING_REFERENCE", [id]);
    if (result.status === "TEXT") return { kind: "text", text: result.text };
    if (result.status === "VALUE" || result.status === "ZERO") return { kind: "number", number: decimal.parse(result.value), unit: result.unit };
    if ("code" in result) throw new EvaluationFailure(result.status === "EMPTY" || result.status === "MISSING" ? result.status : "ERROR",
      "DEPENDENCY_" + result.code, result.path);
    throw new EvaluationFailure("ERROR", "UNKNOWN_DEPENDENCY_STATUS", [id]);
  }
  function number(value: Value): Extract<Value, { kind: "number" }> {
    if (value.kind !== "number") throw new EvaluationFailure("INVALID", "TYPE_MISMATCH");
    return value;
  }
  function apply(operator: "+" | "-" | "*" | "/", left: Value, right: Value): Value {
    const a = number(left), b = number(right);
    if ((operator === "+" || operator === "-") && !sameUnit(a.unit, b.unit)) throw new EvaluationFailure("INVALID", "UNIT_MISMATCH");
    return { kind: "number", number: decimal.apply(operator, a.number, b.number),
      unit: operator === "*" || operator === "/" ? productUnit(a.unit, b.unit, operator === "/") : a.unit };
  }
  function sum(values: readonly Value[]): Value {
    const first = values[0];
    if (!first) throw new EvaluationFailure("INVALID", "EMPTY_AGGREGATE");
    number(first);
    return values.slice(1).reduce((acc, v) => apply("+", acc, v), first);
  }
  function visit(ast: Ast): Value {
    switch (ast.kind) {
      case "number": return { kind: "number", number: decimal.parse(ast.text), unit: {} };
      case "reference": return reference(ast.id);
      case "aggregate": return sum((aggregates.get(ast.id) ?? []).map(reference));
      case "sum": return sum(ast.args.map(visit));
      case "binary": return apply(ast.operator, visit(ast.left), visit(ast.right));
      case "unary": {
        const operand = number(visit(ast.operand));
        if (ast.operator === "%" && !sameUnit(operand.unit, {})) throw new EvaluationFailure("INVALID", "UNIT_MISMATCH");
        return { ...operand, number: ast.operator === "%" ? decimal.divide(operand.number, 100n)
          : ast.operator === "-" ? -operand.number : operand.number };
      }
    }
  }
  try {
    let value: Value;
    const source = node.cell.source;
    if (source.kind === "INPUT") {
      if (source.input.kind === "UNSET") throw new EvaluationFailure("EMPTY", "EMPTY_INPUT");
      if (source.input.kind === "TEXT") value = { kind: "text", text: source.input.text };
      else value = { kind: "number", number: decimal.parse(source.input.text), unit: node.unit ?? {} };
    } else {
      if (!node.ast) throw new EvaluationFailure("INVALID", "MISSING_EXPRESSION");
      value = visit(node.ast);
    }
    if (value.kind === "text") return { ...base, status: "TEXT", text: value.text };
    if (node.unit === null) throw new EvaluationFailure("INVALID", "UNCONFIGURED_UNIT");
    if (!sameUnit(node.unit, value.unit)) throw new EvaluationFailure("INVALID", "UNIT_MISMATCH");
    return { ...base, status: value.number === 0n ? "ZERO" : "VALUE", value: decimal.format(value.number), unit: value.unit };
  } catch (error) {
    if (error instanceof EvaluationFailure) return { ...base, status: error.status, code: error.message, path: [node.cell.id, ...error.path] };
    if (error instanceof RangeError || error instanceof TypeError) return { ...base,
      status: error instanceof TypeError ? "INVALID" : "ERROR", code: error.message, path: [node.cell.id] };
    throw error;
  }
}
