/**
 * A tiny, closed expression language for business-rule checks (ASSERT_CALC), e.g.
 *
 *   round(subtotal * 0.9, 2) == total
 *   line_total == price * quantity
 *   count >= 1
 *
 * It is parsed and evaluated here, by hand. Nothing is ever passed to `eval`, `Function` or
 * the browser. The grammar has numbers, double-quoted strings, variables (lower_snake_case
 * values extracted earlier in the case), + - * / %, parentheses, a fixed set of numeric
 * functions, and exactly one comparison at the top level.
 */

export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const FUNCTIONS = { round: [1, 2], floor: [1, 1], ceil: [1, 1], abs: [1, 1], min: [2, 8], max: [2, 8] } as const;
type FunctionName = keyof typeof FUNCTIONS;
export const COMPARATORS = ["==", "!=", "<=", ">=", "<", ">"] as const;
type Comparator = (typeof COMPARATORS)[number];

export const MAX_EXPRESSION_LENGTH = 300;
const MAX_TOKENS = 120;
const MAX_DEPTH = 16;

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

export type Node =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "var"; name: string }
  | { type: "neg"; arg: Node }
  | { type: "bin"; op: "+" | "-" | "*" | "/" | "%"; left: Node; right: Node }
  | { type: "call"; fn: FunctionName; args: Node[] };

export type Comparison = { op: Comparator; left: Node; right: Node };

export class ExpressionError extends Error {}

function tokenize(source: string): Token[] {
  if (source.length > MAX_EXPRESSION_LENGTH) throw new ExpressionError(`Expressions are limited to ${MAX_EXPRESSION_LENGTH} characters`);
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(source.slice(i));
    if (number) {
      tokens.push({ t: "num", v: Number(number[0]) });
      i += number[0].length;
    } else if (/[a-z]/.test(c)) {
      const id = /^[a-z][a-z0-9_]*/.exec(source.slice(i))![0];
      if (id.length > 40) throw new ExpressionError(`Name too long: ${id.slice(0, 40)}…`);
      tokens.push({ t: "id", v: id });
      i += id.length;
    } else if (c === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new ExpressionError("Unterminated string");
      const value = source.slice(i + 1, end);
      if (value.length > 200) throw new ExpressionError("Strings are limited to 200 characters");
      tokens.push({ t: "str", v: value });
      i = end + 1;
    } else if (c === "(" || c === ")" || c === ",") {
      tokens.push({ t: c });
      i++;
    } else {
      const op = ["==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%"].find((o) => source.startsWith(o, i));
      if (!op) throw new ExpressionError(`Unexpected character "${c}"`);
      tokens.push({ t: "op", v: op });
      i += op.length;
    }
    if (tokens.length > MAX_TOKENS) throw new ExpressionError("Expression is too long");
  }
  return tokens;
}

/** Parses `left <op> right`. Throws ExpressionError with a readable message. */
export function parseComparison(source: string): Comparison {
  const tokens = tokenize(source.trim());
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...ops: string[]) => peek()?.t === "op" && ops.includes((peek() as { v: string }).v);

  const expression = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new ExpressionError("Expression is nested too deeply");
    let left = term(depth);
    while (isOp("+", "-")) {
      const op = (tokens[pos++] as { v: "+" | "-" }).v;
      left = { type: "bin", op, left, right: term(depth) };
    }
    return left;
  };
  const term = (depth: number): Node => {
    let left = unary(depth);
    while (isOp("*", "/", "%")) {
      const op = (tokens[pos++] as { v: "*" | "/" | "%" }).v;
      left = { type: "bin", op, left, right: unary(depth) };
    }
    return left;
  };
  const unary = (depth: number): Node => {
    if (isOp("-")) {
      pos++;
      return { type: "neg", arg: unary(depth + 1) };
    }
    return primary(depth);
  };
  const primary = (depth: number): Node => {
    const token = tokens[pos++];
    if (!token) throw new ExpressionError("Expression ends unexpectedly");
    if (token.t === "num") return { type: "num", value: token.v };
    if (token.t === "str") return { type: "str", value: token.v };
    if (token.t === "(") {
      const inner = expression(depth + 1);
      if (tokens[pos++]?.t !== ")") throw new ExpressionError("Missing )");
      return inner;
    }
    if (token.t === "id") {
      if (peek()?.t !== "(") {
        if (!VARIABLE_NAME.test(token.v)) throw new ExpressionError(`Invalid variable name ${token.v}`);
        return { type: "var", name: token.v };
      }
      if (!(token.v in FUNCTIONS)) throw new ExpressionError(`Unknown function ${token.v}()`);
      const fn = token.v as FunctionName;
      pos++;
      const args: Node[] = [];
      if (peek()?.t !== ")") {
        for (;;) {
          args.push(expression(depth + 1));
          if (peek()?.t === ",") pos++;
          else break;
        }
      }
      if (tokens[pos++]?.t !== ")") throw new ExpressionError(`Missing ) after ${fn}(`);
      const [min, max] = FUNCTIONS[fn];
      if (args.length < min || args.length > max) throw new ExpressionError(`${fn}() takes ${min === max ? min : `${min}–${max}`} arguments`);
      return { type: "call", fn, args };
    }
    throw new ExpressionError(`Unexpected ${token.t === "op" ? token.v : token.t}`);
  };

  const left = expression(0);
  const opToken = tokens[pos++];
  if (!opToken || opToken.t !== "op" || !(COMPARATORS as readonly string[]).includes(opToken.v)) {
    throw new ExpressionError("A check needs exactly one comparison: ==, !=, <, <=, > or >=");
  }
  const right = expression(0);
  if (pos !== tokens.length) throw new ExpressionError("Unexpected text after the comparison");
  return { op: opToken.v as Comparator, left, right };
}

/** Variable names an expression reads. */
export function expressionVariables(comparison: Comparison): string[] {
  const names = new Set<string>();
  const walk = (node: Node) => {
    if (node.type === "var") names.add(node.name);
    else if (node.type === "neg") walk(node.arg);
    else if (node.type === "bin") {
      walk(node.left);
      walk(node.right);
    }
    else if (node.type === "call") node.args.forEach(walk);
  };
  walk(comparison.left);
  walk(comparison.right);
  return [...names];
}

export type Value = number | string;

function evaluate(node: Node, vars: ReadonlyMap<string, Value>): Value {
  const num = (n: Node): number => {
    const v = evaluate(n, vars);
    if (typeof v !== "number") throw new ExpressionError(`"${v}" is not a number`);
    return v;
  };
  switch (node.type) {
    case "num":
    case "str":
      return node.value;
    case "var": {
      const value = vars.get(node.name);
      if (value === undefined) throw new ExpressionError(`Variable ${node.name} has no value`);
      return value;
    }
    case "neg":
      return -num(node.arg);
    case "bin": {
      const [a, b] = [num(node.left), num(node.right)];
      if ((node.op === "/" || node.op === "%") && b === 0) throw new ExpressionError("Division by zero");
      return node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : node.op === "/" ? a / b : a % b;
    }
    case "call": {
      const args = node.args.map(num);
      switch (node.fn) {
        case "round": {
          const factor = 10 ** Math.min(Math.max(Math.trunc(args[1] ?? 0), 0), 10);
          return Math.round((args[0] + Number.EPSILON) * factor) / factor;
        }
        case "floor": return Math.floor(args[0]);
        case "ceil": return Math.ceil(args[0]);
        case "abs": return Math.abs(args[0]);
        case "min": return Math.min(...args);
        case "max": return Math.max(...args);
      }
    }
  }
}

export type ComparisonResult = { ok: boolean; left: Value; right: Value; op: Comparator };

/**
 * Evaluates a comparison. Numbers are equal within `tolerance` (default half a cent, for
 * money); strings compare exactly and only with == or !=.
 */
export function evaluateComparison(comparison: Comparison, vars: ReadonlyMap<string, Value>, tolerance = 0.005): ComparisonResult {
  const left = evaluate(comparison.left, vars);
  const right = evaluate(comparison.right, vars);
  const { op } = comparison;
  if (typeof left === "number" && typeof right === "number") {
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw new ExpressionError("Result is not a finite number");
    const eq = Math.abs(left - right) <= tolerance;
    const ok = op === "==" ? eq : op === "!=" ? !eq : op === "<" ? left < right && !eq : op === "<=" ? left <= right || eq : op === ">" ? left > right && !eq : left >= right || eq;
    return { ok, left, right, op };
  }
  if (op !== "==" && op !== "!=") throw new ExpressionError(`${op} needs numbers on both sides`);
  const eq = String(left) === String(right);
  return { ok: op === "==" ? eq : !eq, left, right, op };
}

/**
 * Parses a number out of displayed text: "$1,234.50" → 1234.5, "Total: 108 €" → 108,
 * "1.234,50" with decimal "," → 1234.5. Null if there's no number.
 */
export function parseDisplayedNumber(text: string, decimal: "." | "," = "."): number | null {
  // Either properly grouped thousands ("1,234", "1 234 567") or a plain run of digits, then an
  // optional decimal part. Separate numbers ("108 3 items") are never merged.
  const match = /-?(?:\d{1,3}(?:[,.'\u00a0\u202f ]\d{3})+|\d+)(?:[.,]\d+)?/.exec(text);
  if (!match) return null;
  const thousands = decimal === "." ? "," : ".";
  let raw = match[0].replace(/[\s\u00a0\u202f']/g, "").split(thousands).join("");
  if (decimal === ",") raw = raw.replace(",", ".");
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function formatValue(value: Value): string {
  return typeof value === "number" ? String(Math.round(value * 1e6) / 1e6) : JSON.stringify(value);
}
