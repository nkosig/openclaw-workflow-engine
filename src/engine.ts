import { PersistenceLayer } from './persistence.js'
import { WorkflowMachine } from './machine.js'
import { ValidationLayer } from './validation.js'
import type {
  WorkflowDefinition,
  ToolDefinition,
  WorkflowInstance,
  ToolResult,
  WorkflowStatus,
  AuditEntry,
} from './types.js'

/**
 * Main workflow engine orchestrator.
 * Combines the state machine, persistence, and validation layers.
 */
export class WorkflowEngine {
  private persistence: PersistenceLayer
  private machine: WorkflowMachine
  private validation: ValidationLayer

  constructor(dbPath?: string) {
    this.persistence = new PersistenceLayer(dbPath)
    this.machine = new WorkflowMachine(this.persistence)
    this.validation = new ValidationLayer(this.machine, this.persistence)
  }

  /**
   * Register a workflow definition so it can be started via startWorkflow().
   */
  registerWorkflow(definition: WorkflowDefinition): void {
    this.machine.registerDefinition(definition)
  }

  /**
   * Start a new workflow instance. Returns the created instance.
   */
  startWorkflow(
    workflowId: string,
    context: Record<string, unknown> = {},
  ): WorkflowInstance {
    return this.machine.createInstance(workflowId, context)
  }

  /**
   * Find an active (non-final) instance for a workflow, enabling resume support.
   * Returns null if no active instance exists.
   */
  getActiveWorkflow(workflowId: string): WorkflowInstance | null {
    const row = this.persistence.getActiveInstance(workflowId)
    if (!row) return null
    return {
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      currentState: row.current_state,
      context: row.context ? JSON.parse(row.context) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Get the tools currently available for an instance (based on its current state).
   */
  getAvailableTools(instanceId: string): ToolDefinition[] {
    return this.machine.getAvailableTools(instanceId)
  }

  /**
   * Execute a tool call on a workflow instance.
   *
   * Steps:
   * 0. Reject immediately if the instance is final (reset/completed)
   * 1. Validate tool call (availability + Zod input schema)
   * 2. Check idempotency — return cached result if duplicate; surface template errors as { success: false }
   * 3. Validate result against validationsByState[state][toolName] if defined
   * 4. Log audit events (tool_called, tool_succeeded)
   * 5. Fire onSuccess transition if configured, advancing the state machine
   * 6. If requiresReadAfterWrite, execute the readTool in the new state; propagate read failure
   * 7. Return { success, result, newState, auditId }
   */
  async executeTool(
    instanceId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 0. Reject if the instance is final (completed or reset) — no tools may execute on closed instances
    if (this.machine.isFinalState(instanceId)) {
      return { success: false, error: `Instance '${instanceId}' is final and cannot accept tool calls` }
    }

    // 1. Validate tool call (availability + input schema)
    const validationResult = this.validation.validateToolCall(instanceId, toolName, input)
    if (!validationResult.valid) {
      return { success: false, error: validationResult.reason }
    }

    const availableTools = this.machine.getAvailableTools(instanceId)
    const toolDef = availableTools.find((t) => t.name === toolName)!

    // 2. Check idempotency (scoped to this instance); capture key once for audit log.
    // buildKey throws if a template field is missing from input — surface as structured error.
    let idempotencyKey: string | undefined
    if (toolDef.idempotencyKeyTemplate) {
      let idempotencyResult
      try {
        idempotencyResult = this.validation.checkIdempotency(
          instanceId,
          toolName,
          input,
          toolDef.idempotencyKeyTemplate,
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        this.persistence.logAudit(instanceId, 'validation_failed', toolName, { reason, input })
        return { success: false, error: reason }
      }
      idempotencyKey = idempotencyResult.key
      if (idempotencyResult.duplicate) {
        this.persistence.logAudit(instanceId, 'idempotency_hit', toolName, {
          idempotency_key: idempotencyResult.key,
          input,
        })
        return {
          success: true,
          result: idempotencyResult.existingResult,
          idempotencyHit: true,
          newState: this.machine.getCurrentState(instanceId)?.state,
        }
      }
    }

    // 3. Validate result against validationsByState[currentState][toolName] if defined.
    // In Phase 1, the "output" is parsedInput (tools have no executor yet); Phase 2 will
    // validate real executor return values here.
    const outputValidator = this.machine.getOutputValidator(instanceId, toolName)
    if (outputValidator) {
      const outputValidation = outputValidator.safeParse(validationResult.parsedInput)
      if (!outputValidation.success) {
        const reason = `Output validation failed for '${toolName}': ${outputValidation.error.message}`
        this.persistence.logAudit(instanceId, 'validation_failed', toolName, { reason })
        return { success: false, error: reason }
      }
    }

    // 4. Log audit events
    this.persistence.logAudit(instanceId, 'tool_called', toolName, { input })

    const auditPayload: Record<string, unknown> = { input: validationResult.parsedInput }
    if (idempotencyKey) auditPayload.idempotency_key = idempotencyKey

    const auditId = this.persistence.logAudit(instanceId, 'tool_succeeded', toolName, auditPayload)

    // 5. Fire onSuccess transition if configured
    let newState = this.machine.getCurrentState(instanceId)?.state
    if (toolDef.onSuccess) {
      const transitionResult = this.machine.transition(
        instanceId,
        toolDef.onSuccess,
        validationResult.parsedInput as Record<string, unknown>,
      )
      if (!transitionResult.success) {
        this.persistence.logAudit(instanceId, 'transition_failed', toolName, {
          event: toolDef.onSuccess,
          reason: transitionResult.reason,
        })
        return { success: false, error: `Transition '${toolDef.onSuccess}' failed: ${transitionResult.reason}` }
      }
      newState = transitionResult.newState
    }

    const result: ToolResult = {
      success: true,
      result: validationResult.parsedInput,
      newState,
      auditId,
    }

    // 6. Read-after-write runs in the new state (after transition)
    if (toolDef.requiresReadAfterWrite && toolDef.readTool) {
      const readResult = await this.executeTool(instanceId, toolDef.readTool, {})
      if (!readResult.success) {
        this.persistence.logAudit(instanceId, 'read_after_write_failed', toolName, {
          readTool: toolDef.readTool,
          error: readResult.error,
        })
        return {
          success: false,
          error: `Read-after-write failed (${toolDef.readTool}): ${readResult.error}`,
        }
      }
      result.result = readResult.result
    }

    return result
  }

  /**
   * Get the current status of a workflow instance.
   */
  getStatus(instanceId: string): WorkflowStatus {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) throw new Error(`Instance '${instanceId}' not found`)

    const availableTools = this.machine.getAvailableTools(instanceId)
    const context = row.context ? JSON.parse(row.context) : {}

    return {
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      currentState: row.current_state,
      isFinal: row.is_final === 1,
      availableTools,
      context,
    }
  }

  /**
   * Get the audit log for an instance.
   */
  getAuditLog(instanceId: string, limit: number = 100): AuditEntry[] {
    return this.persistence.getAuditLog(instanceId, limit)
  }

  /**
   * Cancel a workflow instance and allow a fresh start.
   * Marks the instance as final so getActiveWorkflow() will not return it.
   */
  resetWorkflow(instanceId: string): void {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) throw new Error(`Instance '${instanceId}' not found`)

    const snapshot = JSON.parse(row.xstate_snapshot)
    this.persistence.saveSnapshot(
      instanceId,
      snapshot,
      row.current_state,
      row.context ? JSON.parse(row.context) : {},
      true,
    )
    this.persistence.logAudit(instanceId, 'instance_reset', undefined, {
      previousState: row.current_state,
    })
  }

  /**
   * Close the database connection when done.
   */
  close(): void {
    this.persistence.close()
  }
}
