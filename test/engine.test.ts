import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMachine } from 'xstate'
import { z } from 'zod'
import { WorkflowEngine } from '../src/engine'
import type { WorkflowDefinition } from '../src/types'

function makePipelineWorkflow(): WorkflowDefinition {
  return {
    id: 'pipeline',
    machine: createMachine({
      id: 'pipeline',
      initial: 'init',
      states: {
        init: { on: { FETCH: 'fetching' } },
        fetching: { on: { PROCESS: 'processing', CANCEL: 'cancelled' } },
        processing: { on: { DONE: 'complete', CANCEL: 'cancelled' } },
        complete: { type: 'final' },
        cancelled: { type: 'final' },
      },
    }),
    toolsByState: {
      init: [
        {
          name: 'fetch_data',
          description: 'Fetch',
          inputSchema: z.object({ url: z.string() }),
          onSuccess: 'FETCH',
        },
      ],
      fetching: [
        {
          name: 'process_data',
          description: 'Process',
          inputSchema: z.object({ format: z.string() }),
          onSuccess: 'PROCESS',
        },
        {
          name: 'read_status',
          description: 'Read',
          inputSchema: z.object({}),
        },
      ],
      processing: [
        {
          name: 'complete_task',
          description: 'Complete',
          inputSchema: z.object({}),
          onSuccess: 'DONE',
        },
        {
          name: 'read_status',
          description: 'Read',
          inputSchema: z.object({}),
          requiresReadAfterWrite: false,
        },
      ],
      complete: [],
      cancelled: [],
    },
  }
}

function makeReadAfterWriteWorkflow(): WorkflowDefinition {
  return {
    id: 'raw-workflow',
    machine: createMachine({
      id: 'raw',
      initial: 'active',
      states: {
        active: { on: { DONE: 'complete' } },
        complete: { type: 'final' },
      },
    }),
    toolsByState: {
      active: [
        {
          name: 'write_data',
          description: 'Write something',
          inputSchema: z.object({ value: z.string() }),
          requiresReadAfterWrite: true,
          readTool: 'read_data',
        },
        {
          name: 'read_data',
          description: 'Read state',
          inputSchema: z.object({}),
        },
      ],
      complete: [],
    },
  }
}

let engine: WorkflowEngine

beforeEach(() => {
  engine = new WorkflowEngine(':memory:')
  engine.registerWorkflow(makePipelineWorkflow())
})

afterEach(() => {
  engine.close()
})

describe('WorkflowEngine', () => {
  it('register → start → execute tools → reach final state', async () => {
    const instance = engine.startWorkflow('pipeline')
    expect(instance.currentState).toBe('init')

    // fetch_data fires FETCH → transitions init → fetching
    let result = await engine.executeTool(instance.instanceId, 'fetch_data', { url: 'http://example.com' })
    expect(result.success).toBe(true)
    expect(result.newState).toBe('fetching')

    // process_data fires PROCESS → transitions fetching → processing
    result = await engine.executeTool(instance.instanceId, 'process_data', { format: 'json' })
    expect(result.success).toBe(true)
    expect(result.newState).toBe('processing')

    // complete_task fires DONE → transitions processing → complete (final)
    result = await engine.executeTool(instance.instanceId, 'complete_task', {})
    expect(result.success).toBe(true)
    expect(result.newState).toBe('complete')

    const status = engine.getStatus(instance.instanceId)
    expect(status.isFinal).toBe(true)
  })

  it('getAvailableTools changes as state progresses', async () => {
    const instance = engine.startWorkflow('pipeline')
    const initTools = engine.getAvailableTools(instance.instanceId)
    expect(initTools.map((t) => t.name)).toEqual(['fetch_data'])

    // fetch_data fires FETCH → transitions to fetching
    await engine.executeTool(instance.instanceId, 'fetch_data', { url: 'http://example.com' })
    const fetchingTools = engine.getAvailableTools(instance.instanceId)
    expect(fetchingTools.map((t) => t.name)).toContain('process_data')
  })

  it('getStatus returns correct info', () => {
    const instance = engine.startWorkflow('pipeline', { userId: 'u1' })
    const status = engine.getStatus(instance.instanceId)
    expect(status.instanceId).toBe(instance.instanceId)
    expect(status.workflowId).toBe('pipeline')
    expect(status.currentState).toBe('init')
    expect(status.isFinal).toBe(false)
  })

  it('getAuditLog returns entries after tool execution', async () => {
    const instance = engine.startWorkflow('pipeline')
    await engine.executeTool(instance.instanceId, 'fetch_data', { url: 'http://example.com' })

    const log = engine.getAuditLog(instance.instanceId)
    expect(log.length).toBeGreaterThan(0)
    const toolEvent = log.find((e) => e.toolName === 'fetch_data')
    expect(toolEvent).toBeTruthy()
  })

  it('executeTool rejects tool not available in current state', async () => {
    const instance = engine.startWorkflow('pipeline')
    // 'process_data' is only available in 'fetching' state
    const result = await engine.executeTool(instance.instanceId, 'process_data', { format: 'json' })
    expect(result.success).toBe(false)
    expect(result.error).toContain("'process_data'")
  })

  it('executeTool rejects invalid input', async () => {
    const instance = engine.startWorkflow('pipeline')
    // 'fetch_data' needs a url string
    const result = await engine.executeTool(instance.instanceId, 'fetch_data', {})
    expect(result.success).toBe(false)
  })

  it('concurrent instances of same workflow do not interfere', async () => {
    const a = engine.startWorkflow('pipeline', { user: 'alice' })
    const b = engine.startWorkflow('pipeline', { user: 'bob' })

    await engine.executeTool(a.instanceId, 'fetch_data', { url: 'http://a.com' })
    // b should still be in init state with no audit entries for fetch_data
    const statusB = engine.getStatus(b.instanceId)
    expect(statusB.currentState).toBe('init')

    const logA = engine.getAuditLog(a.instanceId)
    const logB = engine.getAuditLog(b.instanceId)
    // a has more entries than b (b only has instance_created)
    const aToolCalls = logA.filter((e) => e.eventType === 'tool_called')
    const bToolCalls = logB.filter((e) => e.eventType === 'tool_called')
    expect(aToolCalls.length).toBe(1)
    expect(bToolCalls.length).toBe(0)
  })

  it('resetWorkflow cancels and allows fresh start', () => {
    const instance = engine.startWorkflow('pipeline')
    engine.resetWorkflow(instance.instanceId)

    const status = engine.getStatus(instance.instanceId)
    expect(status.isFinal).toBe(true)

    // Now getActiveWorkflow should return null (no active instance)
    const active = engine.getActiveWorkflow('pipeline')
    expect(active).toBeNull()
  })

  it('getActiveWorkflow resumes an existing instance', () => {
    const instance = engine.startWorkflow('pipeline')

    // Simulate engine restart by creating a new engine with same DB
    // (we use :memory: here so we test getActiveWorkflow with current engine)
    const active = engine.getActiveWorkflow('pipeline')
    expect(active).not.toBeNull()
    expect(active!.instanceId).toBe(instance.instanceId)
  })

  it('read-after-write: tool marked requiresReadAfterWrite triggers automatic read', async () => {
    const rawEngine = new WorkflowEngine(':memory:')
    rawEngine.registerWorkflow(makeReadAfterWriteWorkflow())

    const instance = rawEngine.startWorkflow('raw-workflow')
    const result = await rawEngine.executeTool(instance.instanceId, 'write_data', { value: 'hello' })

    // Should succeed and the result should be from the read_data call
    expect(result.success).toBe(true)
    // The engine should have called read_data internally
    const log = rawEngine.getAuditLog(instance.instanceId)
    const readCalls = log.filter((e) => e.toolName === 'read_data')
    expect(readCalls.length).toBeGreaterThan(0)

    rawEngine.close()
  })

  it('resume: create instance, close engine, reopen with same DB, find active instance', async () => {
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { unlinkSync } = await import('fs')
    const dbPath = join(tmpdir(), `resume-test-${Date.now()}.db`)

    const engine1 = new WorkflowEngine(dbPath)
    engine1.registerWorkflow(makePipelineWorkflow())
    const instance = engine1.startWorkflow('pipeline', { resumeTest: true })
    const instanceId = instance.instanceId
    engine1.close()

    // Simulate engine restart with the same DB file
    const engine2 = new WorkflowEngine(dbPath)
    engine2.registerWorkflow(makePipelineWorkflow())

    const active = engine2.getActiveWorkflow('pipeline')
    expect(active).not.toBeNull()
    expect(active!.instanceId).toBe(instanceId)
    expect(active!.currentState).toBe('init')
    engine2.close()

    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(dbPath + suffix) } catch {}
    }
  })

  it('executeTool returns failure when onSuccess event is not valid from current state', async () => {
    // Add a tool with an onSuccess event that can never fire from init
    const badEngine = new WorkflowEngine(':memory:')
    badEngine.registerWorkflow({
      ...makePipelineWorkflow(),
      id: 'bad-pipeline',
      toolsByState: {
        ...makePipelineWorkflow().toolsByState,
        init: [
          {
            name: 'fetch_data',
            description: 'Fetch',
            inputSchema: z.object({ url: z.string() }),
            onSuccess: 'NONEXISTENT_EVENT',
          },
        ],
      },
    })
    const instance = badEngine.startWorkflow('bad-pipeline')
    const result = await badEngine.executeTool(instance.instanceId, 'fetch_data', { url: 'http://example.com' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('NONEXISTENT_EVENT')
    badEngine.close()
  })

  it('idempotency returns original result even after multiple duplicate hits', async () => {
    const idempEngine = new WorkflowEngine(':memory:')
    idempEngine.registerWorkflow({
      id: 'idemp-workflow',
      machine: createMachine({
        id: 'idemp',
        initial: 'active',
        states: { active: { on: { DONE: 'complete' } }, complete: { type: 'final' } },
      }),
      toolsByState: {
        active: [{
          name: 'write_data',
          description: 'Write',
          inputSchema: z.object({ key: z.string() }),
          idempotencyKeyTemplate: '{key}',
        }],
        complete: [],
      },
    })
    const instance = idempEngine.startWorkflow('idemp-workflow')

    // First call — succeeds
    const first = await idempEngine.executeTool(instance.instanceId, 'write_data', { key: 'abc' })
    expect(first.success).toBe(true)
    expect(first.idempotencyHit).toBeUndefined()

    // Second call — idempotency hit, returns tool_succeeded payload
    const second = await idempEngine.executeTool(instance.instanceId, 'write_data', { key: 'abc' })
    expect(second.success).toBe(true)
    expect(second.idempotencyHit).toBe(true)

    // Third call — still returns the same tool_succeeded payload (not idempotency_hit metadata)
    // Fix 1: findByIdempotencyKey only matches tool_succeeded rows, so repeated hits
    // never return the idempotency_hit row written in step 2.
    const third = await idempEngine.executeTool(instance.instanceId, 'write_data', { key: 'abc' })
    expect(third.success).toBe(true)
    expect(third.idempotencyHit).toBe(true)
    expect(third.result).toEqual(second.result)

    idempEngine.close()
  })
})
