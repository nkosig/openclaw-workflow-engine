import { parsePath } from "./templates.js";

interface Token {
  type: "op" | "number" | "identifier" | "boolean" | "null" | "paren";
  value: string;
}

/**
 * Evaluate a workflow condition using a safe recursive-descent parser.
 * No dynamic code execution — expressions are parsed and walked as an AST.
 */
export function evaluateCondition(
  expression: string,
  scope: Record<string, unknown>,
): boolean {
  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    throw new Error("Condition expression cannot be empty");
  }

  let idx = 0;

  const peek = () => tokens[idx];
  const consume = () => tokens[idx++];

  const parseExpression = (): unknown => parseOr();

  const parseOr = (): unknown => {
    let left = parseAnd();
    while (peek()?.type === "op" && peek()!.value === "||") {
      consume();
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  };

  const parseAnd = (): unknown => {
    let left = parseComparison();
    while (peek()?.type === "op" && peek()!.value === "&&") {
      consume();
      const right = parseComparison();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  };

  const parseComparison = (): unknown => {
    const left = parseUnary();
    const op = peek();
    if (op?.type === "op" && [">", "<", ">=", "<=", "==", "!="].includes(op.value)) {
      consume();
      const right = parseUnary();
      return compareValues(left, right, op.value);
    }
    return left;
  };

  const parseUnary = (): unknown => {
    const tk = peek();
    if (tk?.type === "op" && tk.value === "!") {
      consume();
      return !Boolean(parseUnary());
    }
    return parsePrimary();
  };

  const parsePrimary = (): unknown => {
    const tk = consume();
    if (!tk) {
      throw new Error(`Unexpected end of condition '${expression}'`);
    }

    if (tk.type === "paren" && tk.value === "(") {
      const inner = parseExpression();
      const close = consume();
      if (!close || close.type !== "paren" || close.value !== ")") {
        throw new Error(`Unclosed parenthesis in condition '${expression}'`);
      }
      return inner;
    }

    if (tk.type === "number") {
      return Number(tk.value);
    }

    if (tk.type === "boolean") {
      return tk.value === "true";
    }

    if (tk.type === "null") {
      return null;
    }

    if (tk.type === "identifier") {
      return resolveConditionReference(tk.value, scope);
    }

    throw new Error(`Unsupported token '${tk.value}' in condition '${expression}'`);
  };

  const value = parseExpression();
  if (idx !== tokens.length) {
    throw new Error(`Unexpected token '${tokens[idx].value}' in condition '${expression}'`);
  }

  return Boolean(value);
}

function compareValues(left: unknown, right: unknown, op: string): boolean {
  if ([">", "<", ">=", "<="].includes(op)) {
    if (typeof left !== "number" || typeof right !== "number") {
      throw new Error(`Operator '${op}' requires numeric operands`);
    }
  }

  switch (op) {
    case ">":
      return (left as number) > (right as number);
    case "<":
      return (left as number) < (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      throw new Error(`Unsupported comparison operator '${op}'`);
  }
}

function tokenize(expression: string): Token[] {
  const src = expression.trim();
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: Token["type"], value: string) => tokens.push({ type, value });

  while (i < src.length) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (["&&", "||", ">=", "<=", "==", "!="].includes(two)) {
      push("op", two);
      i += 2;
      continue;
    }

    if ([">", "<", "!"].includes(ch)) {
      push("op", ch);
      i += 1;
      continue;
    }

    if (["(", ")"].includes(ch)) {
      push("paren", ch);
      i += 1;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (/[0-9.]/.test(src[i] ?? "")) i += 1;
      push("number", src.slice(start, i));
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (/[A-Za-z0-9_\.\[\]]/.test(src[i] ?? "")) i += 1;
      const word = src.slice(start, i);
      if (word === "true" || word === "false") {
        push("boolean", word);
      } else if (word === "null") {
        push("null", word);
      } else {
        // Validate path syntax for safety.
        parsePath(word);
        push("identifier", word);
      }
      continue;
    }

    throw new Error(`Unsupported token '${ch}' in condition '${expression}'`);
  }

  return tokens;
}

function resolveConditionReference(
  expression: string,
  scope: Record<string, unknown>,
): unknown {
  const parts = parsePath(expression);
  if (parts.length === 0) return undefined;

  const [root, ...rest] = parts;
  let current: unknown;

  if (root === "input") {
    current = scope.input as unknown;
  } else if (root === "context") {
    current = scope.context as unknown;
  } else if (root === "env") {
    current = process.env;
  } else {
    current = scope[root as string];
  }

  for (const part of rest) {
    if (current == null) return undefined;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}
