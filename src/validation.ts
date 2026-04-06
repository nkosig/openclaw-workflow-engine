import type {
  ValidationResult,
  IdempotencyResult,
} from './types.js'
import type { PersistenceLayer } from './persistence.js'
import type { WorkflowMachine } from './machine.js'

/**
 * Build an idempotency key by substituting {field} placeholders in a template with values from input.
 */
function buildKey(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_match, field: string) => {
    const val = input[field]
    if (val == null) {
      throw new Error(`Idempotency key template field '${field}' is missing from input`)
    }
    return String(val)
  })
}

/**
 * Validation layer: tool-call validation, transition payload validation, and idempotency checking.
 */
export class ValidationLayer {
  constructor(
    private machine: WorkflowMachine,
    private persistence: PersistenceLayer,
  ) {}

  /**
   * Validate a tool call:
   * 1. Check tool is available in the current state.
   * 2. Validate input against the tool's Zod schema.
   * Logs rejections to audit log automatically.
   */
  validateToolCall(
    instanceId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): ValidationResult {
    const availableTools = this.machine.getAvailableTools(instanceId)
    const tool = availableTools.find((t) => t.name === toolName)

    if (!tool) {
      const stateInfo = this.machine.getCurrentState(instanceId)
      const reason = `Tool '${toolName}' is not available in state '${stateInfo?.state ?? 'unknown'}'`
      this.persistence.logAudit(instanceId, 'tool_rejected', toolName, { reason, input })
      return { valid: false, reason }
    }

    const parseResult = tool.inputSchema.safeParse(input)
    if (!parseResult.success) {
      const reason = `Invalid input for tool '${toolName}': ${parseResult.error.message}`
      this.persistence.logAudit(instanceId, 'validation_failed', toolName, {
        reason,
        issues: parseResult.error.issues,
        input,
      })
      return { valid: false, reason }
    }

    return { valid: true, parsedInput: parseResult.data }
  }

  /**
   * Validate a transition event payload:
   * 1. Check the transition is valid from the current state (payload-aware for guarded machines).
   * 2. Validate payload against the per-state Zod schema from the workflow definition, if present.
   */
  validateTransitionPayload(
    instanceId: string,
    event: string,
    payload: Record<string, unknown>,
  ): ValidationResult {
    if (!this.machine.canTransition(instanceId, event, payload)) {
      const stateInfo = this.machine.getCurrentState(instanceId)
      const reason = `Transition '${event}' is not valid from state '${stateInfo?.state ?? 'unknown'}'`
      this.persistence.logAudit(instanceId, 'validation_failed', undefined, { reason, event })
      return { valid: false, reason }
    }

    const validationSchema = this.machine.getTransitionValidator(instanceId, event)
    if (validationSchema) {
      const parseResult = validationSchema.safeParse(payload)
      if (!parseResult.success) {
        const reason = `Invalid payload for transition '${event}': ${parseResult.error.message}`
        this.persistence.logAudit(instanceId, 'validation_failed', undefined, {
          reason,
          issues: parseResult.error.issues,
          payload,
        })
        return { valid: false, reason }
      }
      return { valid: true, parsedInput: parseResult.data }
    }

    return { valid: true, parsedInput: payload }
  }

  /**
   * Check whether a tool call with the given input is a duplicate based on the idempotency key template.
   * Scoped to the specific instance to prevent cross-instance collisions.
   * Returns the existing audit payload if a duplicate is found.
   */
  checkIdempotency(
    instanceId: string,
    toolName: string,
    input: Record<string, unknown>,
    template: string,
  ): IdempotencyResult {
    const key = buildKey(template, input)
    const existing = this.persistence.findByIdempotencyKey(instanceId, toolName, key)

    if (existing.length > 0) {
      const existingPayload = JSON.parse(existing[0].payload)
      return { duplicate: true, key, existingResult: existingPayload }
    }

    return { duplicate: false, key }
  }
}
