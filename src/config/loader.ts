import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createMachine } from "xstate";
import { z } from "zod";
import { parseDocument, LineCounter } from "yaml";
import type { ToolDefinition, WorkflowDefinition } from "../types.js";
import {
  type InputFieldConfig,
  type WorkflowStepConfig,
  type WorkflowYamlConfig,
  parseWorkflowYaml,
} from "./schema.js";
import { extractTemplateExpressions, parsePath } from "./templates.js";

export interface YamlToolRuntime {
  steps: WorkflowStepConfig[];
  onError?: string;
}

export interface LoadedYamlWorkflow {
  filePath: string;
  config: WorkflowYamlConfig;
  definition: WorkflowDefinition;
  toolRuntimeByState: Record<string, Record<string, YamlToolRuntime>>;
  warnings: string[];
}

/**
 * Load and validate one YAML workflow file.
 */
export function loadWorkflowFromYaml(filePath: string): LoadedYamlWorkflow {
  const absPath = resolve(filePath);
  const source = readFileSync(absPath, "utf8");

  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: true });
  if (doc.errors.length > 0) {
    const details = doc.errors
      .map((e) => {
        const line = e.linePos?.[0]?.line;
        return line
          ? `${absPath}:${line} ${e.message}`
          : `${absPath}: ${e.message}`;
      })
      .join("\n");
    throw new Error(`YAML parse failed:\n${details}`);
  }

  const raw = doc.toJS();
  const parsed = parseWithContext(raw, absPath);

  const semanticErrors = validateSemantics(parsed, absPath);
  if (semanticErrors.length > 0) {
    throw new Error(semanticErrors.join("\n"));
  }

  return {
    filePath: absPath,
    config: parsed,
    definition: buildWorkflowDefinition(parsed),
    toolRuntimeByState: buildToolRuntimeMap(parsed),
    warnings: collectWarnings(parsed),
  };
}

/**
 * Scan a directory and load all .yaml/.yml workflow files.
 */
export function loadWorkflowsFromYamlDir(dir: string): LoadedYamlWorkflow[] {
  const absDir = resolve(dir);
  const entries = readdirSync(absDir);
  const out: LoadedYamlWorkflow[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    out.push(loadWorkflowFromYaml(resolve(absDir, entry)));
  }

  return out;
}

function buildWorkflowDefinition(config: WorkflowYamlConfig): WorkflowDefinition {
  const stateNames = Object.keys(config.states);
  const initial = stateNames[0];

  const toolsByState: Record<string, ToolDefinition[]> = {};
  const promptsByState: Record<string, string> = {};

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    promptsByState[stateName] = stateConfig.prompt ?? "";
    toolsByState[stateName] = Object.entries(stateConfig.tools).map(
      ([toolName, tool]) => ({
        name: toolName,
        description: tool.description,
        inputSchema: buildInputSchema(tool.input),
        requiresReadAfterWrite: Boolean(tool.read_after_write),
        readTool: tool.read_after_write,
        idempotencyKeyTemplate: tool.idempotency,
      }),
    );
  }

  const machineStates: Record<string, { on?: Record<string, string>; type?: "final" }> = {};

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    const transitions = new Set<string>();
    for (const tool of Object.values(stateConfig.tools)) {
      for (const target of collectTransitions(tool.steps)) {
        transitions.add(target);
      }
    }

    const on: Record<string, string> = {};
    for (const target of transitions) {
      on[target] = target;
    }

    if (Object.keys(on).length > 0) {
      machineStates[stateName] = { on };
    } else if (Object.keys(stateConfig.tools).length === 0) {
      machineStates[stateName] = { type: "final" };
    } else {
      machineStates[stateName] = {};
    }
  }

  const machine = createMachine({
    id: config.id,
    initial,
    states: machineStates,
  });

  return {
    id: config.id,
    machine,
    toolsByState,
    promptsByState,
  };
}

function buildToolRuntimeMap(
  config: WorkflowYamlConfig,
): Record<string, Record<string, YamlToolRuntime>> {
  const byState: Record<string, Record<string, YamlToolRuntime>> = {};

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    byState[stateName] = {};
    for (const [toolName, toolConfig] of Object.entries(stateConfig.tools)) {
      byState[stateName][toolName] = {
        steps: toolConfig.steps,
        onError: toolConfig.on_error,
      };
    }
  }

  return byState;
}

function parseWithContext(raw: unknown, filePath: string): WorkflowYamlConfig {
  try {
    return parseWorkflowYaml(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
          return `${filePath}: ${path} - ${issue.message}`;
        })
        .join("\n");
      throw new Error(`Workflow schema validation failed:\n${formatted}`);
    }
    throw error;
  }
}

function validateSemantics(config: WorkflowYamlConfig, filePath: string): string[] {
  const errors: string[] = [];
  const stateNames = Object.keys(config.states);
  const stateSet = new Set(stateNames);
  const contextKeys = new Set(Object.keys(config.context ?? {}));

  const allTools = new Set<string>();
  for (const state of Object.values(config.states)) {
    for (const toolName of Object.keys(state.tools)) {
      allTools.add(toolName);
    }
    for (const tool of Object.values(state.tools)) {
      for (const key of collectSetContextKeys(tool.steps)) {
        contextKeys.add(key);
      }
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const state of stateNames) adjacency.set(state, new Set());

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    for (const [toolName, tool] of Object.entries(stateConfig.tools)) {
      if (tool.read_after_write && !allTools.has(tool.read_after_write)) {
        errors.push(
          `${filePath}: state '${stateName}' tool '${toolName}' read_after_write references unknown tool '${tool.read_after_write}'`,
        );
      }

      const transitions = collectTransitions(tool.steps);
      for (const target of transitions) {
        if (!stateSet.has(target)) {
          errors.push(
            `${filePath}: state '${stateName}' tool '${toolName}' transition target '${target}' does not exist`,
          );
        } else {
          adjacency.get(stateName)?.add(target);
        }
      }

      const templateErrors = validateTemplates(
        tool,
        Object.keys(tool.input),
        [...contextKeys],
        filePath,
        stateName,
        toolName,
      );
      errors.push(...templateErrors);

      const sqlErrors = validateSqlSyntax(tool.steps, filePath, stateName, toolName);
      errors.push(...sqlErrors);
    }
  }

  // Reachability from first state (the implicit initial state)
  if (stateNames.length > 0) {
    const initial = stateNames[0];
    const seen = new Set<string>();
    const stack = [initial];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) stack.push(next);
      }
    }

    for (const state of stateNames) {
      if (!seen.has(state)) {
        errors.push(`${filePath}: state '${state}' is unreachable from initial state '${initial}'`);
      }
    }
  }

  return errors;
}

function collectWarnings(config: WorkflowYamlConfig): string[] {
  const warnings: string[] = [];
  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    if (Object.keys(stateConfig.tools).length === 0) {
      warnings.push(`State '${stateName}' has no tools defined`);
    }
  }
  return warnings;
}

function collectTransitions(steps: WorkflowStepConfig[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if ("return" in step && step.transition) {
      out.push(step.transition);
    }
    if ("if" in step) {
      out.push(...collectTransitions(step.then));
      if (step.else) out.push(...collectTransitions(step.else));
    }
  }
  return out;
}

function collectSetContextKeys(steps: WorkflowStepConfig[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if ("set_context" in step) {
      out.push(...Object.keys(step.set_context));
    }
    if ("if" in step) {
      out.push(...collectSetContextKeys(step.then));
      if (step.else) out.push(...collectSetContextKeys(step.else));
    }
  }
  return out;
}

function validateTemplates(
  tool: { idempotency?: string; steps: WorkflowStepConfig[] },
  inputKeys: string[],
  contextKeys: string[],
  filePath: string,
  stateName: string,
  toolName: string,
): string[] {
  const errors: string[] = [];
  const inputSet = new Set(inputKeys);
  const contextSet = new Set(contextKeys);
  const resultValidation = validateStepTemplateReferences(
    tool.steps,
    new Set<string>(),
    inputSet,
    contextSet,
    filePath,
    stateName,
    toolName,
  );
  errors.push(...resultValidation.errors);

  if (tool.idempotency) {
    const braces = [...tool.idempotency.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    for (const key of braces) {
      if (!inputSet.has(key) && !contextSet.has(key)) {
        errors.push(
          `${filePath}: state '${stateName}' tool '${toolName}' idempotency key references unknown value '${key}'`,
        );
      }
    }
  }

  return errors;
}

function validateStepTemplateReferences(
  steps: WorkflowStepConfig[],
  knownResults: Set<string>,
  inputSet: Set<string>,
  contextSet: Set<string>,
  filePath: string,
  stateName: string,
  toolName: string,
): { errors: string[]; knownAfter: Set<string> } {
  const errors: string[] = [];
  const current = new Set(knownResults);

  for (const step of steps) {
    if ("sql" in step) {
      errors.push(
        ...validateExpressions(
          extractTemplateExpressions(step.sql),
          current,
          inputSet,
          contextSet,
          filePath,
          stateName,
          toolName,
        ),
      );
      if (step.as) current.add(step.as);
      continue;
    }

    if ("http" in step) {
      errors.push(
        ...validateExpressions(
          extractTemplateExpressions(step.http),
          current,
          inputSet,
          contextSet,
          filePath,
          stateName,
          toolName,
        ),
      );
      if (step.as) current.add(step.as);
      continue;
    }

    if ("event" in step) {
      errors.push(
        ...validateExpressions(
          extractTemplateExpressions(step.payload),
          current,
          inputSet,
          contextSet,
          filePath,
          stateName,
          toolName,
        ),
      );
      continue;
    }

    if ("set_context" in step) {
      errors.push(
        ...validateExpressions(
          extractTemplateExpressions(step.set_context),
          current,
          inputSet,
          contextSet,
          filePath,
          stateName,
          toolName,
        ),
      );
      continue;
    }

    if ("return" in step) {
      errors.push(
        ...validateExpressions(
          extractTemplateExpressions(step.return),
          current,
          inputSet,
          contextSet,
          filePath,
          stateName,
          toolName,
        ),
      );
      // Steps after return are unreachable at runtime.
      break;
    }

    if ("if" in step) {
      const thenBranch = validateStepTemplateReferences(
        step.then,
        new Set(current),
        inputSet,
        contextSet,
        filePath,
        stateName,
        toolName,
      );
      errors.push(...thenBranch.errors);

      if (step.else && step.else.length > 0) {
        const elseBranch = validateStepTemplateReferences(
          step.else,
          new Set(current),
          inputSet,
          contextSet,
          filePath,
          stateName,
          toolName,
        );
        errors.push(...elseBranch.errors);

        // Only results produced in both branches are guaranteed after the if.
        const branchIntersection = new Set<string>();
        for (const key of thenBranch.knownAfter) {
          if (elseBranch.knownAfter.has(key)) {
            branchIntersection.add(key);
          }
        }
        for (const key of branchIntersection) {
          current.add(key);
        }
      }
    }
  }

  return { errors, knownAfter: current };
}

function validateExpressions(
  expressions: string[],
  knownResults: Set<string>,
  inputSet: Set<string>,
  contextSet: Set<string>,
  filePath: string,
  stateName: string,
  toolName: string,
): string[] {
  const errors: string[] = [];
  const nonResultRoots = new Set([
    "input",
    "context",
    "env",
    "template",
    "api_base",
    "error",
  ]);

  for (const expr of expressions) {
    try {
      const parts = parsePath(expr);
      const root = parts[0];
      if (typeof root !== "string") {
        throw new Error("Invalid root token");
      }

      if (root === "input") {
        const field = parts[1];
        if (typeof field !== "string" || !inputSet.has(field)) {
          errors.push(
            `${filePath}: state '${stateName}' tool '${toolName}' references unknown input field in '{{${expr}}}'`,
          );
        }
        continue;
      }

      if (root === "context") {
        const key = parts[1];
        if (typeof key !== "string" || !contextSet.has(key)) {
          errors.push(
            `${filePath}: state '${stateName}' tool '${toolName}' references unknown context key in '{{${expr}}}'`,
          );
        }
        continue;
      }

      if (nonResultRoots.has(root)) {
        continue;
      }

      if (!knownResults.has(root)) {
        errors.push(
          `${filePath}: state '${stateName}' tool '${toolName}' references unknown step result '${root}' in '{{${expr}}}'`,
        );
      }
    } catch {
      errors.push(
        `${filePath}: state '${stateName}' tool '${toolName}' has invalid template expression '{{${expr}}}'`,
      );
    }
  }

  return errors;
}

function validateSqlSyntax(
  steps: WorkflowStepConfig[],
  filePath: string,
  stateName: string,
  toolName: string,
): string[] {
  const errors: string[] = [];
  for (const step of steps) {
    if ("sql" in step) {
      const maybeError = basicSqlValidation(step.sql);
      if (maybeError) {
        errors.push(`${filePath}: state '${stateName}' tool '${toolName}' SQL invalid: ${maybeError}`);
      }
    }
    if ("if" in step) {
      errors.push(...validateSqlSyntax(step.then, filePath, stateName, toolName));
      if (step.else) {
        errors.push(...validateSqlSyntax(step.else, filePath, stateName, toolName));
      }
    }
  }
  return errors;
}

function basicSqlValidation(sql: string): string | null {
  const trimmed = sql.trim();
  if (!trimmed) return "SQL is empty";

  if (!/^(select|insert|update|delete|with|create|alter|drop|pragma)/i.test(trimmed)) {
    return "SQL must start with a valid statement keyword";
  }

  let parens = 0;
  let inSingle = false;
  let inDouble = false;

  for (const ch of trimmed) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "(") parens += 1;
      if (ch === ")") parens -= 1;
      if (parens < 0) return "Unbalanced parentheses";
    }
  }

  if (inSingle || inDouble) return "Unclosed quote in SQL";
  if (parens !== 0) return "Unbalanced parentheses";
  return null;
}

function buildInputSchema(
  fields: Record<string, InputFieldConfig>,
): z.ZodSchema<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [fieldName, field] of Object.entries(fields)) {
    let schema: any;

    if (field.type === "string") {
      schema = z.string();
      if (field.pattern) {
        schema = schema.regex(new RegExp(field.pattern));
      }
      if (field.enum) {
        schema = schema.refine((value: unknown) => (field.enum as unknown[]).includes(value), {
          message: `Value must be one of: ${field.enum.join(", ")}`,
        });
      }
    } else if (field.type === "number") {
      schema = z.number();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      if (field.enum) {
        schema = schema.refine((value: unknown) => (field.enum as unknown[]).includes(value), {
          message: `Value must be one of: ${field.enum.join(", ")}`,
        });
      }
    } else if (field.type === "integer") {
      schema = z.number().int();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      if (field.enum) {
        schema = schema.refine((value: unknown) => (field.enum as unknown[]).includes(value), {
          message: `Value must be one of: ${field.enum.join(", ")}`,
        });
      }
    } else {
      schema = z.boolean();
      if (field.enum) {
        schema = schema.refine((value: unknown) => (field.enum as unknown[]).includes(value), {
          message: `Value must be one of: ${field.enum.join(", ")}`,
        });
      }
    }

    if (field.default !== undefined) {
      schema = schema.default(field.default);
    } else if (field.required === false) {
      schema = schema.optional();
    }

    shape[fieldName] = schema;
  }

  return z.object(shape);
}

/**
 * Produce an internal YAML ID from filename fallback when needed.
 */
export function workflowIdFromFilename(filePath: string): string {
  return basename(filePath).replace(/\.(yaml|yml)$/i, "");
}
