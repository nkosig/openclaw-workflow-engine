import { createActor } from 'xstate'
import { randomUUID } from 'crypto'
import type {
  WorkflowDefinition,
  ToolDefinition,
  WorkflowInstance,
  TransitionResult,
  InstanceRow,
} from './types.js'
import type { PersistenceLayer } from './persistence.js'

/**
 * XState v5 wrapper that manages workflow state machines.
 * Recreates actors from persisted snapshots on every operation (stateless design).
 */
export class WorkflowMachine {
  private definitions = new Map<string, WorkflowDefinition>()

  constructor(private persistence: PersistenceLayer) {}

  /**
   * Register a workflow definition so instances can be created from it.
   */
  registerDefinition(definition: WorkflowDefinition): void {
    this.definitions.set(definition.id, definition)
  }

  /**
   * Create a new workflow instance, persist its initial snapshot, and return the instance ID.
   */
  createInstance(
    workflowId: string,
    initialContext: Record<string, unknown> = {},
  ): WorkflowInstance {
    const definition = this.getDefinition(workflowId)
    const instanceId = randomUUID()

    const actor = createActor(definition.machine, {
      input: initialContext,
    })
    actor.start()

    const snapshot = actor.getSnapshot()
    const persistedSnapshot = actor.getPersistedSnapshot()
    const currentState = this.resolveStateValue(snapshot.value)

    actor.stop()

    this.persistence.saveSnapshot(
      instanceId,
      persistedSnapshot as object,
      currentState,
      initialContext,
      snapshot.status === 'done',
      workflowId,
    )

    this.persistence.logAudit(instanceId, 'instance_created', undefined, {
      workflowId,
      initialState: currentState,
    })

    const row = this.persistence.loadSnapshot(instanceId)!
    return this.rowToInstance(row)
  }

  /**
   * Get the tools available in the current state of an instance.
   * Returns an empty array for final or reset instances.
   */
  getAvailableTools(instanceId: string): ToolDefinition[] {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) return []
    if (row.is_final) return []

    const definition = this.getDefinition(row.workflow_id)
    return definition.toolsByState[this.topLevelState(row.current_state)] ?? []
  }

  /**
   * Check whether an event would be accepted from the current state.
   */
  canTransition(instanceId: string, event: string, payload?: Record<string, unknown>): boolean {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) return false

    const definition = this.getDefinition(row.workflow_id)
    const persistedSnapshot = JSON.parse(row.xstate_snapshot)

    const actor = createActor(definition.machine, { snapshot: persistedSnapshot })
    actor.start()
    const can = actor.getSnapshot().can({ type: event, ...(payload ?? {}) })
    actor.stop()
    return can
  }

  /**
   * Execute a state transition. Validates the event, persists the new snapshot, and logs the change.
   */
  transition(
    instanceId: string,
    event: string,
    payload: Record<string, unknown> = {},
  ): TransitionResult {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) {
      return { success: false, reason: `Instance ${instanceId} not found` }
    }

    const definition = this.getDefinition(row.workflow_id)
    const persistedSnapshot = JSON.parse(row.xstate_snapshot)
    const fromState = row.current_state

    const actor = createActor(definition.machine, { snapshot: persistedSnapshot })
    actor.start()

    const snapshot = actor.getSnapshot()
    if (!snapshot.can({ type: event, ...payload })) {
      actor.stop()
      this.persistence.logTransition(instanceId, fromState, fromState, event, payload, false, `Event '${event}' is not valid in state '${fromState}'`)
      return {
        success: false,
        reason: `Event '${event}' is not valid in state '${fromState}'`,
      }
    }

    // Validate payload against validationsByState[fromState][event] if defined
    const payloadSchema = definition.validationsByState?.[this.topLevelState(fromState)]?.[event]
    if (payloadSchema) {
      const payloadValidation = payloadSchema.safeParse(payload)
      if (!payloadValidation.success) {
        actor.stop()
        const reason = `Payload validation failed for event '${event}': ${payloadValidation.error.message}`
        this.persistence.logTransition(instanceId, fromState, fromState, event, payload, false, reason)
        this.persistence.logAudit(instanceId, 'validation_failed', undefined, { reason, event, payload })
        return { success: false, reason }
      }
    }

    actor.send({ type: event, ...payload })
    const newSnapshot = actor.getSnapshot()
    const newState = this.resolveStateValue(newSnapshot.value)
    const isFinal = newSnapshot.status === 'done'
    const newPersistedSnapshot = actor.getPersistedSnapshot()
    actor.stop()

    const context = (newSnapshot.context ?? {}) as Record<string, unknown>
    this.persistence.saveSnapshot(
      instanceId,
      newPersistedSnapshot as object,
      newState,
      context,
      isFinal,
    )
    this.persistence.logTransition(instanceId, fromState, newState, event, payload, true)

    if (isFinal) {
      this.persistence.logAudit(instanceId, 'instance_completed', undefined, { finalState: newState })
    } else {
      this.persistence.logAudit(instanceId, 'state_changed', undefined, { fromState, toState: newState, event })
    }

    return { success: true, newState }
  }

  /**
   * Get the current state name and context for an instance.
   */
  getCurrentState(instanceId: string): { state: string; context: Record<string, unknown> } | null {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) return null
    return {
      state: row.current_state,
      context: row.context ? JSON.parse(row.context) : {},
    }
  }

  /**
   * Return the Zod payload validator for a transition event in the current state, or null if none.
   * Keyed by validationsByState[currentState][eventName].
   */
  getTransitionValidator(instanceId: string, event: string): import('zod').ZodSchema | null {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) return null
    const definition = this.getDefinition(row.workflow_id)
    return definition.validationsByState?.[this.topLevelState(row.current_state)]?.[event] ?? null
  }

  /**
   * Return the Zod output validator for a tool in the current state, or null if none is defined.
   * Keyed by validationsByState[currentState][toolName]. Called by executeTool() at step 3.
   * In Phase 1 this validates parsedInput as a proxy for output; Phase 2 will pass the real
   * tool executor return value.
   */
  getOutputValidator(instanceId: string, toolName: string): import('zod').ZodSchema | null {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) return null
    const definition = this.getDefinition(row.workflow_id)
    return definition.validationsByState?.[this.topLevelState(row.current_state)]?.[toolName] ?? null
  }

  /**
   * Return true if the instance is in a final XState state.
   */
  isFinalState(instanceId: string): boolean {
    const row = this.persistence.loadSnapshot(instanceId)
    if (!row) return false
    return row.is_final === 1
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private getDefinition(workflowId: string): WorkflowDefinition {
    const def = this.definitions.get(workflowId)
    if (!def) throw new Error(`Workflow definition '${workflowId}' is not registered`)
    return def
  }

  /**
   * Serialize XState state value to a dotted-path string.
   * Flat: 'idle' → 'idle'. Nested: { active: 'logging' } → 'active.logging'.
   * For parallel states only the first region is used (parallel support is a Phase 2 concern).
   */
  private resolveStateValue(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length > 0) {
        const [key, child] = entries[0]
        const childStr = this.resolveStateValue(child)
        return childStr ? `${key}.${childStr}` : key
      }
    }
    return String(value)
  }

  /**
   * Extract the top-level state name for toolsByState / validationsByState lookups.
   * 'active.logging' → 'active'. Flat states are returned unchanged.
   */
  private topLevelState(state: string): string {
    const dot = state.indexOf('.')
    return dot === -1 ? state : state.slice(0, dot)
  }

  private rowToInstance(row: InstanceRow): WorkflowInstance {
    return {
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      currentState: row.current_state,
      context: row.context ? JSON.parse(row.context) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
