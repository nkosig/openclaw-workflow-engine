import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WorkflowEngine } from '../src/engine'
import { WorkflowMachine } from '../src/machine'
import { PersistenceLayer } from '../src/persistence'
import { workoutCoachWorkflow } from '../examples/workout-coach'

let engine: WorkflowEngine

beforeEach(() => {
  engine = new WorkflowEngine(':memory:')
  engine.registerWorkflow(workoutCoachWorkflow)
})

afterEach(() => {
  engine.close()
})

// Helper for tests that need direct machine access (error-case setup, edge cases)
function getMachineAndDb() {
  const pdb = new PersistenceLayer(':memory:')
  const wm = new WorkflowMachine(pdb)
  wm.registerDefinition(workoutCoachWorkflow)
  return { pdb, wm }
}

describe('Workout Coach workflow — happy path', () => {
  it('starts from idle state', () => {
    const instance = engine.startWorkflow('workout-coach')
    expect(instance.currentState).toBe('idle')
  })

  it('get_next_workout tool is available from idle', () => {
    const instance = engine.startWorkflow('workout-coach')
    const tools = engine.getAvailableTools(instance.instanceId)
    expect(tools.map((t) => t.name)).toContain('get_next_workout')
  })

  it('full happy path: idle → showing_next_workout → exercise_active → set_logged → workout_completed', async () => {
    const instance = engine.startWorkflow('workout-coach')
    expect(instance.currentState).toBe('idle')

    // get_next_workout fires GET_NEXT_WORKOUT → idle → showing_next_workout
    let result = await engine.executeTool(instance.instanceId, 'get_next_workout', {})
    expect(result.success).toBe(true)
    expect(result.newState).toBe('showing_next_workout')

    // start_workout_session fires START_SESSION → showing_next_workout → workout_started
    result = await engine.executeTool(instance.instanceId, 'start_workout_session', {
      template_id: 'bench-press',
      idempotency_key: 'sess_001',
    })
    expect(result.success).toBe(true)
    expect(result.newState).toBe('workout_started')

    // begin_exercise fires BEGIN_EXERCISE → workout_started → exercise_active
    result = await engine.executeTool(instance.instanceId, 'begin_exercise', {})
    expect(result.success).toBe(true)
    expect(result.newState).toBe('exercise_active')

    // log_set fires LOG_SET → exercise_active → set_logged (+ auto read_data via read-after-write)
    result = await engine.executeTool(instance.instanceId, 'log_set', {
      weight_kg: 80,
      reps: 8,
      idempotency_key: 'set_001',
    })
    expect(result.success).toBe(true)
    expect(result.newState).toBe('set_logged')

    // finish_workout_session fires FINISH → set_logged → workout_completed (final)
    result = await engine.executeTool(instance.instanceId, 'finish_workout_session', {})
    expect(result.success).toBe(true)
    expect(result.newState).toBe('workout_completed')

    const status = engine.getStatus(instance.instanceId)
    expect(status.isFinal).toBe(true)
  })
})

describe('Workout Coach workflow — error cases', () => {
  it('cannot log_set (tool call) from idle state', async () => {
    const instance = engine.startWorkflow('workout-coach')
    const result = await engine.executeTool(instance.instanceId, 'log_set', {
      weight_kg: 80,
      reps: 8,
      idempotency_key: 'sess_abc_bench_set1_80x8',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("'log_set'")
  })

  it('cannot start_workout_session when already in exercise_active', () => {
    const { pdb, wm } = getMachineAndDb()
    const inst = wm.createInstance('workout-coach')

    wm.transition(inst.instanceId, 'GET_NEXT_WORKOUT')
    wm.transition(inst.instanceId, 'START_SESSION')
    wm.transition(inst.instanceId, 'BEGIN_EXERCISE')
    expect(wm.getCurrentState(inst.instanceId)?.state).toBe('exercise_active')

    const result = wm.transition(inst.instanceId, 'START_SESSION')
    expect(result.success).toBe(false)

    pdb.close()
  })

  it('log_set with missing weight is rejected by Zod', async () => {
    const { pdb, wm } = getMachineAndDb()
    const inst = wm.createInstance('workout-coach')

    wm.transition(inst.instanceId, 'GET_NEXT_WORKOUT')
    wm.transition(inst.instanceId, 'START_SESSION')
    wm.transition(inst.instanceId, 'BEGIN_EXERCISE')

    const { ValidationLayer } = await import('../src/validation')
    const vl = new ValidationLayer(wm, pdb)

    const result = vl.validateToolCall(inst.instanceId, 'log_set', {
      reps: 8,
      idempotency_key: 'sess_1',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("'log_set'")

    pdb.close()
  })

  it('duplicate idempotency key returns existing result', async () => {
    const { pdb, wm } = getMachineAndDb()
    const inst = wm.createInstance('workout-coach')

    wm.transition(inst.instanceId, 'GET_NEXT_WORKOUT')
    wm.transition(inst.instanceId, 'START_SESSION')
    wm.transition(inst.instanceId, 'BEGIN_EXERCISE')

    const { ValidationLayer } = await import('../src/validation')
    const vl = new ValidationLayer(wm, pdb)

    const key = 'sess_abc_bench_set1_80x8'
    pdb.logAudit(inst.instanceId, 'tool_succeeded', 'log_set', {
      idempotency_key: key,
      result: { setId: 1, success: true },
    })

    const log_set_tool = wm.getAvailableTools(inst.instanceId).find((t) => t.name === 'log_set')!
    const idem = vl.checkIdempotency(
      inst.instanceId,
      'log_set',
      { idempotency_key: key },
      log_set_tool.idempotencyKeyTemplate!,
    )

    expect(idem.duplicate).toBe(true)
    expect(idem.existingResult).toBeTruthy()

    pdb.close()
  })

  it.each([
    { label: 'showing_next_workout', setup: ['GET_NEXT_WORKOUT'] },
    { label: 'workout_started',      setup: ['GET_NEXT_WORKOUT', 'START_SESSION'] },
    { label: 'exercise_active',      setup: ['GET_NEXT_WORKOUT', 'START_SESSION', 'BEGIN_EXERCISE'] },
    { label: 'set_logged',           setup: ['GET_NEXT_WORKOUT', 'START_SESSION', 'BEGIN_EXERCISE', 'LOG_SET'] },
  ])('cancel_workout_session from $label reaches cancelled (final)', ({ label, setup }) => {
    const { pdb, wm } = getMachineAndDb()
    const inst = wm.createInstance('workout-coach')

    for (const event of setup) wm.transition(inst.instanceId, event)
    expect(wm.getCurrentState(inst.instanceId)?.state).toBe(label)

    const result = wm.transition(inst.instanceId, 'CANCEL')
    expect(result.success).toBe(true)
    expect(result.newState).toBe('cancelled')
    expect(wm.isFinalState(inst.instanceId)).toBe(true)

    pdb.close()
  })

  it('get_current_session available from every non-idle state', () => {
    const { pdb, wm } = getMachineAndDb()
    const inst = wm.createInstance('workout-coach')

    // idle — should NOT have get_current_session
    let tools = wm.getAvailableTools(inst.instanceId)
    expect(tools.map((t) => t.name)).not.toContain('get_current_session')

    // showing_next_workout
    wm.transition(inst.instanceId, 'GET_NEXT_WORKOUT')
    tools = wm.getAvailableTools(inst.instanceId)
    expect(tools.map((t) => t.name)).toContain('get_current_session')

    // workout_started
    wm.transition(inst.instanceId, 'START_SESSION')
    tools = wm.getAvailableTools(inst.instanceId)
    expect(tools.map((t) => t.name)).toContain('get_current_session')

    // exercise_active
    wm.transition(inst.instanceId, 'BEGIN_EXERCISE')
    tools = wm.getAvailableTools(inst.instanceId)
    expect(tools.map((t) => t.name)).toContain('get_current_session')

    // set_logged
    wm.transition(inst.instanceId, 'LOG_SET')
    tools = wm.getAvailableTools(inst.instanceId)
    expect(tools.map((t) => t.name)).toContain('get_current_session')

    pdb.close()
  })
})
