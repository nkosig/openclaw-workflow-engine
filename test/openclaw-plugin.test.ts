/**
 * Tests for src/openclaw-plugin.ts.
 *
 * Because @openclaw/sdk is not published on npm the tests use a local
 * MockOpenClawApi that mirrors the OpenClawPluginApi interface.
 *
 * Manual verification checklist (run against a real OpenClaw 2026.4.x instance):
 *   □ Plugin appears in `openclaw plugins list` after installation
 *   □ workflow_list tool is visible in the tool panel
 *   □ beforePromptConstruct injects the correct state fragment into system prompt
 *   □ Calling a tool not in the current state is blocked with a clear error message
 *   □ After a valid tool call, workflow_status reflects the next state
 *   □ enableDashboard: true — dashboard renders at http://localhost:3847
 *   □ MCP side-car responds to tools/list via stdio
 */

import { describe, it, expect } from "vitest";
import { createMachine } from "xstate";
import { z } from "zod";
import register, {
  type OpenClawPluginApi,
  type PluginConfig,
  type PromptConstructContext,
  type ToolCallContext,
  type ServiceInstance,
  type WorkflowServiceInstance,
  OpenClawTool,
  type McpServerRegistration,
  type ToolGuardResult,
} from "../src/openclaw-plugin.js";
import type { WorkflowDefinition } from "../src/types.js";

// ── Minimal two-state workflow ─────────────────────────────────────────────────

const testWorkflow: WorkflowDefinition = {
  id: "plug-test",
  machine: createMachine({
    id: "plugTest",
    initial: "step_a",
    states: {
      step_a: { on: { ADVANCE: "step_b" } },
      step_b: { on: { COMPLETE: "done" } },
      done: { type: "final" },
    },
  }),
  toolsByState: {
    step_a: [
      {
        name: "do_a",
        description: "Do step A",
        inputSchema: z.object({ value: z.string() }),
        onSuccess: "ADVANCE",
      },
    ],
    step_b: [
      {
        name: "do_b",
        description: "Do step B",
        inputSchema: z.object({}),
        onSuccess: "COMPLETE",
      },
    ],
  },
  promptsByState: {
    step_a: "You are in step A. Call do_a to proceed.",
    step_b: "You are in step B. Call do_b to finish.",
  },
};

const workoutWorkflow: WorkflowDefinition = {
  id: "workout-coach",
  machine: createMachine({
    id: "workoutCoach",
    initial: "idle",
    states: {
      idle: { on: { GET_NEXT_WORKOUT: "showing_next_workout" } },
      showing_next_workout: {
        on: {
          START_SESSION: "exercise_active",
          CANCEL: "cancelled",
        },
      },
      exercise_active: {
        on: {
          LOG_SET: "exercise_active",
          SKIP_EXERCISE: "exercise_active",
          FINISH: "workout_completed",
          CANCEL: "cancelled",
        },
      },
      workout_completed: { type: "final" },
      cancelled: { type: "final" },
    },
  }),
  toolsByState: {
    idle: [
      {
        name: "get_next_workout",
        description: "Get next workout",
        inputSchema: z.object({}),
        onSuccess: "GET_NEXT_WORKOUT",
      },
    ],
    showing_next_workout: [
      {
        name: "start_workout_session",
        description: "Start workout session",
        inputSchema: z.object({
          template_id: z.string(),
          idempotency_key: z.string(),
        }),
        onSuccess: "START_SESSION",
      },
      {
        name: "get_current_session",
        description: "Get active session",
        inputSchema: z.object({}),
      },
      {
        name: "cancel_workout_session",
        description: "Cancel workout session",
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        onSuccess: "CANCEL",
      },
    ],
    exercise_active: [
      {
        name: "get_current_session",
        description: "Get active session",
        inputSchema: z.object({}),
      },
      {
        name: "log_set",
        description: "Log set",
        inputSchema: z.object({
          weight_kg: z.number().positive(),
          reps: z.number().int().positive(),
          rpe: z.number().min(1).max(10).optional(),
          idempotency_key: z.string(),
        }),
        requiresReadAfterWrite: true,
        readTool: "get_current_session",
        onSuccess: "LOG_SET",
      },
      {
        name: "skip_exercise",
        description: "Skip exercise",
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        onSuccess: "SKIP_EXERCISE",
      },
      {
        name: "finish_workout_session",
        description: "Finish workout",
        inputSchema: z.object({}),
        onSuccess: "FINISH",
      },
      {
        name: "cancel_workout_session",
        description: "Cancel workout session",
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        onSuccess: "CANCEL",
      },
    ],
    workout_completed: [],
    cancelled: [],
  },
};

// ── Mock OpenClaw Plugin API ───────────────────────────────────────────────────

type HookName = "beforePromptConstruct" | "beforeToolCall" | "afterToolCall";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (...args: any[]) => Promise<any>;

class MockOpenClawApi implements OpenClawPluginApi {
  readonly config: PluginConfig;
  readonly tools = new Map<string, OpenClawTool>();
  readonly hooks = new Map<HookName, HandlerFn[]>();
  readonly services = new Map<string, ServiceInstance>();
  readonly mcpServers: McpServerRegistration[] = [];

  constructor(config: PluginConfig = {}) {
    this.config = config;
  }

  registerService(service: ServiceInstance): void {
    this.services.set(service.id, service);
  }

  registerTool(tool: OpenClawTool): void {
    this.tools.set(tool.name, tool);
  }

  // Single implementation satisfies all three registerHook overloads
  registerHook(event: HookName, handler: HandlerFn): void {
    const list = this.hooks.get(event) ?? [];
    list.push(handler);
    this.hooks.set(event, list);
  }

  registerMcpServer(options: McpServerRegistration): void {
    this.mcpServers.push(options);
  }

  /** Invoke the first registered handler for a hook event */
  async callHook<T>(event: HookName, ...args: unknown[]): Promise<T> {
    const [handler] = this.hooks.get(event) ?? [];
    if (!handler) throw new Error(`No handler registered for ${event}`);
    return handler(...args) as Promise<T>;
  }

  /** Invoke a registered tool handler via the real OpenClaw execute() shape */
  async callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`No tool '${name}' registered`);
    const response = await tool.execute("mock-call-id", input);
    // Tests that inspect the result expect the unwrapped details value, not the
    // MCP content wrapper — return details when present, otherwise parse text.
    if (response.details !== undefined) return response.details;
    const text = response.content[0]?.text ?? "{}";
    try { return JSON.parse(text); } catch { return text; }
  }
}

// ── Test context factory ───────────────────────────────────────────────────────

/**
 * Create a MockOpenClawApi, call register(), start the service (in-memory DB,
 * no filesystem scan because workflowsDir points to a nonexistent path with
 * silent: true), then register testWorkflow directly on the engine.
 */
async function createCtx(extraConfig: PluginConfig = {}): Promise<{
  api: MockOpenClawApi;
  service: WorkflowServiceInstance;
}> 
{
  const api = new MockOpenClawApi({
    dbPath: ":memory:",
    // Nonexistent path → loadWorkflowsFromDir returns [] silently
    workflowsDir: "/nonexistent-path-for-tests",
    ...extraConfig,
  });
  register(api);

  const service = api.services.get(
    "workflow-engine",
  ) as WorkflowServiceInstance;
  await service.start();

  // Register the test workflow directly, bypassing the filesystem
  service.engine.registerWorkflow(testWorkflow);

  return { api, service };
}

// ── Registration tests ─────────────────────────────────────────────────────────

describe("openclaw-plugin — registration", () => {
  it("registers control tools plus direct workout tools", async () => {
    const { api } = await createCtx();
    expect([...api.tools.keys()].sort()).toEqual([
      "cancel_workout_session",
      "finish_workout_session",
      "get_current_session",
      "get_next_workout",
      "log_set",
      "skip_exercise",
      "start_workout_session",
      "workflow_audit",
      "workflow_list",
      "workflow_reset",
      "workflow_start",
      "workflow_status",
    ]);
  });

  it("registers all three lifecycle hooks", async () => {
    const { api } = await createCtx();
    expect(api.hooks.has("beforePromptConstruct")).toBe(true);
    expect(api.hooks.has("beforeToolCall")).toBe(true);
    expect(api.hooks.has("afterToolCall")).toBe(true);
  });

  it("registers the workflow-engine background service", async () => {
    const { api } = await createCtx();
    expect(api.services.has("workflow-engine")).toBe(true);
    const svc = api.services.get("workflow-engine") as WorkflowServiceInstance;
    expect(typeof svc.start).toBe("function");
    expect(typeof svc.stop).toBe("function");
    expect(svc.engine).toBeDefined();
  });

  it("registers the MCP server side-car with stdio transport and serve command", async () => {
    const { api } = await createCtx();
    expect(api.mcpServers).toHaveLength(1);
    const mcp = api.mcpServers[0];
    expect(mcp.name).toBe("workflow-engine");
    expect(mcp.transport).toBe("stdio");
    expect(mcp.command).toBe("npx");
    expect(mcp.args).toContain("serve");
  });
});

// ── Control tool tests ─────────────────────────────────────────────────────────

describe("openclaw-plugin — control tools", () => {
  it("workflow_list returns registered workflow with null instanceId before any start", async () => {
    const { api } = await createCtx();
    const result = (await api.callTool("workflow_list", {})) as Array<{
      workflowId: string;
      instanceId: string | null;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0].workflowId).toBe("plug-test");
    expect(result[0].instanceId).toBeNull();
  });

  it("workflow_start returns a new instance in the initial state", async () => {
    const { api } = await createCtx();
    const instance = (await api.callTool("workflow_start", {
      workflowId: "plug-test",
    })) as { instanceId: string; currentState: string };
    expect(instance.instanceId).toBeTruthy();
    expect(instance.currentState).toBe("step_a");
  });

  it("workflow_status reflects current state and available tools after start", async () => {
    const { api } = await createCtx();
    const instance = (await api.callTool("workflow_start", {
      workflowId: "plug-test",
    })) as { instanceId: string };
    const status = (await api.callTool("workflow_status", {
      instanceId: instance.instanceId,
    })) as { currentState: string; availableTools: Array<{ name: string }> };
    expect(status.currentState).toBe("step_a");
    expect(status.availableTools.map((t) => t.name)).toContain("do_a");
  });

  it("workflow_audit returns audit entries after tool execution", async () => {
    const { api, service } = await createCtx();
    const instance = service.engine.startWorkflow("plug-test");
    await service.engine.executeTool(instance.instanceId, "do_a", {
      value: "x",
    });
    const log = (await api.callTool("workflow_audit", {
      instanceId: instance.instanceId,
    })) as Array<{ eventType: string }>;
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.eventType === "tool_called")).toBe(true);
  });

  it("workflow_reset cancels the instance and returns a new instanceId", async () => {
    const { api, service } = await createCtx();
    const instance = service.engine.startWorkflow("plug-test");
    const result = (await api.callTool("workflow_reset", {
      instanceId: instance.instanceId,
    })) as {
      reset: boolean;
      cancelledInstanceId: string;
      newInstanceId: string;
    };
    expect(result.reset).toBe(true);
    expect(result.cancelledInstanceId).toBe(instance.instanceId);
    expect(result.newInstanceId).not.toBe(instance.instanceId);
  });
});

// ── beforePromptConstruct hook tests ──────────────────────────────────────────

describe("openclaw-plugin — beforePromptConstruct hook", () => {
  it("injects a short workout bootstrap hint when no workout instance exists", async () => {
    const { api } = await createCtx();
    const ctx: PromptConstructContext = { systemPrompt: "Base prompt." };
    const result = await api.callHook<PromptConstructContext>(
      "beforePromptConstruct",
      ctx,
    );
    expect(result.systemPrompt).toContain("## Workout Coaching");
    expect(result.systemPrompt).toContain("call get_next_workout");
  });

  it("injects state-specific prompt fragment for an active instance", async () => {
    const { api, service } = await createCtx();
    service.engine.startWorkflow("plug-test");
    const ctx: PromptConstructContext = { systemPrompt: "Base prompt." };
    const result = await api.callHook<PromptConstructContext>(
      "beforePromptConstruct",
      ctx,
    );
    expect(result.systemPrompt).toContain("Active Workflow: plug-test");
    expect(result.systemPrompt).toContain("Current state: step_a");
    expect(result.systemPrompt).toContain("You are in step A.");
  });

  it("injects the updated fragment after a state transition", async () => {
    const { api, service } = await createCtx();
    const instance = service.engine.startWorkflow("plug-test");
    await service.engine.executeTool(instance.instanceId, "do_a", {
      value: "hello",
    });
    const ctx: PromptConstructContext = { systemPrompt: "Base." };
    const result = await api.callHook<PromptConstructContext>(
      "beforePromptConstruct",
      ctx,
    );
    expect(result.systemPrompt).toContain("Current state: step_b");
    expect(result.systemPrompt).toContain("You are in step B.");
  });
});

describe("openclaw-plugin — direct workout tool proxy", () => {
  it("get_next_workout auto-starts workout-coach and transitions idle → showing_next_workout", async () => {
    const { api, service } = await createCtx();
    service.engine.registerWorkflow(workoutWorkflow);

    const result = (await api.callTool("get_next_workout", {})) as {
      success?: boolean;
      error?: boolean;
      message?: string;
      newState?: string;
    };

    expect(result.error).not.toBe(true);
    expect(result.success).toBe(true);
    expect(result.newState).toBe("showing_next_workout");

    const active = service.engine.getActiveWorkflow("workout-coach");
    expect(active).not.toBeNull();
    expect(active?.currentState).toBe("showing_next_workout");
  });

  it("start_workout_session fails cleanly when there is no active workout instance", async () => {
    const { api, service } = await createCtx();
    service.engine.registerWorkflow(workoutWorkflow);

    const result = (await api.callTool("start_workout_session", {
      template_id: "push-a",
      idempotency_key: "k1",
    })) as { error?: boolean; message?: string };

    expect(result.error).toBe(true);
    expect(result.message).toContain(
      "No active workflow instance for workout-coach",
    );
  });

  it("start_workout_session succeeds after bootstrap via get_next_workout", async () => {
    const { api, service } = await createCtx();
    service.engine.registerWorkflow(workoutWorkflow);

    await api.callTool("get_next_workout", {});
    const result = (await api.callTool("start_workout_session", {
      template_id: "push-a",
      idempotency_key: "k1",
    })) as { success?: boolean; error?: boolean; newState?: string };

    expect(result.error).not.toBe(true);
    expect(result.success).toBe(true);
    expect(result.newState).toBe("exercise_active");
  });
});

// ── beforeToolCall hook tests ──────────────────────────────────────────────────

describe("openclaw-plugin — beforeToolCall hook", () => {
  it("does not block a tool unrelated to any active workflow", async () => {
    const { api } = await createCtx();
    const result = await api.callHook<ToolGuardResult>("beforeToolCall", {
      name: "some_other_tool",
      input: {},
    } satisfies ToolCallContext);
    expect(result.blocked).toBe(false);
  });

  it("does not block a valid tool call with correct input", async () => {
    const { api, service } = await createCtx();
    service.engine.startWorkflow("plug-test");
    const result = await api.callHook<ToolGuardResult>("beforeToolCall", {
      name: "do_a",
      input: { value: "test" },
    } satisfies ToolCallContext);
    expect(result.blocked).toBe(false);
  });

  it("blocks a tool that is not available in the current state", async () => {
    const { api, service } = await createCtx();
    service.engine.startWorkflow("plug-test");
    // do_b belongs to step_b but we are in step_a
    const result = await api.callHook<ToolGuardResult>("beforeToolCall", {
      name: "do_b",
      input: {},
    } satisfies ToolCallContext);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/do_b/);
  });

  it("blocks a valid-state tool call with invalid Zod input", async () => {
    const { api, service } = await createCtx();
    service.engine.startWorkflow("plug-test");
    // do_a requires { value: string } — omitting it should fail schema
    const result = await api.callHook<ToolGuardResult>("beforeToolCall", {
      name: "do_a",
      input: {},
    } satisfies ToolCallContext);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/value/);
  });
});

// ── afterToolCall hook tests ───────────────────────────────────────────────────

describe("openclaw-plugin — afterToolCall hook", () => {
  it("returns the result unchanged when no workflow is active", async () => {
    const { api } = await createCtx();
    const result = await api.callHook<unknown>(
      "afterToolCall",
      { name: "some_other_tool", input: {} } satisfies ToolCallContext,
      { data: 42 },
    );
    expect(result).toEqual({ data: 42 });
  });

  it("fires the onSuccess transition so the state advances to step_b", async () => {
    const { api, service } = await createCtx();
    const instance = service.engine.startWorkflow("plug-test");
    expect(service.engine.getStatus(instance.instanceId).currentState).toBe(
      "step_a",
    );

    await api.callHook<unknown>(
      "afterToolCall",
      { name: "do_a", input: { value: "x" } } satisfies ToolCallContext,
      { ok: true },
    );

    expect(service.engine.getStatus(instance.instanceId).currentState).toBe(
      "step_b",
    );
  });

  it("available tools change after afterToolCall advances the state", async () => {
    const { api, service } = await createCtx();
    const instance = service.engine.startWorkflow("plug-test");

    const before = service.engine
      .getAvailableTools(instance.instanceId)
      .map((t) => t.name);
    expect(before).toContain("do_a");
    expect(before).not.toContain("do_b");

    await api.callHook<unknown>(
      "afterToolCall",
      { name: "do_a", input: { value: "x" } } satisfies ToolCallContext,
      {},
    );

    const after = service.engine
      .getAvailableTools(instance.instanceId)
      .map((t) => t.name);
    expect(after).not.toContain("do_a");
    expect(after).toContain("do_b");
  });
});

// ── afterToolCall — output validation ─────────────────────────────────────────

describe("openclaw-plugin — afterToolCall output validation", () => {
  it("blocks state transition when tool result fails output validator", async () => {
    // Define a workflow where do_a has an output validator requiring { ok: boolean }
    const wf: WorkflowDefinition = {
      id: "validated-wf",
      machine: createMachine({
        id: "validatedWf",
        initial: "step_a",
        states: {
          step_a: { on: { ADVANCE: "done" } },
          done: { type: "final" },
        },
      }),
      toolsByState: {
        step_a: [
          {
            name: "validated_tool",
            description: "Tool with output validator",
            inputSchema: z.object({ value: z.string() }),
            onSuccess: "ADVANCE",
          },
        ],
      },
      validationsByState: {
        step_a: {
          // output validator: result must have { ok: boolean }
          validated_tool: z.object({ ok: z.boolean() }),
        },
      },
    };

    const { api, service } = await createCtx();
    service.engine.registerWorkflow(wf);
    const instance = service.engine.startWorkflow("validated-wf");

    // Pass a result that fails the output validator (missing `ok`)
    await api.callHook<unknown>(
      "afterToolCall",
      {
        name: "validated_tool",
        input: { value: "x" },
      } satisfies ToolCallContext,
      { unexpected: true },
    );

    // State must NOT have advanced because output validation failed
    expect(service.engine.getStatus(instance.instanceId).currentState).toBe(
      "step_a",
    );
  });

  it("allows state transition when tool result passes output validator", async () => {
    const wf: WorkflowDefinition = {
      id: "validated-wf-2",
      machine: createMachine({
        id: "validatedWf2",
        initial: "step_a",
        states: {
          step_a: { on: { ADVANCE: "done" } },
          done: { type: "final" },
        },
      }),
      toolsByState: {
        step_a: [
          {
            name: "validated_tool_2",
            description: "Tool with output validator",
            inputSchema: z.object({ value: z.string() }),
            onSuccess: "ADVANCE",
          },
        ],
      },
      validationsByState: {
        step_a: {
          validated_tool_2: z.object({ ok: z.boolean() }),
        },
      },
    };

    const { api, service } = await createCtx();
    service.engine.registerWorkflow(wf);
    const instance = service.engine.startWorkflow("validated-wf-2");

    // Pass a valid result
    await api.callHook<unknown>(
      "afterToolCall",
      {
        name: "validated_tool_2",
        input: { value: "x" },
      } satisfies ToolCallContext,
      { ok: true },
    );

    expect(service.engine.getStatus(instance.instanceId).currentState).toBe(
      "done",
    );
  });
});

// ── afterToolCall — read-after-write ──────────────────────────────────────────

describe("openclaw-plugin — afterToolCall read-after-write", () => {
  it("returns the read result when requiresReadAfterWrite is set", async () => {
    const wf: WorkflowDefinition = {
      id: "raw-wf",
      machine: createMachine({
        id: "rawWf",
        initial: "active",
        states: {
          active: { on: { ADVANCE: "done" } },
          done: { type: "final" },
        },
      }),
      toolsByState: {
        active: [
          {
            name: "write_tool",
            description: "Write then read",
            inputSchema: z.object({}),
            // no onSuccess — stays in active, but auto-reads after write
            requiresReadAfterWrite: true,
            readTool: "read_tool",
          },
          {
            name: "read_tool",
            description: "Read current state",
            inputSchema: z.object({}),
            // no onSuccess — pure read
          },
        ],
      },
    };

    const { api, service } = await createCtx();
    service.engine.registerWorkflow(wf);
    service.engine.startWorkflow("raw-wf");

    const hookResult = await api.callHook<unknown>(
      "afterToolCall",
      { name: "write_tool", input: {} } satisfies ToolCallContext,
      { written: true },
    );

    // handleToolResult runs executeTool("read_tool", {}) after the write.
    // In Phase 1 executeTool returns parsedInput as the result, so read_tool
    // responds with {}.  The hook surfaces readResult instead of the original
    // { written: true }, confirming the read-after-write path was taken.
    expect(hookResult).toEqual({});
  });
});

// ── Service lifecycle ─────────────────────────────────────────────────────────

describe("openclaw-plugin — service lifecycle", () => {
  it("stop() closes the dashboard HTTP server and does not leave it listening", async () => {
    // Use port 0 so the OS assigns a free ephemeral port — avoids EADDRINUSE
    // in parallel test runs.
    const { api } = await createCtx({
      enableDashboard: true,
      dashboardPort: 0,
      silent: true,
    });
    const service = api.services.get(
      "workflow-engine",
    ) as WorkflowServiceInstance;
    await service.start();

    // Server must be listening after start()
    expect(service.dashboardServer).not.toBeNull();
    expect(service.dashboardServer!.listening).toBe(true);

    await service.stop();

    // After stop(), the HTTP server must no longer be listening
    expect(service.dashboardServer).toBeNull();
  });

  it("start() is idempotent — calling it twice does not leak the first dashboard server", async () => {
    const { api } = await createCtx({
      enableDashboard: true,
      dashboardPort: 0,
      silent: true,
    });
    const service = api.services.get(
      "workflow-engine",
    ) as WorkflowServiceInstance;

    await service.start();
    const firstServer = service.dashboardServer;
    expect(firstServer).not.toBeNull();
    expect(firstServer!.listening).toBe(true);

    // Second start() must close the first server before creating a new one
    await service.start();
    const secondServer = service.dashboardServer;

    // The old server must have been closed
    expect(firstServer!.listening).toBe(false);
    // A new server must be up
    expect(secondServer).not.toBeNull();
    expect(secondServer).not.toBe(firstServer);
    expect(secondServer!.listening).toBe(true);

    await service.stop();
  });
});
