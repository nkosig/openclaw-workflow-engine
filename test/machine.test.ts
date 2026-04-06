import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMachine } from 'xstate'
import { z } from 'zod'
import { WorkflowMachine } from '../src/machine'
import { PersistenceLayer } from '../src/persistence'
import type { WorkflowDefinition } from '../src/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSimpleMachine(): WorkflowDefinition {
  return {
    id: 'simple',
    machine: createMachine({
      id: 'simple',
      initial: 'idle',
      states: {
        idle: { on: { START: 'running' } },
        running: { on: { STOP: 'stopped', PAUSE: 'paused' } },
        paused: { on: { RESUME: 'running', STOP: 'stopped' } },
        stopped: { type: 'final' },
      },
    }),
    toolsByState: {
      idle: [
        {
          name: 'init_tool',
          description: 'Init',
          inputSchema: z.object({ name: z.string() }),
        },
      ],
      running: [
        {
          name: 'run_tool',
          description: 'Run',
          inputSchema: z.object({ value: z.number() }),
        },
      ],
      paused: [],
      stopped: [],
    },
  }
}

let persistence: PersistenceLayer
let wm: WorkflowMachine

beforeEach(() => {
  persistence = new PersistenceLayer(':memory:')
  wm = new WorkflowMachine(persistence)
  wm.registerDefinition(makeSimpleMachine())
})

afterEach(() => {
  persistence.close()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowMachine', () => {
  it('creates an instance in the initial state', () => {
    const instance = wm.createInstance('simple')
    expect(instance.currentState).toBe('idle')
    expect(instance.workflowId).toBe('simple')
    expect(instance.instanceId).toBeTruthy()
  })

  it('valid transition succeeds and updates state', () => {
    const instance = wm.createInstance('simple')
    const result = wm.transition(instance.instanceId, 'START')
    expect(result.success).toBe(true)
    expect(result.newState).toBe('running')

    const state = wm.getCurrentState(instance.instanceId)
    expect(state?.state).toBe('running')
  })

  it('invalid transition is rejected with reason', () => {
    const instance = wm.createInstance('simple')
    // Can't go from idle → STOP
    const result = wm.transition(instance.instanceId, 'STOP')
    expect(result.success).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('detects final states correctly', () => {
    const instance = wm.createInstance('simple')
    wm.transition(instance.instanceId, 'START')
    expect(wm.isFinalState(instance.instanceId)).toBe(false)

    wm.transition(instance.instanceId, 'STOP')
    expect(wm.isFinalState(instance.instanceId)).toBe(true)
  })

  it('getAvailableTools returns only current state tools', () => {
    const instance = wm.createInstance('simple')
    const idleTools = wm.getAvailableTools(instance.instanceId)
    expect(idleTools.map((t) => t.name)).toEqual(['init_tool'])

    wm.transition(instance.instanceId, 'START')
    const runningTools = wm.getAvailableTools(instance.instanceId)
    expect(runningTools.map((t) => t.name)).toEqual(['run_tool'])
  })

  it('canTransition correctly reports valid events', () => {
    const instance = wm.createInstance('simple')
    expect(wm.canTransition(instance.instanceId, 'START')).toBe(true)
    expect(wm.canTransition(instance.instanceId, 'STOP')).toBe(false)
    expect(wm.canTransition(instance.instanceId, 'NONEXISTENT')).toBe(false)
  })

  it('canTransition updates correctly after transition', () => {
    const instance = wm.createInstance('simple')
    wm.transition(instance.instanceId, 'START')
    expect(wm.canTransition(instance.instanceId, 'START')).toBe(false)
    expect(wm.canTransition(instance.instanceId, 'STOP')).toBe(true)
    expect(wm.canTransition(instance.instanceId, 'PAUSE')).toBe(true)
  })

  it('creates instance with initial context', () => {
    const instance = wm.createInstance('simple', { userId: 'u1', mode: 'test' })
    expect(instance.instanceId).toBeTruthy()
    // Context is stored
    const state = wm.getCurrentState(instance.instanceId)
    expect(state).not.toBeNull()
  })

  it('multiple instances are independent', () => {
    const a = wm.createInstance('simple')
    const b = wm.createInstance('simple')

    wm.transition(a.instanceId, 'START')
    expect(wm.getCurrentState(a.instanceId)?.state).toBe('running')
    expect(wm.getCurrentState(b.instanceId)?.state).toBe('idle')
  })
})
