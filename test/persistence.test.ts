import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PersistenceLayer } from '../src/persistence'

let db: PersistenceLayer

beforeEach(() => {
  db = new PersistenceLayer(':memory:')
})

afterEach(() => {
  db.close()
})

describe('PersistenceLayer', () => {
  it('saves and loads a snapshot roundtrip preserving state', () => {
    const snapshot = { value: 'running', status: 'active', context: { x: 1 } }
    db.saveSnapshot('inst-1', snapshot, 'running', { x: 1 }, false, 'workflow-a')

    const loaded = db.loadSnapshot('inst-1')
    expect(loaded).not.toBeNull()
    expect(loaded!.current_state).toBe('running')
    expect(JSON.parse(loaded!.xstate_snapshot)).toEqual(snapshot)
    expect(loaded!.workflow_id).toBe('workflow-a')
  })

  it('updates an existing snapshot on second save', () => {
    db.saveSnapshot('inst-2', { value: 'idle' }, 'idle', {}, false, 'wf')
    db.saveSnapshot('inst-2', { value: 'running' }, 'running', { step: 1 }, false)

    const loaded = db.loadSnapshot('inst-2')
    expect(loaded!.current_state).toBe('running')
    expect(JSON.parse(loaded!.context!)).toEqual({ step: 1 })
  })

  it('multiple instances do not interfere', () => {
    db.saveSnapshot('inst-a', { v: 1 }, 'idle', {}, false, 'wf')
    db.saveSnapshot('inst-b', { v: 2 }, 'running', {}, false, 'wf')

    expect(db.loadSnapshot('inst-a')!.current_state).toBe('idle')
    expect(db.loadSnapshot('inst-b')!.current_state).toBe('running')
  })

  it('returns null for unknown instance', () => {
    expect(db.loadSnapshot('not-here')).toBeNull()
  })

  it('transition log captures all transitions and getTransitions retrieves them', () => {
    db.saveSnapshot('inst-3', {}, 'idle', {}, false, 'wf')
    db.logTransition('inst-3', 'idle', 'running', 'START', { userId: 1 }, true)
    db.logTransition('inst-3', 'running', 'running', 'BADSTOP', {}, false, 'not valid')

    const transitions = db.getTransitions('inst-3')
    expect(transitions.length).toBe(2)

    // Newest first
    expect(transitions[0].fromState).toBe('running')
    expect(transitions[0].event).toBe('BADSTOP')
    expect(transitions[0].valid).toBe(false)
    expect(transitions[0].rejectionReason).toBe('not valid')

    expect(transitions[1].fromState).toBe('idle')
    expect(transitions[1].toState).toBe('running')
    expect(transitions[1].event).toBe('START')
    expect(transitions[1].valid).toBe(true)
    expect(transitions[1].payload).toEqual({ userId: 1 })
  })

  it('audit log captures events', () => {
    db.saveSnapshot('inst-4', {}, 'idle', {}, false, 'wf')
    db.logAudit('inst-4', 'instance_created', undefined, { state: 'idle' })
    db.logAudit('inst-4', 'tool_called', 'my_tool', { input: {} })

    const log = db.getAuditLog('inst-4')
    expect(log.length).toBe(2)
    expect(log[0].eventType).toBe('tool_called') // newest first
    expect(log[1].eventType).toBe('instance_created')
  })

  it('getActiveInstance returns non-final instance', () => {
    db.saveSnapshot('inst-5', { v: 'active' }, 'running', {}, false, 'workflow-b')
    const active = db.getActiveInstance('workflow-b')
    expect(active).not.toBeNull()
    expect(active!.instance_id).toBe('inst-5')
  })

  it('getActiveInstance returns null when all instances are final', () => {
    db.saveSnapshot('inst-6', { v: 'done' }, 'completed', {}, true, 'workflow-c')
    const active = db.getActiveInstance('workflow-c')
    expect(active).toBeNull()
  })

  it('getActiveInstance ignores final instances from same workflow', () => {
    db.saveSnapshot('inst-7a', { v: 'done' }, 'completed', {}, true, 'workflow-d')
    db.saveSnapshot('inst-7b', { v: 'active' }, 'running', {}, false, 'workflow-d')
    const active = db.getActiveInstance('workflow-d')
    expect(active!.instance_id).toBe('inst-7b')
  })

  it('findByIdempotencyKey finds matching entry', () => {
    db.saveSnapshot('inst-8', {}, 'idle', {}, false, 'wf')
    db.logAudit('inst-8', 'tool_succeeded', 'log_set', {
      idempotency_key: 'sess_abc_bench_set1_80x8',
      result: { setId: 42 },
    })

    const found = db.findByIdempotencyKey('inst-8', 'log_set', 'sess_abc_bench_set1_80x8')
    expect(found.length).toBe(1)
  })

  it('findByIdempotencyKey returns empty for non-matching key', () => {
    const found = db.findByIdempotencyKey('inst-8', 'log_set', 'nonexistent-key')
    expect(found.length).toBe(0)
  })
})
