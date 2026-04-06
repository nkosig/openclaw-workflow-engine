/**
 * Full MCP integration test — workout-coach workflow.
 *
 * Simulates a complete workout session through MCP tool calls,
 * verifies state progression, tool changes, and audit log.
 * Also tests kill-and-restart persistence.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { workoutCoachWorkflow } from "../examples/workout-coach";
import { WorkflowMCPServer } from "../src/mcp-server";

// ─── Helpers ───────────────────────────────────────────────────────────────

type TestCtx = {
  server: WorkflowMCPServer;
  client: Client;
  notifications: string[];
  cleanup: () => Promise<void>;
};

async function createTestCtx(dbPath?: string): Promise<TestCtx> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new WorkflowMCPServer({
    dbPath: dbPath ?? ":memory:",
    workflowsDir: null,
  });
  server.registerWorkflow(workoutCoachWorkflow);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const notifications: string[] = [];

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    notifications.push("tools/list_changed");
  });

  async function cleanup() {
    await server.close();
  }

  return { server, client, notifications, cleanup };
}

function parse(result: {
  content: Array<{ type: string; text?: string }>;
}): unknown {
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content");
  return JSON.parse(text);
}

function parseStatus(result: ReturnType<typeof parse>): {
  instanceId: string;
  currentState: string;
  isFinal: boolean;
  availableTools: Array<{ name: string }>;
} {
  return result as {
    instanceId: string;
    currentState: string;
    isFinal: boolean;
    availableTools: Array<{ name: string }>;
  };
}

// ─── Workout session tests ─────────────────────────────────────────────────

describe("MCP integration — workout-coach", () => {
  let ctx: TestCtx;
  let instanceId: string;

  beforeEach(async () => {
    ctx = await createTestCtx();
    ctx.notifications.length = 0; // clear after initial setup
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ── Step 1: Start workout-coach workflow ─────────────────────────────────

  it("step 1: workflow_start creates an instance in idle state", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    const instance = parse(result) as {
      instanceId: string;
      workflowId: string;
      currentState: string;
    };
    expect(instance.workflowId).toBe("workout-coach");
    expect(instance.currentState).toBe("idle");
    instanceId = instance.instanceId;

    // Dynamic tools for 'idle' state should be registered
    const { tools } = await ctx.client.listTools();
    const dynNames = tools
      .filter((t) => t.name.startsWith("workout-coach_"))
      .map((t) => t.name);
    expect(dynNames).toContain("workout-coach_get_next_workout");
  });

  // ── Step 2: get_next_workout ─────────────────────────────────────────────

  it("step 2: workout-coach_get_next_workout transitions idle → showing_next_workout", async () => {
    // Start workflow first
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;
    ctx.notifications.length = 0;

    const result = await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });
    const data = parse(result) as { success: boolean; newState: string };
    expect(data.success).toBe(true);
    expect(data.newState).toBe("showing_next_workout");

    // Check tool list changed
    expect(ctx.notifications.some((n) => n === "tools/list_changed")).toBe(
      true,
    );

    // Check tool list for new state
    const { tools } = await ctx.client.listTools();
    const dynNames = tools
      .filter((t) => t.name.startsWith("workout-coach_"))
      .map((t) => t.name);
    expect(dynNames).toContain("workout-coach_start_workout_session");
    expect(dynNames).not.toContain("workout-coach_begin_exercise"); // not available until workout_started
  });

  // ── Step 3: start_workout_session ────────────────────────────────────────

  it("step 3: start_workout_session transitions showing_next_workout → workout_started", async () => {
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;

    await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });

    const result = await ctx.client.callTool({
      name: "workout-coach_start_workout_session",
      arguments: {
        template_id: "template-001",
        idempotency_key: "session-start-001",
      },
    });
    const data = parse(result) as { success: boolean; newState: string };
    expect(data.success).toBe(true);
    expect(data.newState).toBe("workout_started");

    const { tools } = await ctx.client.listTools();
    const dynNames = tools
      .filter((t) => t.name.startsWith("workout-coach_"))
      .map((t) => t.name);
    expect(dynNames).toContain("workout-coach_begin_exercise");
  });

  // ── Step 4: log_set × 4 ────────────────────────────────────────────────

  it("step 4: log_set × 4 with unique idempotency keys", async () => {
    // Set up through workout_started
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;

    await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });
    await ctx.client.callTool({
      name: "workout-coach_start_workout_session",
      arguments: {
        template_id: "template-001",
        idempotency_key: "session-001",
      },
    });
    await ctx.client.callTool({
      name: "workout-coach_begin_exercise",
      arguments: {},
    });

    // Verify we're in exercise_active state
    const statusR = await ctx.client.callTool({
      name: "workflow_status",
      arguments: { instanceId },
    });
    const statusBefore = parseStatus(parse(statusR));
    expect(statusBefore.currentState).toBe("exercise_active");

    // Log 4 sets
    for (let i = 1; i <= 4; i++) {
      const r = await ctx.client.callTool({
        name: "workout-coach_log_set",
        arguments: {
          weight_kg: 60 + i * 2.5,
          reps: 8,
          rpe: 7,
          idempotency_key: `set-${i}`,
        },
      });
      const data = parse(r) as { success: boolean };
      expect(data.success).toBe(true);
    }

    // After logging sets, we should still be in exercise_active or set_logged
    const statusR2 = await ctx.client.callTool({
      name: "workflow_status",
      arguments: { instanceId },
    });
    const statusAfter = parseStatus(parse(statusR2));
    expect(["exercise_active", "set_logged"]).toContain(
      statusAfter.currentState,
    );
  });

  it("log_set with duplicate idempotency key returns idempotency hit", async () => {
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;

    await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });
    await ctx.client.callTool({
      name: "workout-coach_start_workout_session",
      arguments: {
        template_id: "template-001",
        idempotency_key: "session-001",
      },
    });
    await ctx.client.callTool({
      name: "workout-coach_begin_exercise",
      arguments: {},
    });

    const setArgs = {
      weight_kg: 60,
      reps: 8,
      rpe: 7,
      idempotency_key: "duplicate-set-1",
    };

    const first = await ctx.client.callTool({
      name: "workout-coach_log_set",
      arguments: setArgs,
    });
    const second = await ctx.client.callTool({
      name: "workout-coach_log_set",
      arguments: setArgs,
    });

    const firstData = parse(first) as {
      success: boolean;
      idempotencyHit?: boolean;
    };
    const secondData = parse(second) as {
      success: boolean;
      idempotencyHit?: boolean;
    };

    expect(firstData.success).toBe(true);
    expect(firstData.idempotencyHit).toBeFalsy();
    expect(secondData.success).toBe(true);
    expect(secondData.idempotencyHit).toBe(true);
  });

  it("log_set succeeds with and without optional rpe field", async () => {
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;

    await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });
    await ctx.client.callTool({
      name: "workout-coach_start_workout_session",
      arguments: { template_id: "t1", idempotency_key: "sk-rpe-test" },
    });
    await ctx.client.callTool({
      name: "workout-coach_begin_exercise",
      arguments: {},
    });

    // Without rpe (optional field omitted) — should succeed
    const withoutRpe = await ctx.client.callTool({
      name: "workout-coach_log_set",
      arguments: { weight_kg: 60, reps: 8, idempotency_key: "set-no-rpe" },
    });
    expect((parse(withoutRpe) as { success: boolean }).success).toBe(true);

    // With rpe explicitly provided — should also succeed
    const withRpe = await ctx.client.callTool({
      name: "workout-coach_log_set",
      arguments: {
        weight_kg: 65,
        reps: 6,
        rpe: 8,
        idempotency_key: "set-with-rpe",
      },
    });
    expect((parse(withRpe) as { success: boolean }).success).toBe(true);
  });

  // ── Step 5: finish_workout_session ───────────────────────────────────────

  it("step 5: finish_workout_session transitions to workout_completed (final)", async () => {
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;

    await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });
    await ctx.client.callTool({
      name: "workout-coach_start_workout_session",
      arguments: {
        template_id: "template-001",
        idempotency_key: "session-001",
      },
    });
    await ctx.client.callTool({
      name: "workout-coach_begin_exercise",
      arguments: {},
    });
    await ctx.client.callTool({
      name: "workout-coach_log_set",
      arguments: { weight_kg: 60, reps: 8, idempotency_key: "set-1" },
    });

    const result = await ctx.client.callTool({
      name: "workout-coach_finish_workout_session",
      arguments: {},
    });
    const data = parse(result) as { success: boolean; newState: string };
    expect(data.success).toBe(true);
    expect(data.newState).toBe("workout_completed");

    // Status should reflect final state
    const statusR = await ctx.client.callTool({
      name: "workflow_status",
      arguments: { instanceId },
    });
    const status = parseStatus(parse(statusR));
    expect(status.currentState).toBe("workout_completed");
    expect(status.isFinal).toBe(true);

    // No more dynamic workout tools
    const { tools } = await ctx.client.listTools();
    const dynTools = tools.filter((t) => t.name.startsWith("workout-coach_"));
    expect(dynTools).toHaveLength(0);
  });
});

describe("MCP integration — full session with audit log verification", () => {
  let ctx: TestCtx;
  let instanceId: string;

  beforeEach(async () => {
    ctx = await createTestCtx();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("audit log contains all expected event types after a full session", async () => {
    // Start
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;

    // Run through a session
    await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });
    await ctx.client.callTool({
      name: "workout-coach_start_workout_session",
      arguments: { template_id: "t1", idempotency_key: "sk1" },
    });
    await ctx.client.callTool({
      name: "workout-coach_begin_exercise",
      arguments: {},
    });
    await ctx.client.callTool({
      name: "workout-coach_log_set",
      arguments: { weight_kg: 50, reps: 10, idempotency_key: "lk1" },
    });
    await ctx.client.callTool({
      name: "workout-coach_finish_workout_session",
      arguments: {},
    });

    // Get audit log
    const auditR = await ctx.client.callTool({
      name: "workflow_audit",
      arguments: { instanceId },
    });
    const log = parse(auditR) as Array<{
      eventType: string;
      toolName: string | null;
    }>;

    const eventTypes = log.map((e) => e.eventType);

    expect(eventTypes).toContain("instance_created");
    expect(eventTypes).toContain("tool_called");
    expect(eventTypes).toContain("tool_succeeded");

    // Verify tool names are recorded
    const toolNames = log.map((e) => e.toolName).filter(Boolean);
    expect(toolNames).toContain("get_next_workout");
    expect(toolNames).toContain("log_set");
    expect(toolNames).toContain("finish_workout_session");
  });

  it("tools/list_changed fires at each state transition", async () => {
    const startR = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "workout-coach" },
    });
    instanceId = (parse(startR) as { instanceId: string }).instanceId;
    ctx.notifications.length = 0;

    await ctx.client.callTool({
      name: "workout-coach_get_next_workout",
      arguments: {},
    });
    const afterStep1 = ctx.notifications.filter(
      (n) => n === "tools/list_changed",
    ).length;

    await ctx.client.callTool({
      name: "workout-coach_start_workout_session",
      arguments: { template_id: "t1", idempotency_key: "sk-2" },
    });
    const afterStep2 = ctx.notifications.filter(
      (n) => n === "tools/list_changed",
    ).length;

    await ctx.client.callTool({
      name: "workout-coach_begin_exercise",
      arguments: {},
    });
    const afterStep3 = ctx.notifications.filter(
      (n) => n === "tools/list_changed",
    ).length;

    expect(afterStep1).toBeGreaterThanOrEqual(1);
    expect(afterStep2).toBeGreaterThan(afterStep1);
    expect(afterStep3).toBeGreaterThan(afterStep2);
  });
});

describe("MCP integration — kill and restart", () => {
  const dbPath = join(tmpdir(), `workflow-test-${Date.now()}.db`);

  afterAll(() => {
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      // Also remove WAL and SHM sidecar files if present
      for (const ext of ["-wal", "-shm"]) {
        const f = dbPath + ext;
        if (existsSync(f)) rmSync(f);
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it("workflow state is restored after server restart", async () => {
    // ── First server session ───────────────────────────────────────────────
    let instanceId: string;

    {
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const server1 = new WorkflowMCPServer({ dbPath, workflowsDir: null });
      server1.registerWorkflow(workoutCoachWorkflow);
      const client1 = new Client({ name: "test-client", version: "0.0.1" });
      await server1.connect(st);
      await client1.connect(ct);

      // Start workflow
      const startR = await client1.callTool({
        name: "workflow_start",
        arguments: { workflowId: "workout-coach" },
      });
      instanceId = (parse(startR) as { instanceId: string }).instanceId;

      // Advance to showing_next_workout
      await client1.callTool({
        name: "workout-coach_get_next_workout",
        arguments: {},
      });

      // Start the session to advance to workout_started
      await client1.callTool({
        name: "workout-coach_start_workout_session",
        arguments: { template_id: "tpl-1", idempotency_key: "sess-key-1" },
      });

      // Verify state before closing
      const statusR = await client1.callTool({
        name: "workflow_status",
        arguments: { instanceId },
      });
      const status1 = parseStatus(parse(statusR));
      expect(status1.currentState).toBe("workout_started");

      // "Kill" the server
      await server1.close();
    }

    // ── Second server session (restart from same DB) ───────────────────────
    {
      const [ct2, st2] = InMemoryTransport.createLinkedPair();
      const server2 = new WorkflowMCPServer({ dbPath, workflowsDir: null });
      server2.registerWorkflow(workoutCoachWorkflow); // restores active instance
      const client2 = new Client({ name: "test-client", version: "0.0.1" });
      await server2.connect(st2);
      await client2.connect(ct2);

      // Verify restored state
      const statusR = await client2.callTool({
        name: "workflow_status",
        arguments: { instanceId },
      });
      const restoredStatus = parseStatus(parse(statusR));
      expect(restoredStatus.currentState).toBe("workout_started");
      expect(restoredStatus.isFinal).toBe(false);

      // Dynamic tools should be restored for workout_started state
      const { tools } = await client2.listTools();
      const dynNames = tools
        .filter((t) => t.name.startsWith("workout-coach_"))
        .map((t) => t.name);
      expect(dynNames).toContain("workout-coach_begin_exercise");

      // Can continue the workflow after restart
      const beginR = await client2.callTool({
        name: "workout-coach_begin_exercise",
        arguments: {},
      });
      const beginData = parse(beginR) as { success: boolean; newState: string };
      expect(beginData.success).toBe(true);
      expect(beginData.newState).toBe("exercise_active");

      await server2.close();
    }
  });
});
