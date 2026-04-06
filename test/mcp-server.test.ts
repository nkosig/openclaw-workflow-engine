/**
 * MCP server protocol tests.
 * Uses InMemoryTransport to test the MCP server in-process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMachine } from "xstate";
import { z } from "zod";
import { WorkflowMCPServer } from "../src/mcp-server";
import type { WorkflowDefinition } from "../src/types";

// ─── Test fixture ──────────────────────────────────────────────────────────

/**
 * A simple three-state pipeline workflow used throughout these tests.
 * init → fetching → processing → complete (final)
 */
function makePipelineWorkflow(): WorkflowDefinition {
  return {
    id: "pipeline",
    machine: createMachine({
      id: "pipelineM",
      initial: "init",
      states: {
        init: { on: { FETCH: "fetching" } },
        fetching: { on: { PROCESS: "processing" } },
        processing: { on: { DONE: "complete" } },
        complete: { type: "final" },
      },
    }),
    toolsByState: {
      init: [
        {
          name: "fetch_data",
          description: "Kick off a data fetch",
          inputSchema: z.object({ url: z.string() }),
          onSuccess: "FETCH",
        },
      ],
      fetching: [
        {
          name: "process_data",
          description: "Process the fetched data",
          inputSchema: z.object({ format: z.string() }),
          onSuccess: "PROCESS",
        },
        {
          name: "read_status",
          description: "Read current fetch status",
          inputSchema: z.object({}),
        },
      ],
      processing: [
        {
          name: "complete_task",
          description: "Mark task as completed",
          inputSchema: z.object({}),
          onSuccess: "DONE",
        },
      ],
      complete: [],
    },
    promptsByState: {
      init: "Call fetch_data to start the pipeline.",
      fetching: "Data is being fetched. Check status or process when ready.",
      processing: "Data is processing. Call complete_task when done.",
      complete: "Pipeline complete.",
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type TestCtx = {
  server: WorkflowMCPServer;
  client: Client;
  notifications: string[];
  cleanup: () => Promise<void>;
};

async function createTestCtx(): Promise<TestCtx> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new WorkflowMCPServer({
    dbPath: ":memory:",
    workflowsDir: null,
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });

  const notifications: string[] = [];

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Track tools/list_changed notifications
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    notifications.push("tools/list_changed");
  });

  async function cleanup() {
    await server.close();
  }

  return { server, client, notifications, cleanup };
}

/** Parse the text content from a callTool result */
function parseToolResult(result: {
  content: Array<{ type: string; text?: string }>;
}): unknown {
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text);
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe("MCP server — control tools", () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = await createTestCtx();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("exposes exactly 5 control tools before any workflow is registered", async () => {
    const { tools } = await ctx.client.listTools();
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "workflow_audit",
      "workflow_list",
      "workflow_reset",
      "workflow_start",
      "workflow_status",
    ]);
  });

  it("workflow_list returns an empty array before any workflow is registered", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_list",
      arguments: {},
    });
    const data = parseToolResult(result) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it("workflow_list includes registered workflows with null instanceId and status before any instance is started", async () => {
    ctx.server.registerWorkflow(makePipelineWorkflow());
    const result = await ctx.client.callTool({
      name: "workflow_list",
      arguments: {},
    });
    const data = parseToolResult(result) as Array<{ workflowId: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].workflowId).toBe("pipeline");
    expect(data[0].instanceId).toBeNull();
    expect(data[0].status).toBeNull();
  });

  it("workflow_list returns full status object for an active instance", async () => {
    ctx.server.registerWorkflow(makePipelineWorkflow());
    await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });

    const result = await ctx.client.callTool({
      name: "workflow_list",
      arguments: {},
    });
    const data = parseToolResult(result) as Array<{
      workflowId: string;
      instanceId: string | null;
      status: {
        currentState: string;
        isFinal: boolean;
        availableTools: string[];
      } | null;
    }>;

    expect(data).toHaveLength(1);
    expect(data[0].instanceId).toBeTruthy();
    expect(data[0].status).not.toBeNull();
    expect(data[0].status!.currentState).toBe("init");
    expect(data[0].status!.isFinal).toBe(false);
    expect(data[0].status!.availableTools).toContain("fetch_data");
  });
});

describe("MCP server — workflow_start and dynamic tools", () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = await createTestCtx();
    ctx.server.registerWorkflow(makePipelineWorkflow());
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("workflow_start returns a WorkflowInstance", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });
    const instance = parseToolResult(result) as {
      instanceId: string;
      workflowId: string;
      currentState: string;
    };
    expect(instance.workflowId).toBe("pipeline");
    expect(instance.instanceId).toBeTruthy();
    expect(instance.currentState).toBe("init");
  });

  it("registers dynamic tools for the initial state after workflow_start", async () => {
    await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });

    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name);

    // 5 control tools + 1 dynamic tool for 'init' state
    expect(names).toContain("pipeline_fetch_data");
    expect(names).not.toContain("pipeline_process_data");
    expect(names).not.toContain("pipeline_complete_task");
    expect(tools.length).toBe(6);
  });

  it("tools/list_changed is emitted when workflow_start adds dynamic tools", async () => {
    const before = ctx.notifications.length;
    await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });
    expect(ctx.notifications.length).toBeGreaterThan(before);
    expect(ctx.notifications.some((n) => n === "tools/list_changed")).toBe(
      true,
    );
  });
});

describe("MCP server — dynamic tool execution", () => {
  let ctx: TestCtx;
  let instanceId: string;

  beforeEach(async () => {
    ctx = await createTestCtx();
    ctx.server.registerWorkflow(makePipelineWorkflow());
    const result = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });
    const instance = parseToolResult(result) as { instanceId: string };
    instanceId = instance.instanceId;
    // reset notification counter after setup
    ctx.notifications.length = 0;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("calling a dynamic tool succeeds and returns engine result", async () => {
    const result = await ctx.client.callTool({
      name: "pipeline_fetch_data",
      arguments: { url: "https://example.com/data" },
    });
    const data = parseToolResult(result) as {
      success: boolean;
      newState: string;
    };
    expect(data.success).toBe(true);
    expect(data.newState).toBe("fetching");
  });

  it("state transitions update the tool list — old tools removed, new tools added", async () => {
    // Execute fetch_data: init → fetching
    await ctx.client.callTool({
      name: "pipeline_fetch_data",
      arguments: { url: "https://example.com" },
    });

    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("pipeline_fetch_data"); // init tool gone
    expect(names).toContain("pipeline_process_data"); // fetching tool present
    expect(names).toContain("pipeline_read_status"); // fetching read tool present
  });

  it("state transitions emit tools/list_changed notification", async () => {
    await ctx.client.callTool({
      name: "pipeline_fetch_data",
      arguments: { url: "https://example.com" },
    });
    expect(
      ctx.notifications.filter((n) => n === "tools/list_changed").length,
    ).toBeGreaterThan(0);
  });

  it("calling a tool not available in current state returns MCP error (does not crash)", async () => {
    // In 'init' state, pipeline_process_data is NOT registered. The MCP SDK
    // returns an error result (isError: true) rather than throwing.
    const result = await ctx.client.callTool({
      name: "pipeline_process_data",
      arguments: { format: "json" },
    });
    // The SDK surfaces the unknown-tool error as an error content result
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("pipeline_process_data");

    // Server must still be operational after the error
    const { tools } = await ctx.client.listTools();
    expect(tools.some((t) => t.name === "pipeline_fetch_data")).toBe(true);
  });

  it("calling a dynamic tool with wrong input returns error content", async () => {
    // 'url' is required but missing — McpServer validates against Zod schema and
    // surfaces the validation failure as an error result (isError: true)
    const result = await ctx.client.callTool({
      name: "pipeline_fetch_data",
      arguments: {},
    });
    // Either isError is set or the content has an error message — either way no crash
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    const isErrorResponse =
      result.isError === true || text.toLowerCase().includes("error");
    expect(isErrorResponse).toBe(true);

    // Server must still be alive
    const { tools } = await ctx.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });
});

describe("MCP server — workflow_status", () => {
  let ctx: TestCtx;
  let instanceId: string;

  beforeEach(async () => {
    ctx = await createTestCtx();
    ctx.server.registerWorkflow(makePipelineWorkflow());
    const result = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });
    instanceId = (parseToolResult(result) as { instanceId: string }).instanceId;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns correct current state", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_status",
      arguments: { instanceId },
    });
    const status = parseToolResult(result) as {
      currentState: string;
      isFinal: boolean;
      availableTools: Array<{ name: string }>;
    };
    expect(status.currentState).toBe("init");
    expect(status.isFinal).toBe(false);
    expect(status.availableTools.map((t) => t.name)).toContain("fetch_data");
  });

  it("reflects updated state after a tool call", async () => {
    await ctx.client.callTool({
      name: "pipeline_fetch_data",
      arguments: { url: "https://example.com" },
    });

    const result = await ctx.client.callTool({
      name: "workflow_status",
      arguments: { instanceId },
    });
    const status = parseToolResult(result) as { currentState: string };
    expect(status.currentState).toBe("fetching");
  });

  it("returns error content for unknown instanceId", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_status",
      arguments: { instanceId: "does-not-exist" },
    });
    const data = parseToolResult(result) as { error: string };
    expect(data.error).toBeTruthy();
    expect(result.isError).toBe(true);
  });
});

describe("MCP server — workflow_audit", () => {
  let ctx: TestCtx;
  let instanceId: string;

  beforeEach(async () => {
    ctx = await createTestCtx();
    ctx.server.registerWorkflow(makePipelineWorkflow());
    const result = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });
    instanceId = (parseToolResult(result) as { instanceId: string }).instanceId;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns audit log entries after workflow is started", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_audit",
      arguments: { instanceId },
    });
    const log = parseToolResult(result) as Array<{ eventType: string }>;
    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.eventType === "instance_created")).toBe(true);
  });

  it("includes tool_called and tool_succeeded entries after a tool call", async () => {
    await ctx.client.callTool({
      name: "pipeline_fetch_data",
      arguments: { url: "https://example.com" },
    });

    const result = await ctx.client.callTool({
      name: "workflow_audit",
      arguments: { instanceId },
    });
    const log = parseToolResult(result) as Array<{ eventType: string }>;
    expect(log.some((e) => e.eventType === "tool_called")).toBe(true);
    expect(log.some((e) => e.eventType === "tool_succeeded")).toBe(true);
  });

  it("respects the limit parameter", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_audit",
      arguments: { instanceId, limit: 1 },
    });
    const log = parseToolResult(result) as unknown[];
    expect(log).toHaveLength(1);
  });

  it("returns error content for unknown instanceId", async () => {
    const result = await ctx.client.callTool({
      name: "workflow_audit",
      arguments: { instanceId: "nope" },
    });
    const data = parseToolResult(result) as { error: string };
    expect(data.error).toBeTruthy();
    expect(result.isError).toBe(true);
  });
});

describe("MCP server — workflow_reset", () => {
  let ctx: TestCtx;
  let instanceId: string;

  beforeEach(async () => {
    ctx = await createTestCtx();
    ctx.server.registerWorkflow(makePipelineWorkflow());
    const result = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });
    instanceId = (parseToolResult(result) as { instanceId: string }).instanceId;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("cancels the instance and immediately starts a fresh one", async () => {
    // Verify dynamic tools exist for the original instance
    const before = await ctx.client.listTools();
    expect(before.tools.some((t) => t.name === "pipeline_fetch_data")).toBe(
      true,
    );

    // Reset (cancel + restart)
    const result = await ctx.client.callTool({
      name: "workflow_reset",
      arguments: { instanceId },
    });
    const data = parseToolResult(result) as {
      reset: boolean;
      cancelledInstanceId: string;
      newInstanceId: string;
    };
    expect(data.reset).toBe(true);
    expect(data.cancelledInstanceId).toBe(instanceId);
    expect(typeof data.newInstanceId).toBe("string");
    expect(data.newInstanceId).not.toBe(instanceId);

    // Dynamic tools should be present for the new instance's initial state
    const after = await ctx.client.listTools();
    expect(after.tools.some((t) => t.name === "pipeline_fetch_data")).toBe(
      true,
    );
  });
});

describe("MCP server — resources", () => {
  let ctx: TestCtx;
  let instanceId: string;

  beforeEach(async () => {
    ctx = await createTestCtx();
    ctx.server.registerWorkflow(makePipelineWorkflow());
    const result = await ctx.client.callTool({
      name: "workflow_start",
      arguments: { workflowId: "pipeline" },
    });
    instanceId = (parseToolResult(result) as { instanceId: string }).instanceId;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("reads workflow state resource", async () => {
    const result = await ctx.client.readResource({
      uri: `workflow://${instanceId}/state`,
    });
    expect(result.contents).toHaveLength(1);
    const data = JSON.parse(result.contents[0].text as string) as {
      state: string;
      context: unknown;
    };
    expect(data.state).toBe("init");
  });

  it("reads workflow prompt resource", async () => {
    const result = await ctx.client.readResource({
      uri: `workflow://${instanceId}/prompt`,
    });
    const data = JSON.parse(result.contents[0].text as string) as {
      state: string;
      prompt: string;
    };
    expect(data.state).toBe("init");
    expect(data.prompt).toContain("fetch_data");
  });

  it("reads workflow progress resource", async () => {
    const result = await ctx.client.readResource({
      uri: `workflow://${instanceId}/progress`,
    });
    const data = JSON.parse(result.contents[0].text as string) as {
      currentState: string;
      percentage: number;
    };
    expect(data.currentState).toBe("init");
    expect(typeof data.percentage).toBe("number");
  });
});
