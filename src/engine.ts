import { PersistenceLayer } from "./persistence.js";
import { WorkflowMachine } from "./machine.js";
import { ValidationLayer } from "./validation.js";
import { loadWorkflowFromYaml, type LoadedYamlWorkflow } from "./config/loader.js";
import { StepExecutor } from "./executors/step-executor.js";
import { SqlExecutor } from "./executors/sql-executor.js";
import { HttpExecutor } from "./executors/http-executor.js";
import {
  resolveTemplate,
  type TemplateScope,
} from "./config/templates.js";
import type {
  WorkflowDefinition,
  ToolDefinition,
  WorkflowInstance,
  ToolResult,
  WorkflowStatus,
  AuditEntry,
  HandleToolResultOutput,
} from "./types.js";

interface YamlRuntimeDefinition {
  filePath: string;
  loaded: LoadedYamlWorkflow;
}

/**
 * Main workflow engine orchestrator.
 * Combines the state machine, persistence, validation, and YAML runtime execution layers.
 */
export class WorkflowEngine {
  private persistence: PersistenceLayer;
  private machine: WorkflowMachine;
  private validation: ValidationLayer;
  /** workflowId → WorkflowDefinition (for prompt lookup, tool routing, and dashboard) */
  private readonly definitions = new Map<string, WorkflowDefinition>();
  /** workflowId → YAML runtime metadata */
  private readonly yamlRuntime = new Map<string, YamlRuntimeDefinition>();
  private readonly sqlExecutor: SqlExecutor;
  private readonly httpExecutor: HttpExecutor;

  constructor(dbPath?: string) {
    this.persistence = new PersistenceLayer(dbPath);
    this.machine = new WorkflowMachine(this.persistence);
    this.validation = new ValidationLayer(this.machine, this.persistence);
    this.sqlExecutor = new SqlExecutor();
    this.httpExecutor = new HttpExecutor();
  }

  /**
   * Register a TypeScript workflow definition so it can be started via startWorkflow().
   */
  registerWorkflow(definition: WorkflowDefinition): void {
    this.machine.registerDefinition(definition);
    this.definitions.set(definition.id, definition);
  }

  /**
   * Register a YAML workflow file.
   * Loads, validates, runs pending migrations, and registers the generated internal definition.
   */
  registerWorkflowFromYaml(filePath: string): void {
    const loaded = loadWorkflowFromYaml(filePath);
    this.applyMigrations(loaded);
    this.registerWorkflow(loaded.definition);
    this.yamlRuntime.set(loaded.definition.id, {
      filePath: loaded.filePath,
      loaded,
    });
  }

  /**
   * Validate a YAML workflow file without registering it.
   */
  validateWorkflowYaml(filePath: string): LoadedYamlWorkflow {
    return loadWorkflowFromYaml(filePath);
  }

  /**
   * Run pending migrations declared in a YAML workflow file.
   */
  runMigrationsForYaml(filePath: string): { workflowId: string; applied: number[] } {
    const loaded = loadWorkflowFromYaml(filePath);
    const applied = this.applyMigrations(loaded);
    return { workflowId: loaded.definition.id, applied };
  }

  /**
   * Execute one YAML-defined tool as a dry run (without starting/transitioning an instance).
   */
  async dryRunYamlTool(
    filePath: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const loaded = loadWorkflowFromYaml(filePath);
    const candidate = Object.entries(loaded.definition.toolsByState)
      .flatMap(([stateName, tools]) => tools.map((tool) => ({ stateName, tool })))
      .find(({ tool }) => tool.name === toolName);

    if (!candidate) {
      throw new Error(`Tool '${toolName}' not found in workflow '${loaded.definition.id}'`);
    }

    const parsed = candidate.tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Invalid tool input: ${parsed.error.message}`);
    }

    const runtime = loaded.toolRuntimeByState[candidate.stateName]?.[toolName];
    if (!runtime) {
      throw new Error(`Runtime steps missing for tool '${toolName}'`);
    }

    const context = { ...(loaded.config.context ?? {}) };
    const stepExecutor = this.createStepExecutor(loaded);
    const result = await stepExecutor.executeSteps(
      runtime.steps,
      parsed.data as Record<string, unknown>,
      context,
      toolName,
    );

    if (result.error) {
      return {
        success: false,
        error: result.error.message,
        step: result.error.step,
      };
    }

    return {
      success: true,
      returned: result.returned,
      data: result.data,
      results: result.results,
      context,
      transition: result.transition,
    };
  }

  /**
   * Start a new workflow instance. Returns the created instance.
   */
  startWorkflow(
    workflowId: string,
    context: Record<string, unknown> = {},
  ): WorkflowInstance {
    const baseContext = this.yamlRuntime.get(workflowId)?.loaded.config.context ?? {};
    return this.machine.createInstance(workflowId, { ...baseContext, ...context });
  }

  /**
   * Find an active (non-final) instance for a workflow, enabling resume support.
   * Returns null if no active instance exists.
   */
  getActiveWorkflow(workflowId: string): WorkflowInstance | null {
    const row = this.persistence.getActiveInstance(workflowId);
    if (!row) return null;
    return {
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      currentState: row.current_state,
      context: row.context ? JSON.parse(row.context) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get the tools currently available for an instance (based on its current state).
   */
  getAvailableTools(instanceId: string): ToolDefinition[] {
    return this.machine.getAvailableTools(instanceId);
  }

  /**
   * Execute a tool call on a workflow instance.
   */
  async executeTool(
    instanceId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.machine.isFinalState(instanceId)) {
      return {
        success: false,
        error: `Instance '${instanceId}' is final and cannot accept tool calls`,
      };
    }

    const row = this.persistence.loadSnapshot(instanceId);
    if (!row) {
      return { success: false, error: `Instance '${instanceId}' not found` };
    }

    const validationResult = this.validation.validateToolCall(
      instanceId,
      toolName,
      input,
    );
    if (!validationResult.valid) {
      return { success: false, error: validationResult.reason };
    }

    const availableTools = this.machine.getAvailableTools(instanceId);
    const toolDef = availableTools.find((t) => t.name === toolName);
    if (!toolDef) {
      return { success: false, error: `Tool '${toolName}' is not available` };
    }

    const runtime = this.yamlRuntime.get(row.workflow_id);
    if (runtime) {
      return this.executeYamlTool(
        runtime.loaded,
        instanceId,
        row.current_state,
        toolDef,
        validationResult.parsedInput as Record<string, unknown>,
      );
    }

    return this.executeTypedTool(
      instanceId,
      toolDef,
      validationResult.parsedInput as Record<string, unknown>,
    );
  }

  /**
   * Get the current status of a workflow instance.
   */
  getStatus(instanceId: string): WorkflowStatus {
    const row = this.persistence.loadSnapshot(instanceId);
    if (!row) throw new Error(`Instance '${instanceId}' not found`);

    const availableTools = this.machine.getAvailableTools(instanceId);
    const context = row.context ? JSON.parse(row.context) : {};

    return {
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      currentState: row.current_state,
      isFinal: row.is_final === 1,
      availableTools,
      context,
    };
  }

  /**
   * Get the audit log for an instance.
   */
  getAuditLog(instanceId: string, limit: number = 100): AuditEntry[] {
    return this.persistence.getAuditLog(instanceId, limit);
  }

  /**
   * Cancel a workflow instance and allow a fresh start.
   * Marks the instance as final so getActiveWorkflow() will not return it.
   */
  resetWorkflow(instanceId: string): void {
    const row = this.persistence.loadSnapshot(instanceId);
    if (!row) throw new Error(`Instance '${instanceId}' not found`);

    const snapshot = JSON.parse(row.xstate_snapshot);
    this.persistence.saveSnapshot(
      instanceId,
      snapshot,
      row.current_state,
      row.context ? JSON.parse(row.context) : {},
      true,
    );
    this.persistence.logAudit(instanceId, "instance_reset", undefined, {
      previousState: row.current_state,
    });
  }

  /**
   * Get all workflow IDs that have been registered with this engine.
   */
  getRegisteredWorkflowIds(): string[] {
    return [...this.definitions.keys()];
  }

  /**
   * Return the full WorkflowDefinition for a given workflow ID, or undefined.
   */
  getDefinition(workflowId: string): WorkflowDefinition | undefined {
    return this.definitions.get(workflowId);
  }

  /**
   * Return the system-prompt fragment for an instance's current state.
   * Returns null when the workflow has no promptsByState entry for that state.
   */
  getStatePrompt(instanceId: string): string | null {
    const row = this.persistence.loadSnapshot(instanceId);
    if (!row) return null;
    const def = this.definitions.get(row.workflow_id);
    return def?.promptsByState?.[this.topLevelState(row.current_state)] ?? null;
  }

  /**
   * Find the active workflow instance whose current state exposes the given tool name.
   */
  getActiveWorkflowForTool(toolName: string): WorkflowInstance | null {
    for (const workflowId of this.definitions.keys()) {
      const active = this.getActiveWorkflow(workflowId);
      if (!active) continue;
      const tools = this.machine.getAvailableTools(active.instanceId);
      if (tools.some((t) => t.name === toolName)) {
        return active;
      }
    }
    return null;
  }

  /**
   * Validate a tool call without executing it.
   */
  validateToolCall(
    instanceId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): { valid: boolean; reason?: string } {
    const result = this.validation.validateToolCall(
      instanceId,
      toolName,
      input,
    );
    return { valid: result.valid, reason: result.reason };
  }

  /**
   * Handle the result of a tool that was executed externally (OpenClaw plugin pattern).
   */
  async handleToolResult(
    instanceId: string,
    toolName: string,
    result: unknown,
  ): Promise<HandleToolResultOutput> {
    const availableTools = this.machine.getAvailableTools(instanceId);
    const toolDef = availableTools.find((t) => t.name === toolName);
    if (!toolDef) {
      this.persistence.logAudit(instanceId, "tool_rejected", toolName, {
        reason: `Tool '${toolName}' is not available in the current state`,
      });
      return { success: false, stateChanged: false };
    }

    const outputValidator = this.machine.getOutputValidator(
      instanceId,
      toolName,
    );
    if (outputValidator) {
      const outputValidation = outputValidator.safeParse(result);
      if (!outputValidation.success) {
        const error = `Output validation failed for '${toolName}': ${outputValidation.error.message}`;
        this.persistence.logAudit(instanceId, "validation_failed", toolName, {
          error,
        });
        return { success: false, stateChanged: false, error };
      }
    }

    this.persistence.logAudit(instanceId, "tool_succeeded", toolName, {
      result,
    });

    const prevState = this.machine.getCurrentState(instanceId)?.state;
    let newState = prevState;
    let stateChanged = false;

    if (toolDef.onSuccess) {
      const transition = this.machine.transition(
        instanceId,
        toolDef.onSuccess,
        {},
      );
      if (transition.success && transition.newState !== prevState) {
        newState = transition.newState;
        stateChanged = true;
      }
    }

    if (toolDef.requiresReadAfterWrite && toolDef.readTool) {
      const rResult = await this.executeTool(instanceId, toolDef.readTool, {});
      if (!rResult.success) {
        this.persistence.logAudit(
          instanceId,
          "read_after_write_failed",
          toolName,
          { readTool: toolDef.readTool, error: rResult.error },
        );
        return {
          success: false,
          stateChanged,
          newState,
          error: `Read-after-write failed (${toolDef.readTool}): ${rResult.error}`,
        };
      }
      return {
        success: true,
        newState,
        stateChanged,
        readResult: rResult.result,
      };
    }

    return { success: true, newState, stateChanged };
  }

  /**
   * Close database and executor connections.
   */
  close(): void {
    this.sqlExecutor.closeAll();
    this.persistence.close();
  }

  private async executeTypedTool(
    instanceId: string,
    toolDef: ToolDefinition,
    parsedInput: Record<string, unknown>,
  ): Promise<ToolResult> {
    let idempotencyKey: string | undefined;
    if (toolDef.idempotencyKeyTemplate) {
      let idempotencyResult;
      try {
        idempotencyResult = this.validation.checkIdempotency(
          instanceId,
          toolDef.name,
          parsedInput,
          toolDef.idempotencyKeyTemplate,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.persistence.logAudit(instanceId, "validation_failed", toolDef.name, {
          reason,
          input: parsedInput,
        });
        return { success: false, error: reason };
      }
      idempotencyKey = idempotencyResult.key;
      if (idempotencyResult.duplicate) {
        this.persistence.logAudit(instanceId, "idempotency_hit", toolDef.name, {
          idempotency_key: idempotencyResult.key,
          input: parsedInput,
        });
        return {
          success: true,
          result: idempotencyResult.existingResult,
          idempotencyHit: true,
          newState: this.machine.getCurrentState(instanceId)?.state,
        };
      }
    }

    this.persistence.logAudit(instanceId, "tool_called", toolDef.name, {
      input: parsedInput,
    });

    const auditPayload: Record<string, unknown> = { input: parsedInput };
    if (idempotencyKey) auditPayload.idempotency_key = idempotencyKey;

    const auditId = this.persistence.logAudit(
      instanceId,
      "tool_succeeded",
      toolDef.name,
      auditPayload,
    );

    let newState = this.machine.getCurrentState(instanceId)?.state;
    if (toolDef.onSuccess) {
      const transitionResult = this.machine.transition(
        instanceId,
        toolDef.onSuccess,
        parsedInput,
      );
      if (!transitionResult.success) {
        this.persistence.logAudit(instanceId, "transition_failed", toolDef.name, {
          event: toolDef.onSuccess,
          reason: transitionResult.reason,
        });
        return {
          success: false,
          error: `Transition '${toolDef.onSuccess}' failed: ${transitionResult.reason}`,
        };
      }
      newState = transitionResult.newState;
    }

    const result: ToolResult = {
      success: true,
      result: parsedInput,
      newState,
      auditId,
    };

    if (toolDef.requiresReadAfterWrite && toolDef.readTool) {
      const readResult = await this.executeTool(instanceId, toolDef.readTool, {});
      if (!readResult.success) {
        this.persistence.logAudit(
          instanceId,
          "read_after_write_failed",
          toolDef.name,
          {
            readTool: toolDef.readTool,
            error: readResult.error,
          },
        );
        return {
          success: false,
          error: `Read-after-write failed (${toolDef.readTool}): ${readResult.error}`,
        };
      }
      result.result = readResult.result;
    }

    return result;
  }

  private async executeYamlTool(
    loaded: LoadedYamlWorkflow,
    instanceId: string,
    currentState: string,
    toolDef: ToolDefinition,
    parsedInput: Record<string, unknown>,
  ): Promise<ToolResult> {
    const stateName = this.topLevelState(currentState);
    const runtimeTool = loaded.toolRuntimeByState[stateName]?.[toolDef.name];
    if (!runtimeTool) {
      return {
        success: false,
        error: `Runtime steps for tool '${toolDef.name}' not found in state '${stateName}'`,
      };
    }

    const persisted = this.persistence.loadSnapshot(instanceId);
    const context = persisted?.context ? JSON.parse(persisted.context) : {};

    let idempotencyKey: string | undefined;
    if (toolDef.idempotencyKeyTemplate) {
      try {
        idempotencyKey = this.buildYamlIdempotencyKey(
          toolDef.idempotencyKeyTemplate,
          parsedInput,
          context,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.persistence.logAudit(instanceId, "validation_failed", toolDef.name, {
          reason,
          input: parsedInput,
        });
        return { success: false, error: reason };
      }

      const existing = this.persistence.findByIdempotencyKey(
        instanceId,
        toolDef.name,
        idempotencyKey,
      );

      if (existing.length > 0) {
        const payload = JSON.parse(existing[0].payload);
        const existingResult =
          payload && typeof payload === "object" && "result" in payload
            ? (payload as Record<string, unknown>).result
            : payload;

        this.persistence.logAudit(instanceId, "idempotency_hit", toolDef.name, {
          idempotency_key: idempotencyKey,
          input: parsedInput,
        });

        return {
          success: true,
          idempotencyHit: true,
          result: existingResult,
          newState: this.machine.getCurrentState(instanceId)?.state,
        };
      }
    }

    this.persistence.logAudit(instanceId, "tool_called", toolDef.name, {
      input: parsedInput,
    });

    const stepExecutor = this.createStepExecutor(loaded, instanceId);
    const stepResult = await stepExecutor.executeSteps(
      runtimeTool.steps,
      parsedInput,
      context,
      toolDef.name,
    );

    if (stepResult.error) {
      const errorMessage = this.resolveOnErrorMessage(
        runtimeTool.onError,
        stepResult.error.message,
      );
      this.persistence.logAudit(instanceId, "tool_failed", toolDef.name, {
        input: parsedInput,
        step: stepResult.error.step,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }

    let newState = this.machine.getCurrentState(instanceId)?.state;
    if (stepResult.transition) {
      const transition = this.machine.transition(
        instanceId,
        stepResult.transition,
        {},
      );
      if (!transition.success) {
        this.persistence.logAudit(instanceId, "transition_failed", toolDef.name, {
          event: stepResult.transition,
          reason: transition.reason,
        });
        return {
          success: false,
          error: `Transition '${stepResult.transition}' failed: ${transition.reason}`,
        };
      }
      newState = transition.newState;
    }

    if (stepResult.contextUpdated) {
      this.persistence.updateContext(instanceId, context);
    }

    const resultPayload = stepResult.returned ? stepResult.data : stepResult.results;
    const auditPayload: Record<string, unknown> = {
      input: parsedInput,
      result: resultPayload,
    };
    if (idempotencyKey) {
      auditPayload.idempotency_key = idempotencyKey;
    }

    const auditId = this.persistence.logAudit(
      instanceId,
      "tool_succeeded",
      toolDef.name,
      auditPayload,
    );

    const response: ToolResult = {
      success: true,
      result: resultPayload,
      newState,
      auditId,
    };

    if (toolDef.requiresReadAfterWrite && toolDef.readTool) {
      const read = await this.executeTool(instanceId, toolDef.readTool, {});
      if (!read.success) {
        this.persistence.logAudit(
          instanceId,
          "read_after_write_failed",
          toolDef.name,
          {
            readTool: toolDef.readTool,
            error: read.error,
          },
        );
        return {
          success: false,
          error: `Read-after-write failed (${toolDef.readTool}): ${read.error}`,
        };
      }
      response.result = read.result;
    }

    return response;
  }

  private createStepExecutor(
    loaded: LoadedYamlWorkflow,
    instanceId?: string,
  ): StepExecutor {
    return new StepExecutor({
      sql: this.sqlExecutor,
      http: this.httpExecutor,
      workflowConfig: {
        db: loaded.config.db,
        api_base: loaded.config.api_base,
      },
      instanceId,
      logAudit: (eventType, payload, toolName, id) => {
        this.persistence.logAudit(id ?? null, eventType, toolName, payload);
      },
    });
  }

  private applyMigrations(loaded: LoadedYamlWorkflow): number[] {
    const migrations = [...(loaded.config.migrations ?? [])].sort(
      (a, b) => a.version - b.version,
    );

    const applied = new Set(
      this.persistence.getAppliedMigrations(loaded.definition.id),
    );

    const newlyApplied: number[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;

      const marker = this.sqlExecutor.executeScript(
        migration.sql,
        loaded.config.db,
      );
      if (marker.error) {
        throw new Error(
          `Migration ${migration.version} failed for workflow '${loaded.definition.id}': ${marker.message}`,
        );
      }

      this.persistence.markMigrationApplied(loaded.definition.id, migration.version);
      newlyApplied.push(migration.version);
    }

    return newlyApplied;
  }

  private buildYamlIdempotencyKey(
    template: string,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ): string {
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
      const value = key in input ? input[key] : context[key];
      if (value === undefined || value === null) {
        throw new Error(`Idempotency key template field '${key}' is missing`);
      }
      return String(value);
    });
  }

  private resolveOnErrorMessage(
    template: string | undefined,
    message: string,
  ): string {
    if (!template) return message;
    const scope: TemplateScope = { error: { message } };
    try {
      const resolved = resolveTemplate(template, scope);
      return typeof resolved === "string" ? resolved : message;
    } catch {
      return message;
    }
  }

  private topLevelState(state: string): string {
    const dot = state.indexOf(".");
    return dot === -1 ? state : state.slice(0, dot);
  }
}
