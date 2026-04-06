import type { ZodSchema } from 'zod'
import type { AnyStateMachine } from 'xstate'

/** Definition of a single tool available within the workflow */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ZodSchema
  /** If true, engine automatically calls readTool after a successful write */
  requiresReadAfterWrite?: boolean
  /** Which tool name to call for the automatic read */
  readTool?: string
  /** Template for idempotency key, e.g. '{session_id}_{exercise_id}_set{set_number}_{weight_kg}x{reps}' */
  idempotencyKeyTemplate?: string
  /** XState event type to fire on successful execution, advancing the state machine */
  onSuccess?: string
}

/** Full workflow definition combining XState machine + tool/prompt metadata */
export interface WorkflowDefinition {
  id: string
  /** XState v5 state machine */
  machine: AnyStateMachine
  /** Tools available per state — key is state name */
  toolsByState: Record<string, ToolDefinition[]>
  /** Optional system-prompt fragment injected per state */
  promptsByState?: Record<string, string>
  /**
   * Per-state Zod validators with two distinct uses, distinguished by key type:
   *
   * - Keyed by XState event name → transition-payload validator, enforced by
   *   WorkflowMachine.transition() via getTransitionValidator().
   * - Keyed by tool name → output validator, enforced by executeTool() via
   *   getOutputValidator(). In Phase 1, parsedInput is used as the output proxy;
   *   Phase 2 will validate real tool executor return values.
   */
  validationsByState?: Record<string, Record<string, ZodSchema>>
}

/** A running workflow instance */
export interface WorkflowInstance {
  instanceId: string
  workflowId: string
  currentState: string
  context: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** Result returned from executeTool */
export interface ToolResult {
  success: boolean
  result?: unknown
  error?: string
  newState?: string
  auditId?: number
  /** True when an existing idempotent result was returned instead of re-executing */
  idempotencyHit?: boolean
}

/** Snapshot of a workflow instance's current status */
export interface WorkflowStatus {
  instanceId: string
  workflowId: string
  currentState: string
  isFinal: boolean
  availableTools: ToolDefinition[]
  context: Record<string, unknown>
}

/** A single entry in the audit log */
export interface AuditEntry {
  id: number
  instanceId: string | null
  eventType: string
  toolName: string | null
  payload: unknown
  createdAt: string
}

/** Result of a state machine transition */
export interface TransitionResult {
  success: boolean
  newState?: string
  reason?: string
}

/** Result of input validation */
export interface ValidationResult {
  valid: boolean
  parsedInput?: unknown
  reason?: string
}

/** Result of idempotency check */
export interface IdempotencyResult {
  duplicate: boolean
  /** Always present — the computed key regardless of whether it was a duplicate */
  key: string
  existingResult?: unknown
}

/** Row returned from persistence for a workflow instance */
export interface InstanceRow {
  instance_id: string
  workflow_id: string
  current_state: string
  xstate_snapshot: string
  context: string | null
  is_final: number
  created_at: string
  updated_at: string
}
