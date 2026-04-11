export type TemplateScope = Record<string, unknown> & {
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
};

export class TemplateResolutionError extends Error {
  constructor(
    public readonly expression: string,
    public readonly stepNumber?: number,
    message?: string,
  ) {
    super(
      message ??
        `Unable to resolve template expression '${expression}'${
          stepNumber !== undefined ? ` at step ${stepNumber}` : ""
        }`,
    );
    this.name = "TemplateResolutionError";
  }
}

const TEMPLATE_PATTERN = /{{\s*([^}]+?)\s*}}/g;
const EXACT_TEMPLATE_PATTERN = /^{{\s*([^}]+?)\s*}}$/;

/**
 * Extract all template expressions from any nested value.
 */
export function extractTemplateExpressions(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(TEMPLATE_PATTERN)].map((m) => m[1].trim());
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTemplateExpressions(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => extractTemplateExpressions(item));
  }
  return [];
}

/**
 * Resolve all templates in a non-SQL value recursively.
 */
export function resolveTemplate<T>(
  value: T,
  scope: TemplateScope,
  stepNumber?: number,
): T {
  if (typeof value === "string") {
    return resolveTemplateString(value, scope, stepNumber) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, scope, stepNumber)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplate(v, scope, stepNumber);
    }
    return out as T;
  }
  return value;
}

/**
 * Convert SQL templates into a parameterized query tuple [query, params].
 */
export function resolveSqlTemplate(
  sql: string,
  scope: TemplateScope,
  stepNumber?: number,
): [string, unknown[]] {
  const params: unknown[] = [];
  const query = sql.replace(TEMPLATE_PATTERN, (_match, exprRaw: string) => {
    const expr = exprRaw.trim();
    params.push(resolveReference(expr, scope, stepNumber));
    return "?";
  });
  return [query, params];
}

/**
 * Resolve a single expression such as input.id, context.user_id, result[0].name, or env.API_KEY.
 */
export function resolveReference(
  expression: string,
  scope: TemplateScope,
  stepNumber?: number,
): unknown {
  const tokens = parsePath(expression);
  if (tokens.length === 0) {
    throw new TemplateResolutionError(expression, stepNumber, "Empty template expression");
  }

  const [root, ...rest] = tokens;
  let current: unknown;

  if (root === "input") {
    current = scope.input ?? {};
  } else if (root === "context") {
    current = scope.context ?? {};
  } else if (root === "env") {
    current = scope.env ?? process.env;
  } else {
    current = scope[root];
  }

  if (current === undefined) {
    throw new TemplateResolutionError(expression, stepNumber);
  }

  for (const part of rest) {
    if (current === null || current === undefined) {
      throw new TemplateResolutionError(expression, stepNumber);
    }
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        throw new TemplateResolutionError(expression, stepNumber);
      }
      current = current[part];
    } else {
      if (typeof current !== "object") {
        throw new TemplateResolutionError(expression, stepNumber);
      }
      current = (current as Record<string, unknown>)[part];
    }
  }

  if (current === undefined) {
    throw new TemplateResolutionError(expression, stepNumber);
  }

  return current;
}

/**
 * Parse path expressions like result[0].field into token arrays.
 */
export function parsePath(expression: string): Array<string | number> {
  const expr = expression.trim();
  if (!expr) return [];

  let i = 0;
  const out: Array<string | number> = [];

  const readIdentifier = () => {
    if (!/[A-Za-z_]/.test(expr[i] ?? "")) return "";
    const start = i;
    i += 1;
    while (/[A-Za-z0-9_]/.test(expr[i] ?? "")) i += 1;
    return expr.slice(start, i);
  };

  const root = readIdentifier();
  if (!root) {
    throw new TemplateResolutionError(expression, undefined, `Invalid expression '${expression}'`);
  }
  out.push(root);

  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ".") {
      i += 1;
      const id = readIdentifier();
      if (!id) {
        throw new TemplateResolutionError(expression, undefined, `Invalid expression '${expression}'`);
      }
      out.push(id);
      continue;
    }

    if (ch === "[") {
      i += 1;
      const start = i;
      while (/[0-9]/.test(expr[i] ?? "")) i += 1;
      if (start === i || expr[i] !== "]") {
        throw new TemplateResolutionError(expression, undefined, `Invalid expression '${expression}'`);
      }
      const idx = Number(expr.slice(start, i));
      i += 1;
      out.push(idx);
      continue;
    }

    throw new TemplateResolutionError(expression, undefined, `Invalid expression '${expression}'`);
  }

  return out;
}

function resolveTemplateString(
  value: string,
  scope: TemplateScope,
  stepNumber?: number,
): unknown {
  const exact = value.match(EXACT_TEMPLATE_PATTERN);
  if (exact) {
    return resolveReference(exact[1].trim(), scope, stepNumber);
  }

  return value.replace(TEMPLATE_PATTERN, (_match, exprRaw: string) => {
    const resolved = resolveReference(exprRaw.trim(), scope, stepNumber);
    return String(resolved);
  });
}
