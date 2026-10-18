import { parseStableId } from "../domain/ids.ts";

export type Ast =
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reference"; readonly id: string }
  | { readonly kind: "aggregate"; readonly id: string }
  | { readonly kind: "unary"; readonly operator: "+" | "-" | "%"; readonly operand: Ast }
  | { readonly kind: "binary"; readonly operator: "+" | "-" | "*" | "/"; readonly left: Ast; readonly right: Ast }
  | { readonly kind: "sum"; readonly args: readonly Ast[] };

export class FormulaSyntaxError extends SyntaxError {
  readonly code = "INVALID_FORMULA";
}

// References: @{cell UUID}; registered memberships: #{aggregate UUID}. No addresses/ranges at runtime.
export function parseFormula(expression: string): Ast {
  if (typeof expression !== "string" || expression.length > 16384) throw new FormulaSyntaxError("Formula length limit.");
  const tokens: string[] = [];
  const lexer = /\s*("(?:[^"]|"")*"|SUM|[@#]\{[0-9a-fA-F-]+\}|(?:\d+(?:\.\d*)?|\.\d+)|[()+*/%,\-])/y;
  let offset = 0;
  while (offset < expression.length && expression.slice(offset).trim()) {
    lexer.lastIndex = offset;
    const token = lexer.exec(expression);
    if (!token) throw new FormulaSyntaxError("Invalid token at " + offset);
    tokens.push(token[1]!);
    offset = lexer.lastIndex;
    if (tokens.length > 2048) throw new FormulaSyntaxError("Token limit.");
  }
  let index = 0;
  let depth = 0;
  const take = () => tokens[index++];
  const expect = (token: string) => { if (take() !== token) throw new FormulaSyntaxError("Expected " + token); };
  function primary(): Ast {
    if (++depth > 128) throw new FormulaSyntaxError("Nesting limit.");
    const token = take();
    let result: Ast;
    if (token === "+" || token === "-") result = { kind: "unary", operator: token, operand: primary() };
    else if (token === "(") { result = binary(0); expect(")"); }
    else if (token === "SUM") {
      expect("(");
      const args: Ast[] = [binary(0)];
      while (tokens[index] === ",") { take(); args.push(binary(0)); }
      expect(")");
      result = { kind: "sum", args };
    } else if (token?.startsWith("@{") || token?.startsWith("#{")) {
      let id: string;
      try { id = parseStableId<"cell">(token.slice(2, -1)); }
      catch { throw new FormulaSyntaxError("Reference must be a stable UUID v4."); }
      result = { kind: token[0] === "@" ? "reference" : "aggregate", id };
    } else if (token?.startsWith('"')) result = { kind: "text", text: token.slice(1, -1).replaceAll('""', '"') };
    else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) result = { kind: "number", text: token };
    else throw new FormulaSyntaxError("Expected literal, reference or SUM.");
    if (tokens[index] === "%") { take(); result = { kind: "unary", operator: "%", operand: result }; }
    depth--;
    return result;
  }
  function binary(min: number): Ast {
    let left = primary();
    while (true) {
      const operator = tokens[index];
      const precedence = operator === "+" || operator === "-" ? 1 : operator === "*" || operator === "/" ? 2 : -1;
      if (precedence < min) break;
      take();
      left = { kind: "binary", operator: operator as "+" | "-" | "*" | "/", left, right: binary(precedence + 1) };
    }
    return left;
  }
  const ast = binary(0);
  if (index !== tokens.length) throw new FormulaSyntaxError("Unexpected token.");
  return ast;
}

export function references(ast: Ast, aggregate: (id: string) => readonly string[]): readonly string[] {
  switch (ast.kind) {
    case "number": case "text": return [];
    case "reference": return [ast.id];
    case "aggregate": return aggregate(ast.id);
    case "unary": return references(ast.operand, aggregate);
    case "binary": return [...references(ast.left, aggregate), ...references(ast.right, aggregate)];
    case "sum": return ast.args.flatMap(arg => references(arg, aggregate));
  }
}
