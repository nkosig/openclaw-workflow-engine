import { evaluateCondition } from "../config/conditions.js";
import type {
  WorkflowStepConfig,
  WorkflowYamlConfig,
} from "../config/schema.js";
import {
  resolveSqlTemplate,
  resolveTemplate,
  type TemplateScope,
} from "../config/templates.js";
import { HttpExecutor } from "./http-executor.js";
import { SqlExecutor } from "./sql-executor.js";

export interface StepExecutionResult {
  returned: boolean;
  data?: unknown;
  transition?: string;
  results: Record<string, unknown>;
  context: Record<string, unknown>;
  contextUpdated: boolean;
  error?: { step: number; message: string };
}

export interface StepExecutorOptions {
  sql: SqlExecutor;
  http: HttpExecutor;
  workflowConfig?: Pick<WorkflowYamlConfig, "db" | "api_base">;
  instanceId?: string;
  maxIfDepth?: number;
  logAudit?: (
    eventType: string,
    payload?: unknown,
    toolName?: string,
    instanceId?: string,
  ) => void;
}

/**
 * Runtime step orchestrator for YAML-defined tools.
 */
export class StepExecutor {
  private readonly sql: SqlExecutor;
  private readonly http: HttpExecutor;
  private readonly dbPath?: string;
  private readonly apiBase?: string;
  private readonly maxIfDepth: number;
  private readonly instanceId?: string;
  private readonly logAudit?: StepExecutorOptions["logAudit"];

  constructor(options: StepExecutorOptions) {
    this.sql = options.sql;
    this.http = options.http;
    this.dbPath = options.workflowConfig?.db;
    this.apiBase = options.workflowConfig?.api_base;
    this.maxIfDepth = options.maxIfDepth ?? 3;
    this.instanceId = options.instanceId;
    this.logAudit = options.logAudit;
  }

  /**
   * Execute tool steps sequentially.
   */
  async executeSteps(
    steps: WorkflowStepConfig[],
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    toolName?: string,
  ): Promise<StepExecutionResult> {
    const runner = () => this.executeInternal(steps, input, context, {}, 0, toolName);

    if (!hasWriteSqlStep(steps)) {
      return runner();
    }

    const begin = await this.sql.execute("BEGIN IMMEDIATE", [], this.dbPath);
    if (begin.error) {
      return {
        returned: false,
        context,
        contextUpdated: false,
        results: {},
        error: { step: 0, message: begin.message },
      };
    }

    const result = await runner();
    if (result.error) {
      await this.sql.execute("ROLLBACK", [], this.dbPath);
      return result;
    }

    const commit = await this.sql.execute("COMMIT", [], this.dbPath);
    if (commit.error) {
      await this.sql.execute("ROLLBACK", [], this.dbPath);
      return {
        ...result,
        error: { step: 0, message: commit.message },
      };
    }

    return result;
  }

  private async executeInternal(
    steps: WorkflowStepConfig[],
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    inheritedResults: Record<string, unknown>,
    ifDepth: number,
    toolName?: string,
  ): Promise<StepExecutionResult> {
    if (ifDepth > this.maxIfDepth) {
      return {
        returned: false,
        context,
        contextUpdated: false,
        results: inheritedResults,
        error: {
          step: 0,
          message: `Maximum if nesting depth (${this.maxIfDepth}) exceeded`,
        },
      };
    }

    const results: Record<string, unknown> = { ...inheritedResults };
    let contextUpdated = false;

    for (let idx = 0; idx < steps.length; idx += 1) {
      const step = steps[idx];
      const stepNumber = idx + 1;
      const scope = this.buildScope(input, context, results);

      try {
        if ("sql" in step) {
          const [query, params] = resolveSqlTemplate(step.sql, scope, stepNumber);
          const sqlResult = await this.sql.execute(query, params, this.dbPath);
          if (sqlResult.error) {
            return {
              returned: false,
              results,
              context,
              contextUpdated,
              error: { step: stepNumber, message: sqlResult.message },
            };
          }
          if (step.as) {
            results[step.as] = "rows" in sqlResult ? sqlResult.rows : {
              changes: sqlResult.changes,
              lastInsertRowid: sqlResult.lastInsertRowid,
            };
          }
          continue;
        }

        if ("http" in step) {
          const httpResult = await this.http.execute(step.http, scope, stepNumber);
          if (httpResult.error) {
            return {
              returned: false,
              results,
              context,
              contextUpdated,
              error: { step: stepNumber, message: httpResult.message },
            };
          }
          if (step.as) {
            results[step.as] = httpResult.data;
          }
          continue;
        }

        if ("if" in step) {
          const condition = evaluateCondition(step.if, scope);
          const branch = condition ? step.then : step.else;
          if (branch && branch.length > 0) {
            const branchResult = await this.executeInternal(
              branch,
              input,
              context,
              results,
              ifDepth + 1,
              toolName,
            );
            if (branchResult.error) {
              return branchResult;
            }
            Object.assign(results, branchResult.results);
            contextUpdated = contextUpdated || branchResult.contextUpdated;
            if (branchResult.returned) {
              return branchResult;
            }
          }
          continue;
        }

        if ("event" in step) {
          const payload =
            step.payload !== undefined
              ? resolveTemplate(step.payload, scope, stepNumber)
              : undefined;
          this.logAudit?.(step.event, payload, toolName, this.instanceId);
          continue;
        }

        if ("set_context" in step) {
          const resolved = resolveTemplate(step.set_context, scope, stepNumber);
          Object.assign(context, resolved as Record<string, unknown>);
          contextUpdated = true;
          continue;
        }

        if ("return" in step) {
          const data = resolveTemplate(step.return, scope, stepNumber);
          return {
            returned: true,
            data,
            transition: step.transition,
            results,
            context,
            contextUpdated,
          };
        }
      } catch (error) {
        return {
          returned: false,
          results,
          context,
          contextUpdated,
          error: {
            step: stepNumber,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    return {
      returned: false,
      results,
      context,
      contextUpdated,
    };
  }

  private buildScope(
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    results: Record<string, unknown>,
  ): TemplateScope {
    return {
      ...results,
      input,
      context,
      env: process.env,
      api_base: this.apiBase,
      template: (context as Record<string, unknown>)["template"],
    };
  }
}

function hasWriteSqlStep(steps: WorkflowStepConfig[]): boolean {
  for (const step of steps) {
    if ("sql" in step) {
      const verb = step.sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      if (!["SELECT", "WITH", "PRAGMA"].includes(verb)) {
        return true;
      }
    }
    if ("if" in step) {
      if (hasWriteSqlStep(step.then)) return true;
      if (step.else && hasWriteSqlStep(step.else)) return true;
    }
  }
  return false;
}
